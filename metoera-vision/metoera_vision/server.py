"""Stdlib HTTP API (ThreadingHTTPServer). Binds to localhost by default."""

from __future__ import annotations

import json
import logging
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from .detect import find_best
from .service import UnknownDrone, VisionService

log = logging.getLogger("metoera.vision.http")

BOUNDARY = "metoeraframe"

INDEX_HTML = """<!doctype html><html><head><meta charset="utf-8"><title>metoera-vision</title>
<style>body{font-family:system-ui;background:#111;color:#eee;margin:16px}img{max-width:100%;border:1px solid #333}
pre{background:#1b1b1b;padding:8px;max-height:40vh;overflow:auto}</style></head><body>
<h3>metoera-vision</h3><img src="/stream" alt="annotated stream"><pre id="d"></pre>
<script>setInterval(async()=>{try{const r=await fetch('/detections');document.getElementById('d').textContent=
JSON.stringify(await r.json(),null,1)}catch(e){}},500)</script></body></html>"""

MULTI_INDEX_HTML = """<!doctype html><html><head><meta charset="utf-8"><title>metoera-vision</title>
<style>body{font-family:system-ui;background:#111;color:#eee;margin:16px}.g{display:flex;flex-wrap:wrap;gap:16px}
.g>div{flex:1 1 420px;min-width:0}img{max-width:100%;border:1px solid #333}
pre{background:#1b1b1b;padding:8px;max-height:30vh;overflow:auto}</style></head><body>
<h3>metoera-vision</h3><div class="g" id="g"></div>
<script>const ids=__IDS__;const g=document.getElementById('g');
for(const id of ids){const d=document.createElement('div');d.innerHTML=`<h4>${id}</h4>
<img src="/stream?drone=${encodeURIComponent(id)}" alt="${id} stream"><pre id="d-${id}"></pre>`;g.appendChild(d)}
setInterval(async()=>{for(const id of ids){try{const r=await fetch('/detections?drone='+encodeURIComponent(id));
document.getElementById('d-'+id).textContent=JSON.stringify(await r.json(),null,1)}catch(e){}}},500)</script>
</body></html>"""


def make_handler(service: VisionService, allowed_origins: list[str], stream_fps: float = 15.0):
    allowed = [o.strip() for o in allowed_origins if o.strip()]

    class Handler(BaseHTTPRequestHandler):
        server_version = "metoera-vision/0.1"
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):  # quiet default access log
            log.debug("%s - %s", self.address_string(), fmt % args)

        # ---- helpers ----
        def _cors(self) -> None:
            origin = self.headers.get("Origin")
            if "*" in allowed:
                self.send_header("Access-Control-Allow-Origin", "*")
            elif origin and origin in allowed:
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")
            elif allowed:
                self.send_header("Access-Control-Allow-Origin", allowed[0])
                self.send_header("Vary", "Origin")

        def _send(self, code: int, body: bytes, ctype: str, extra: dict | None = None) -> None:
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self._cors()
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def _json(self, obj, code: int = 200) -> None:
            self._send(code, json.dumps(obj).encode(), "application/json")

        # ---- verbs ----
        def do_OPTIONS(self):
            self.send_response(204)
            self._cors()
            self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Max-Age", "600")
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_HEAD(self):
            self.do_GET()

        def do_GET(self):
            u = urlparse(self.path)
            q = parse_qs(u.query)
            route = u.path.rstrip("/") or "/"
            drone = (q.get("drone") or [""])[0].strip() or None
            try:
                if drone is not None:
                    try:
                        service.channel(drone)
                    except UnknownDrone:
                        self._json({"error": "unknown drone", "drone": drone, "drones": service.drone_ids}, 404)
                        return
                if route == "/":
                    if service.multi:
                        page = MULTI_INDEX_HTML.replace("__IDS__", json.dumps(service.drone_ids))
                    else:
                        page = INDEX_HTML
                    self._send(200, page.encode(), "text/html; charset=utf-8")
                elif route == "/health":
                    self._json(service.health(drone))
                elif route == "/detections":
                    res = service.latest_result(drone)
                    if res is None:
                        out = {"timestamp": None, "frame_size": None, "objects": [], "status": "no detections yet"}
                        if service.multi:
                            out["drone"] = service.channel(drone).id
                        self._json(out)
                    else:
                        out = dict(res)
                        out["age_ms"] = round((time.time() - res["timestamp"]) * 1000)
                        self._json(out)
                elif route == "/find":
                    label = (q.get("label") or [""])[0]
                    if not label:
                        self._json({"error": "missing ?label="}, 400)
                        return
                    try:
                        min_conf = float((q.get("min_conf") or ["0"])[0])
                    except ValueError:
                        min_conf = 0.0
                    res = service.latest_result(drone)
                    match = find_best(res, label, min_conf)
                    out = {
                        "label": label,
                        "match": match,
                        "timestamp": res["timestamp"] if res else None,
                        "age_ms": round((time.time() - res["timestamp"]) * 1000) if res else None,
                    }
                    if service.multi:
                        out["drone"] = service.channel(drone).id
                    self._json(out)
                elif route == "/frame.jpg":
                    jpg = service.annotated_jpeg(drone)
                    if jpg is None:
                        self._json({"error": "no frame yet"}, 503)
                    else:
                        self._send(200, jpg, "image/jpeg")
                elif route == "/stream":
                    self._stream(drone)
                else:
                    self._json({"error": "not found",
                                "endpoints": ["/health", "/detections", "/find?label=", "/frame.jpg", "/stream"]}, 404)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def _stream(self, drone: str | None = None) -> None:
            self.send_response(200)
            self.send_header("Content-Type", f"multipart/x-mixed-replace; boundary={BOUNDARY}")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self._cors()
            self.end_headers()
            self.close_connection = True
            period = 1.0 / stream_fps
            last = None
            while True:
                t0 = time.monotonic()
                jpg = service.annotated_jpeg(drone)
                if jpg is not None and jpg is not last:
                    self.wfile.write(
                        f"--{BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: {len(jpg)}\r\n\r\n".encode()
                        + jpg + b"\r\n")
                    self.wfile.flush()
                    last = jpg
                dt = period - (time.monotonic() - t0)
                if dt > 0:
                    time.sleep(dt)

    return Handler


def make_server(service: VisionService, host: str, port: int, allowed_origins: list[str],
                stream_fps: float = 15.0) -> ThreadingHTTPServer:
    srv = ThreadingHTTPServer((host, port), make_handler(service, allowed_origins, stream_fps))
    srv.daemon_threads = True
    return srv

"""CLI entry point: python -m metoera_vision [--source ...]"""

from __future__ import annotations

import argparse
import logging
import os
import signal
import sys
import threading

from . import __version__


def env(name: str, default: str) -> str:
    return os.environ.get(name, default)


def parse_args(argv=None) -> argparse.Namespace:
    p = argparse.ArgumentParser(prog="metoera-vision", description="YOLO object detection for the Tello EDU video stream.")
    p.add_argument("--source", default=env("METOERA_VISION_SOURCE", "udp://0.0.0.0:11111"),
                   help="udp://HOST:PORT (Tello, default) | path to video/image file | webcam:N or N")
    p.add_argument("--host", default=env("METOERA_VISION_HOST", "127.0.0.1"), help="HTTP bind host")
    p.add_argument("--port", type=int, default=int(env("METOERA_VISION_PORT", "18790")), help="HTTP port")
    p.add_argument("--model", default=env("METOERA_VISION_MODEL", "yolo11n.pt"), help="Ultralytics weights")
    p.add_argument("--device", default=env("METOERA_VISION_DEVICE", "auto"), help="auto | mps | cpu | cuda:0")
    p.add_argument("--detect-fps", type=float, default=float(env("METOERA_VISION_DETECT_FPS", "5")))
    p.add_argument("--stream-fps", type=float, default=float(env("METOERA_VISION_STREAM_FPS", "15")),
                   help="max MJPEG frame rate for /stream")
    p.add_argument("--conf", type=float, default=float(env("METOERA_VISION_CONF", "0.35")), help="min confidence")
    p.add_argument("--imgsz", type=int, default=int(env("METOERA_VISION_IMGSZ", "640")))
    p.add_argument("--classes", default=env("METOERA_VISION_CLASSES", ""),
                   help="comma-separated COCO labels to keep (empty = all)")
    p.add_argument("--cors-origin", default=env("METOERA_VISION_CORS", "http://localhost:18787,http://127.0.0.1:18787"),
                   help="comma-separated allowed origins ('*' for any)")
    p.add_argument("--no-loop", action="store_true", help="play a file source once instead of looping")
    p.add_argument("--log-level", default=env("METOERA_VISION_LOG", "INFO"))
    p.add_argument("--version", action="version", version=__version__)
    return p.parse_args(argv)


def main(argv=None) -> int:
    a = parse_args(argv)
    logging.basicConfig(level=a.log_level.upper(), format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    log = logging.getLogger("metoera.vision")

    from .detect import YoloDetector
    from .frames import LatestFrame
    from .server import make_server
    from .service import VisionService
    from .sources import make_source

    classes = [c for c in a.classes.split(",") if c.strip()] or None
    log.info("loading model %s (device=%s)...", a.model, a.device)
    detector = YoloDetector(a.model, device=a.device, conf=a.conf, imgsz=a.imgsz, classes=classes)

    frames = LatestFrame()
    source = make_source(a.source, frames, loop=not a.no_loop)
    service = VisionService(source, detector, frames, detect_fps=a.detect_fps)
    server = make_server(service, a.host, a.port, a.cors_origin.split(","), a.stream_fps)

    service.start()
    log.info("source: %s", source.description)
    log.info("API on http://%s:%d  (/health /detections /find?label= /frame.jpg /stream)", a.host, a.port)

    stop = threading.Event()

    def _sig(*_):
        stop.set()
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGINT, _sig)
    signal.signal(signal.SIGTERM, _sig)
    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        service.stop()
        server.server_close()
        log.info("stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())

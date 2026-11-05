"""Simulated red-zone phones: fixed cameras in the venue that talk to metoera-redzone as the
phone page (metoera-redzone/public/app.js) does.

Every phone placed on the voice page's Room panel (.room.json `cameras`: x, y, heading, z, tilt)
is one, in its slot (1-3). It joins its slot on the red-zone service (REDZONE_URL in sim.env),
and then like the real page:
- every 280 ms, while watching, it looks (renders its view, 640x360 landscape, the lens's field
  of view as metoera-voice assumes: wide 100, normal 68, tele 32 degrees) and runs YOLO for people,
  keeping boxes the page would keep (score from the sensitivity: 0.85 - sens/100 x 0.4, not tiny,
  upright);
- at most twice a second it posts those boxes (`people`): the voice server puts them on the plan
  and raises a zone event when someone enters a red zone drawn there;
- with a red zone drawn on the phone's picture (ROI, from the console or the Phones panel), a
  person in it for about 1 s posts an `intrusion` (which, armed, starts Masoud's pad mission);
- a heartbeat every 1.5 s, which brings the commands from the console (watch, arm, lens,
  sensitivity, ROI);
- a small JPEG preview 4 times a second (the Phones panel and the console show it).

Unlike a real phone, a simulated one starts watching at once (`--phones-idle` waits for the
console), and YOLO stands in for the phone's COCO-SSD.

They run on their own thread so a slow HTTP call never holds up the drones.
"""

from __future__ import annotations

import base64
import json
import math
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Callable, Optional

import numpy as np

from .camera import Intrinsics, Pose

LENS_FOV = {"wide": 100.0, "normal": 68.0, "tele": 32.0}  # metoera-voice src/room.ts
WIDTH, HEIGHT = 640, 360
DETECT_EVERY_S = 0.28
DWELL_NEED_S = 1.0
DWELL_DECAY = 420 / 280  # the page takes 420 ms of dwell off per 280 ms tick without a person
PEOPLE_EVERY_S = 0.5
HEARTBEAT_S = 1.5
PREVIEW_S = 0.25
ALERT_GAP_S = 2.5
MIN_AREA, MIN_SIDE = 0.035, 0.07
DEFAULT_SENSITIVITY = 35


def intrinsics(lens: str) -> Intrinsics:
    f = WIDTH / 2 / math.tan(math.radians(LENS_FOV.get(lens, LENS_FOV["normal"])) / 2)
    return Intrinsics(WIDTH, HEIGHT, f, f, WIDTH / 2, HEIGHT / 2)


def camera_pose(cam: dict) -> Pose:
    return Pose(float(cam["x"]), float(cam["y"]), float(cam.get("z", 1.5)), float(cam["heading"]), -float(cam.get("tilt", 0.0)))


def placed(cam: dict) -> bool:
    return all(isinstance(cam.get(k), (int, float)) for k in ("x", "y", "heading"))


def overlap(a: dict, b: dict) -> bool:
    return a["x"] < b["x"] + b["w"] and b["x"] < a["x"] + a["w"] and a["y"] < b["y"] + b["h"] and b["y"] < a["y"] + a["h"]


def plausible(box: dict, threshold: float) -> bool:
    """The page's isPlausiblePerson: confident enough, not tiny, upright."""
    if box["score"] < threshold or box["w"] * box["h"] < MIN_AREA or min(box["w"], box["h"]) < MIN_SIDE:
        return False
    aspect = box["w"] * WIDTH / max(box["h"] * HEIGHT, 1)
    return 0.22 <= aspect <= 2.4


@dataclass
class Phone:
    slot: str
    cam: dict
    watching: bool = True
    armed: bool = False
    lens: str = "normal"
    sensitivity: int = DEFAULT_SENSITIVITY
    roi: Optional[dict] = None
    token: Optional[str] = None
    dwell: float = 0.0
    boxes: list = field(default_factory=list)
    image: Optional[np.ndarray] = None
    error: Optional[str] = None
    _next: dict = field(default_factory=dict)
    _last_alert: float = -1e9

    @property
    def threshold(self) -> float:
        return 0.85 - self.sensitivity / 100 * 0.4

    def due(self, what: str, now: float, every: float) -> bool:
        if now < self._next.get(what, 0.0):
            return False
        self._next[what] = now + every
        return True

    def command(self, cmd: dict) -> None:
        kind = cmd.get("type")
        if kind == "watch":
            self.watching = bool(cmd.get("watching"))
            self.dwell = 0.0
        elif kind == "arm":
            self.armed = bool(cmd.get("armed"))
        elif kind == "lens" and cmd.get("lens") in LENS_FOV:
            self.lens = cmd["lens"]
        elif kind == "sensitivity" and isinstance(cmd.get("sensitivity"), (int, float)):
            self.sensitivity = max(0, min(100, round(cmd["sensitivity"])))
        elif kind == "roi" and isinstance(cmd.get("roi"), dict):
            self.roi = cmd["roi"]
        elif kind == "clearRoi":
            self.roi = None

    def dwell_step(self, dt: float) -> Optional[float]:
        """The page's dwell: grows while a person is in the ROI, decays otherwise. Returns the
        best score in the ROI when an intrusion is due."""
        if not (self.watching and self.roi):
            self.dwell = 0.0
            return None
        inside = [b for b in self.boxes if overlap(b, self.roi)]
        if inside:
            self.dwell = min(DWELL_NEED_S + 0.25, self.dwell + dt)
        else:
            self.dwell = max(0.0, self.dwell - DWELL_DECAY * dt)
        if inside and self.dwell >= DWELL_NEED_S:
            self.dwell = 0.0
            return max(b["score"] for b in inside)
        return None


class Phones:
    """All the simulated phones, on their own thread."""

    def __init__(self, base_url: str, render: Callable[[Pose, Intrinsics], np.ndarray], detect, watching: bool = True,
                 log: Callable[[str], None] = print) -> None:
        self.base = base_url.rstrip("/")
        self.render = render  # (camera pose, intrinsics) -> RGB image; safe to call from this thread
        self.detect = detect  # RGB image -> [(x, y, w, h normalized, score)] for people
        self.watching = watching
        self.log = log
        self.phones: dict[str, Phone] = {}
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._offline_since: Optional[float] = None

    # ---- placement (from the Room panel)
    def place(self, cameras: dict) -> None:
        """Phones where the Room panel put them; a phone taken off the plan leaves its slot."""
        with self._lock:
            for slot, cam in (cameras or {}).items():
                if slot not in ("1", "2", "3") or not placed(cam):
                    continue
                if slot in self.phones:
                    self.phones[slot].cam = cam
                else:
                    self.phones[slot] = Phone(slot, cam, watching=self.watching)
                    self.log(f"phone {slot} at ({cam['x']:+.2f}, {cam['y']:+.2f}), {cam.get('z', 1.5):.1f} m up, facing {cam['heading']:.0f} deg")
            for slot in [s for s in self.phones if s not in (cameras or {}) or not placed(cameras[s])]:
                phone = self.phones.pop(slot)
                if phone.token:
                    self._post(phone, "leave", {})

    # ---- HTTP, as the page does it
    def _call(self, path: str, body: dict, token: Optional[str] = None, timeout: float = 2.0) -> Optional[dict]:
        data = json.dumps(body).encode()
        headers = {"Content-Type": "application/json"}
        if token:
            headers["X-Slot-Token"] = token
        req = urllib.request.Request(self.base + path, data=data, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                self._online()
                return json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            self._online()
            return {"ok": False, "status": e.code}
        except (urllib.error.URLError, OSError, ValueError):
            if self._offline_since is None:
                self._offline_since = time.monotonic()
                self.log(f"red-zone service not reachable at {self.base} (start it with sim.env); retrying")
            return None

    def _online(self) -> None:
        if self._offline_since is not None:
            self.log(f"red-zone service reachable at {self.base}")
            self._offline_since = None

    def _post(self, phone: Phone, action: str, body: dict) -> Optional[dict]:
        if not phone.token:
            return None
        reply = self._call(f"/api/slots/{phone.slot}/{action}", {"token": phone.token, **body}, phone.token)
        if reply and reply.get("status") == 401:
            phone.token = None  # the service restarted: join again
        return reply

    def _join(self, phone: Phone) -> None:
        reply = self._call(f"/api/slots/{phone.slot}/join", {"name": f"Sim phone {phone.slot}"})
        if reply and reply.get("token"):
            phone.token = reply["token"]
            phone.armed = False  # joining resets ARM, as on the service
            self.log(f"phone {phone.slot} joined its slot" + (" and watches" if phone.watching else " (idle until the console says watch)"))

    # ---- one tick
    def tick(self, now: float) -> None:
        with self._lock:
            phones = list(self.phones.values())
        for phone in phones:
            if not phone.token:
                if phone.due("join", now, 3.0):
                    self._join(phone)
                continue
            if phone.watching and phone.due("detect", now, DETECT_EVERY_S):
                self._look(phone, now)
            if phone.watching and phone.due("people", now, PEOPLE_EVERY_S):
                self._post(phone, "people", {"boxes": phone.boxes[:12]})
            if phone.due("heartbeat", now, HEARTBEAT_S):
                reply = self._post(phone, "heartbeat", {
                    "watching": phone.watching, "armed": phone.armed, "lens": phone.lens, "sensitivity": phone.sensitivity,
                    "dwellMs": round(phone.dwell * 1000), "lensesAvailable": {"wide": True, "normal": True, "tele": True},
                    "roi": phone.roi, "personScore": phone.boxes[0]["score"] if phone.boxes else None, "error": phone.error})
                for cmd in (reply or {}).get("commands", []) or []:
                    phone.command(cmd)
            if phone.image is not None and phone.due("preview", now, PREVIEW_S):
                self._post(phone, "preview", {"jpeg": self._jpeg(phone)})

    def _look(self, phone: Phone, now: float) -> None:
        try:
            image = self.render(camera_pose(phone.cam), intrinsics(phone.lens))
            found = self.detect(image)
            phone.error = None
        except Exception as e:  # noqa: BLE001  (a phone's error is reported in its heartbeat)
            phone.error = f"{type(e).__name__}: {e}"[:200]
            return
        phone.image = image
        boxes = [{"x": x, "y": y, "w": w, "h": h, "score": s} for x, y, w, h, s in found]
        phone.boxes = sorted([b for b in boxes if plausible(b, phone.threshold)], key=lambda b: -b["score"])
        score = phone.dwell_step(DETECT_EVERY_S)
        if score is not None and now - phone._last_alert >= ALERT_GAP_S:
            phone._last_alert = now
            reply = self._post(phone, "intrusion", {"score": score, "roi": phone.roi, "note": "person-in-roi-1s", "force": False, "lens": phone.lens})
            self.log(f"phone {phone.slot}: person in its red zone -> intrusion " + json.dumps(reply)[:160])

    @staticmethod
    def _jpeg(phone: Phone) -> str:
        import cv2

        small = cv2.resize(phone.image, (240, 135), interpolation=cv2.INTER_AREA)[:, :, ::-1].copy()
        if phone.roi:
            r = phone.roi
            cv2.rectangle(small, (int(r["x"] * 240), int(r["y"] * 135)), (int((r["x"] + r["w"]) * 240), int((r["y"] + r["h"]) * 135)), (42, 59, 194), 2)
        ok, buf = cv2.imencode(".jpg", small, [cv2.IMWRITE_JPEG_QUALITY, 42])
        return "data:image/jpeg;base64," + base64.b64encode(buf.tobytes()).decode()

    # ---- the thread
    def start(self) -> None:
        def run() -> None:
            while not self._stop.is_set():
                self.tick(time.monotonic())
                self._stop.wait(0.03)

        self._thread = threading.Thread(target=run, name="phones", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=3)
        for phone in list(self.phones.values()):
            if phone.token:
                self._call(f"/api/slots/{phone.slot}/leave", {"token": phone.token}, phone.token, timeout=0.5)


def yolo_people(weights: str = "yolo11n.pt"):
    """RGB image -> [(x, y, w, h normalized, score)] for people, with the simulator's YOLO."""
    from .places import load_yolo

    model = load_yolo(weights)

    def detect(image: np.ndarray) -> list[tuple[float, float, float, float, float]]:
        h, w = image.shape[:2]
        r = model(image[:, :, ::-1], verbose=False, conf=0.4, classes=[0])[0]
        out = []
        for (x0, y0, x1, y1), score in zip(r.boxes.xyxy.cpu().numpy(), r.boxes.conf.cpu().numpy()):
            out.append((float(x0 / w), float(y0 / h), float((x1 - x0) / w), float((y1 - y0) / h), float(score)))
        return out

    return detect

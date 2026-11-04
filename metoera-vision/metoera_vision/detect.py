"""Detection model wrapper plus the pure functions that shape the JSON the API returns."""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Optional, Protocol

import numpy as np

from . import PROJECT_ROOT

log = logging.getLogger("metoera.vision.detect")


@dataclass(frozen=True)
class RawBox:
    """A detection in pixel coordinates (x1,y1 top-left; x2,y2 bottom-right)."""

    x1: float
    y1: float
    x2: float
    y2: float
    confidence: float
    label: str


class Detector(Protocol):
    name: str
    device: str

    def detect(self, image: np.ndarray) -> list[RawBox]: ...


def _clamp01(v: float) -> float:
    return 0.0 if v < 0 else 1.0 if v > 1 else v


def normalize_box(b: RawBox, width: int, height: int) -> dict:
    x1 = _clamp01(b.x1 / width)
    y1 = _clamp01(b.y1 / height)
    x2 = _clamp01(b.x2 / width)
    y2 = _clamp01(b.y2 / height)
    w = max(0.0, x2 - x1)
    h = max(0.0, y2 - y1)
    return {
        "label": b.label,
        "confidence": round(float(b.confidence), 4),
        "box": {"x": round(x1, 4), "y": round(y1, 4), "w": round(w, 4), "h": round(h, 4)},
        "center": {"x": round(x1 + w / 2, 4), "y": round(y1 + h / 2, 4)},
    }


def build_result(boxes: Iterable[RawBox], width: int, height: int, timestamp: Optional[float] = None,
                 frame_seq: Optional[int] = None, inference_ms: Optional[float] = None) -> dict:
    objs = [normalize_box(b, width, height) for b in boxes]
    objs.sort(key=lambda o: o["confidence"], reverse=True)
    res = {
        "timestamp": time.time() if timestamp is None else timestamp,
        "frame_size": [int(width), int(height)],
        "objects": objs,
    }
    if frame_seq is not None:
        res["frame_seq"] = frame_seq
    if inference_ms is not None:
        res["inference_ms"] = round(inference_ms, 1)
    return res


def describe_position(center: dict) -> str:
    """Coarse spoken position, e.g. 'left', 'center', 'upper right'."""
    x, y = center["x"], center["y"]
    horiz = "left" if x < 1 / 3 else "right" if x > 2 / 3 else "center"
    vert = "upper" if y < 1 / 3 else "lower" if y > 2 / 3 else ""
    if vert and horiz == "center":
        return vert + " center"
    return f"{vert} {horiz}".strip()


def find_best(result: Optional[dict], label: str, min_confidence: float = 0.0) -> Optional[dict]:
    """Highest-confidence object whose label matches `label` (case-insensitive;
    exact match preferred, then substring like 'phone' -> 'cell phone'). None if absent."""
    if not result or not label:
        return None
    q = label.strip().lower()
    objs = [o for o in result.get("objects", []) if o["confidence"] >= min_confidence]
    exact = [o for o in objs if o["label"].lower() == q]
    cands = exact or [o for o in objs if q in o["label"].lower()]
    if not cands:
        return None
    best = max(cands, key=lambda o: o["confidence"])
    out = dict(best)
    out["position"] = describe_position(best["center"])
    out["count"] = len(cands)
    return out


def annotate(image: np.ndarray, result: Optional[dict]) -> np.ndarray:
    """Draw boxes + labels from a (normalized) result onto a copy of `image`."""
    import cv2

    img = image.copy()
    if not result:
        return img
    h, w = img.shape[:2]
    for o in result.get("objects", []):
        b = o["box"]
        x1, y1 = int(b["x"] * w), int(b["y"] * h)
        x2, y2 = int((b["x"] + b["w"]) * w), int((b["y"] + b["h"]) * h)
        color = _color_for(o["label"])
        cv2.rectangle(img, (x1, y1), (x2, y2), color, 2)
        text = f"{o['label']} {o['confidence']:.2f}"
        (tw, th), _ = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, 0.5, 1)
        ty = max(y1, th + 4)
        cv2.rectangle(img, (x1, ty - th - 4), (x1 + tw + 4, ty), color, -1)
        cv2.putText(img, text, (x1 + 2, ty - 3), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 0), 1, cv2.LINE_AA)
    return img


def _color_for(label: str) -> tuple[int, int, int]:
    hsh = sum(ord(c) * (i + 1) for i, c in enumerate(label))
    return (80 + hsh * 37 % 176, 80 + hsh * 67 % 176, 80 + hsh * 97 % 176)


def pick_device(requested: str = "auto") -> str:
    if requested and requested != "auto":
        return requested
    try:
        import torch

        if torch.backends.mps.is_available():
            return "mps"
        if torch.cuda.is_available():
            return "cuda:0"
    except Exception:  # pragma: no cover
        pass
    return "cpu"


class YoloDetector:
    """Ultralytics YOLO (AGPL-3.0). Weights are fetched from the official
    ultralytics/assets GitHub release into ./weights/ on first use."""

    def __init__(self, model: str = "yolo11n.pt", device: str = "auto", conf: float = 0.35,
                 imgsz: int = 640, classes: Optional[list[str]] = None) -> None:
        from ultralytics import YOLO
        from ultralytics.utils import SETTINGS

        if SETTINGS.get("sync"):
            SETTINGS.update({"sync": False})  # no anonymous usage analytics

        path = Path(model)
        if not path.is_absolute() and path.parent == Path("."):
            path = PROJECT_ROOT / "weights" / path.name
            path.parent.mkdir(parents=True, exist_ok=True)
        self.name = path.name
        self.device = pick_device(device)
        self.conf = conf
        self.imgsz = imgsz
        self.model = YOLO(str(path))
        self._class_ids = None
        if classes:
            wanted = {c.strip().lower() for c in classes}
            self._class_ids = [i for i, n in self.model.names.items() if n.lower() in wanted]
        # Warm-up so the first real frame isn't slow (MPS kernels compile lazily).
        self.detect(np.zeros((720, 960, 3), dtype=np.uint8))
        log.info("model %s on %s ready", self.name, self.device)

    def detect(self, image: np.ndarray) -> list[RawBox]:
        r = self.model.predict(image, device=self.device, conf=self.conf, imgsz=self.imgsz,
                               classes=self._class_ids, verbose=False)[0]
        names = r.names
        boxes = r.boxes
        if boxes is None or len(boxes) == 0:
            return []
        xyxy = boxes.xyxy.cpu().numpy()
        confs = boxes.conf.cpu().numpy()
        cls = boxes.cls.cpu().numpy().astype(int)
        return [RawBox(float(a), float(b), float(c), float(d), float(p), names[int(k)])
                for (a, b, c, d), p, k in zip(xyxy, confs, cls)]

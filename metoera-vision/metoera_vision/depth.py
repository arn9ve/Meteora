"""Metric monocular depth (Depth Anything V2 Metric Indoor) plus the pure functions that
turn a depth map and YOLO boxes into the /depth JSON.

The model outputs, for every pixel, metric depth in metres: the z distance along the
camera's optical axis (the distance to the image plane), NOT the slant range along the
ray through that pixel. For an object off to the side, slant range = z / cos(bearing).
"""

from __future__ import annotations

import logging
import math
import threading
import time
from typing import Optional, Protocol

import numpy as np

log = logging.getLogger("metoera.vision.depth")

DEFAULT_DEPTH_MODEL = "depth-anything/Depth-Anything-V2-Metric-Indoor-Small-hf"

# Tello / RoboMaster TT camera: 960x720, ~82.6 deg diagonal FOV -> ~70 deg horizontal,
# focal length ~683 px at 960 px width. Pinhole model, no lens distortion correction.
TELLO_HFOV_DEG = 70.0

# Region of a box whose depth stands for the object: the inner 50 % of the width and the
# middle 60 % of the height (top/bottom 20 % dropped: they often hit floor, wall or sky).
BOX_INNER_W = 0.50
BOX_INNER_H = 0.60

# Obstacle columns: a horizontal band that mostly excludes ceiling (top) and floor (bottom).
COLUMN_BAND = (0.35, 0.80)
COLUMN_COUNT = 24
COLUMN_PERCENTILE = 10.0

DEPTH_NOTE = ("depth_m is metric z-distance along the optical axis (not slant range); "
              "slant range ~= depth_m / cos(bearing). Monocular estimate, roughly +/-10-25%.")


class DepthModel(Protocol):
    name: str
    device: str

    def predict(self, image: np.ndarray) -> np.ndarray:
        """BGR HxWx3 uint8 -> HxW float32 metric depth in metres (same size as the image)."""
        ...


# ---- pure geometry ---------------------------------------------------------------------

def focal_px(width: int, hfov_deg: float = TELLO_HFOV_DEG) -> float:
    return (width / 2.0) / math.tan(math.radians(hfov_deg) / 2.0)


def bearing_deg(x: float, hfov_deg: float = TELLO_HFOV_DEG) -> float:
    """Horizontal angle from the optical axis for normalised image x in [0,1] (+ = right).
    Pinhole: tan(bearing) = (x - 0.5) * 2 * tan(hfov/2); x=0/1 give -/+ hfov/2."""
    return math.degrees(math.atan((x - 0.5) * 2.0 * math.tan(math.radians(hfov_deg) / 2.0)))


def _finite(a: np.ndarray) -> np.ndarray:
    a = a.ravel()
    return a[np.isfinite(a) & (a > 0)]


def box_depth(depth: np.ndarray, box: dict, inner_w: float = BOX_INNER_W,
              inner_h: float = BOX_INNER_H) -> tuple[Optional[float], Optional[float]]:
    """Robust distance to an object: median depth over the central part of its box
    (normalised {x,y,w,h}). Returns (median_m, iqr_m); (None, None) for an empty region."""
    h, w = depth.shape[:2]
    cx = box["x"] + box["w"] / 2.0
    cy = box["y"] + box["h"] / 2.0
    hw = box["w"] * inner_w / 2.0
    hh = box["h"] * inner_h / 2.0
    x1 = int(math.floor(max(0.0, cx - hw) * w))
    x2 = int(math.ceil(min(1.0, cx + hw) * w))
    y1 = int(math.floor(max(0.0, cy - hh) * h))
    y2 = int(math.ceil(min(1.0, cy + hh) * h))
    x2 = max(x2, min(w, x1 + 1))  # at least one pixel for tiny boxes
    y2 = max(y2, min(h, y1 + 1))
    vals = _finite(depth[y1:y2, x1:x2])
    if vals.size == 0:
        return None, None
    q1, med, q3 = np.percentile(vals, [25, 50, 75])
    return float(med), float(q3 - q1)


def column_depths(depth: np.ndarray, n: int = COLUMN_COUNT, band: tuple[float, float] = COLUMN_BAND,
                  percentile: float = COLUMN_PERCENTILE, hfov_deg: float = TELLO_HFOV_DEG) -> list[dict]:
    """Split the image into `n` vertical strips; in each, the near-obstacle distance is the
    `percentile`-th percentile of depth inside the horizontal band (fractions of image height)."""
    h, w = depth.shape[:2]
    y1 = int(round(band[0] * h))
    y2 = max(y1 + 1, int(round(band[1] * h)))
    strip = depth[y1:y2]
    edges = np.linspace(0, w, n + 1)
    out = []
    for i in range(n):
        a, b = int(round(edges[i])), int(round(edges[i + 1]))
        b = max(b, a + 1)
        vals = _finite(strip[:, a:b])
        x = (edges[i] + edges[i + 1]) / 2.0 / w
        out.append({
            "x": round(x, 4),
            "bearing_deg": round(bearing_deg(x, hfov_deg), 2),
            "depth_m": round(float(np.percentile(vals, percentile)), 3) if vals.size else None,
        })
    return out


def build_depth_result(depth: np.ndarray, detections: Optional[dict], *, timestamp: float,
                       inference_ms: float, model: str, hfov_deg: float = TELLO_HFOV_DEG,
                       n_columns: int = COLUMN_COUNT) -> dict:
    """The /depth JSON for one frame: YOLO objects with a robust depth each, plus obstacle columns."""
    h, w = depth.shape[:2]
    objects = []
    for o in (detections or {}).get("objects", []):
        med, iqr = box_depth(depth, o["box"])
        obj = {k: o[k] for k in ("label", "confidence", "box", "center")}
        obj["depth_m"] = None if med is None else round(med, 3)
        obj["depth_spread_m"] = None if iqr is None else round(iqr, 3)
        obj["bearing_deg"] = round(bearing_deg(o["center"]["x"], hfov_deg), 2)
        objects.append(obj)
    return {
        "timestamp": timestamp,
        "frame_size": [int(w), int(h)],
        "inference_ms": round(inference_ms, 1),
        "model": model,
        "hfov_deg": hfov_deg,
        "focal_px": round(focal_px(w, hfov_deg), 1),
        "note": DEPTH_NOTE,
        "objects": objects,
        "columns": column_depths(depth, n_columns, hfov_deg=hfov_deg),
    }


# ---- the real model ----------------------------------------------------------------------

def pick_depth_device(requested: str = "auto") -> str:
    """Apple `mps` when available, else cpu (an explicit device is used as given)."""
    if requested and requested != "auto":
        return requested
    try:
        import torch

        if torch.backends.mps.is_available():
            return "mps"
    except Exception:  # pragma: no cover
        pass
    return "cpu"


class HfDepthModel:
    """Depth Anything V2 Metric Indoor via Hugging Face `transformers`. Weights are fetched
    from the Hugging Face Hub into ./.hf-cache/ (HF_HOME, set in metoera_vision/__init__)."""

    def __init__(self, model_id: str = DEFAULT_DEPTH_MODEL, device: str = "auto") -> None:
        import torch
        from transformers import AutoImageProcessor, AutoModelForDepthEstimation

        self.name = model_id
        self.device = pick_depth_device(device)
        self._torch = torch
        try:  # already in .hf-cache: no request to the Hub at all
            self.processor = AutoImageProcessor.from_pretrained(model_id, local_files_only=True)
            model = AutoModelForDepthEstimation.from_pretrained(model_id, local_files_only=True)
        except OSError:
            log.info("downloading %s from Hugging Face into the project cache...", model_id)
            self.processor = AutoImageProcessor.from_pretrained(model_id)
            model = AutoModelForDepthEstimation.from_pretrained(model_id)
        self.model = model.to(self.device).eval()
        self.predict(np.zeros((720, 960, 3), dtype=np.uint8))  # warm-up (MPS compiles lazily)
        log.info("depth model %s on %s ready", model_id, self.device)

    def predict(self, image: np.ndarray) -> np.ndarray:
        torch = self._torch
        rgb = np.ascontiguousarray(image[:, :, ::-1])
        inputs = self.processor(images=rgb, return_tensors="pt").to(self.device)
        with torch.inference_mode():
            pred = self.model(**inputs).predicted_depth  # (1, h', w') metres
            pred = torch.nn.functional.interpolate(pred.unsqueeze(1), size=image.shape[:2],
                                                   mode="bilinear", align_corners=False)
        return pred[0, 0].float().cpu().numpy()


class DepthEngine:
    """Owns the (lazily loaded) depth model and serialises inference across HTTP threads.
    `factory` builds the model; tests pass a stub."""

    def __init__(self, factory, model_name: str = DEFAULT_DEPTH_MODEL, device: str = "auto") -> None:
        self._factory = factory
        self.model_name = model_name
        self.requested_device = device
        self.model: Optional[DepthModel] = None
        self.error: Optional[str] = None
        self.loading = False
        self.last_ms: Optional[float] = None
        self.runs = 0
        self._load_lock = threading.Lock()
        self._run_lock = threading.Lock()

    @classmethod
    def huggingface(cls, model_id: str = DEFAULT_DEPTH_MODEL, device: str = "auto") -> "DepthEngine":
        return cls(lambda: HfDepthModel(model_id, device), model_id, device)

    @property
    def loaded(self) -> bool:
        return self.model is not None

    def load(self) -> DepthModel:
        if self.model is not None:
            return self.model
        with self._load_lock:
            if self.model is None:
                self.loading = True
                t0 = time.perf_counter()
                try:
                    self.model = self._factory()
                    self.error = None
                    log.info("depth model loaded in %.1f s", time.perf_counter() - t0)
                except Exception as e:
                    self.error = f"{type(e).__name__}: {e}"
                    log.exception("depth model failed to load")
                    raise
                finally:
                    self.loading = False
        return self.model

    def preload_in_background(self) -> threading.Thread:
        def run():
            try:
                self.load()
            except Exception:
                pass  # recorded in self.error; the next /depth call retries
        t = threading.Thread(target=run, name="depth-load", daemon=True)
        t.start()
        return t

    def predict(self, image: np.ndarray) -> tuple[np.ndarray, float]:
        model = self.load()
        with self._run_lock:
            t0 = time.perf_counter()
            depth = model.predict(image)
            ms = (time.perf_counter() - t0) * 1000
        self.last_ms = round(ms, 1)
        self.runs += 1
        return depth, ms

    def health(self) -> dict:
        m = self.model
        return {
            "enabled": True,
            "loaded": m is not None,
            "loading": self.loading,
            "model": self.model_name,
            "device": getattr(m, "device", None) or self.requested_device,
            "last_ms": self.last_ms,
            "runs": self.runs,
            "error": self.error,
        }

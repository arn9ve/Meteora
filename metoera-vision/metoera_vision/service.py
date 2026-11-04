"""Detection loop + shared state between the video source and the HTTP API."""

from __future__ import annotations

import logging
import threading
import time
from collections import deque
from typing import Optional

from .detect import Detector, annotate, build_result
from .frames import Frame, LatestFrame
from .sources import Source

log = logging.getLogger("metoera.vision.service")


class VisionService:
    def __init__(self, source: Optional[Source], detector: Detector, frames: LatestFrame,
                 detect_fps: float = 5.0, jpeg_quality: int = 75) -> None:
        self.source = source
        self.detector = detector
        self.frames = frames
        self.detect_fps = detect_fps
        self.jpeg_quality = jpeg_quality
        self._lock = threading.Lock()
        self._result: Optional[dict] = None
        self._result_seq = 0  # bumps on every new detection result
        self._detect_times: deque[float] = deque(maxlen=64)
        self.detections_run = 0
        self.last_error: Optional[str] = None
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._jpeg_cache: tuple[tuple[int, int], bytes] | None = None
        self.started_at = time.time()

    # ---- lifecycle -------------------------------------------------------
    def start(self) -> None:
        if self.source is not None:
            self.source.start()
        self._thread = threading.Thread(target=self._loop, name="detector", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self.source is not None:
            self.source.stop()

    # ---- detection -------------------------------------------------------
    def process(self, frame: Frame) -> dict:
        """Run the model on one frame and publish the result."""
        t0 = time.perf_counter()
        boxes = self.detector.detect(frame.image)
        ms = (time.perf_counter() - t0) * 1000
        w, h = frame.size
        res = build_result(boxes, w, h, timestamp=frame.t, frame_seq=frame.seq, inference_ms=ms)
        with self._lock:
            self._result = res
            self._result_seq += 1
            self.detections_run += 1
        return res

    def _loop(self) -> None:
        period = 1.0 / self.detect_fps if self.detect_fps > 0 else 0.0
        last_seq = 0
        while not self._stop.is_set():
            started = time.monotonic()
            # Always take the newest frame; anything older was already overwritten.
            frame = self.frames.wait_newer(last_seq, timeout=0.5)
            if frame is None:
                continue
            last_seq = frame.seq
            try:
                self.process(frame)
                self.last_error = None
            except Exception as e:  # keep the loop alive on a bad frame
                self.last_error = f"{type(e).__name__}: {e}"
                log.exception("detection failed")
            self._detect_times.append(time.monotonic())
            sleep = period - (time.monotonic() - started)
            if sleep > 0:
                self._stop.wait(sleep)

    @property
    def fps_detect(self) -> float:
        """Detections per second over the last ~3 s."""
        now = time.monotonic()
        recent = [t for t in self._detect_times if now - t <= 3.0]
        if len(recent) < 2:
            return 0.0
        span = now - recent[0]
        return (len(recent) - 1) / span if span > 0 else 0.0

    # ---- read side -------------------------------------------------------
    def latest_result(self) -> Optional[dict]:
        with self._lock:
            return self._result

    def annotated_jpeg(self) -> Optional[bytes]:
        """Newest frame with the newest detections drawn on it (cached per frame/result pair)."""
        import cv2

        frame = self.frames.get()
        if frame is None:
            return None
        with self._lock:
            res, rseq = self._result, self._result_seq
        key = (frame.seq, rseq)
        cache = self._jpeg_cache
        if cache is not None and cache[0] == key:
            return cache[1]
        img = annotate(frame.image, res)
        ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, self.jpeg_quality])
        if not ok:
            return None
        data = buf.tobytes()
        self._jpeg_cache = (key, data)
        return data

    def health(self) -> dict:
        frame = self.frames.get()
        age_ms = None if frame is None else round((time.time() - frame.t) * 1000)
        res = self.latest_result()
        src_stats = self.source.stats() if self.source is not None else None
        ok = (frame is not None and age_ms is not None and age_ms < 3000 and self.last_error is None
              and not (src_stats and src_stats.get("error")))
        return {
            "ok": bool(ok),
            "source": self.source.description if self.source is not None else None,
            "fps_in": round(self.frames.fps_in, 1),
            "fps_detect": round(self.fps_detect, 1),
            "detect_fps_target": self.detect_fps,
            "last_frame_age_ms": age_ms,
            "last_detection_age_ms": None if res is None else round((time.time() - res["timestamp"]) * 1000),
            "frame_size": list(frame.size) if frame is not None else None,
            "model": getattr(self.detector, "name", "?"),
            "device": getattr(self.detector, "device", "?"),
            "frames_dropped": self.frames.dropped,
            "detections_run": self.detections_run,
            "source_stats": src_stats,
            "error": self.last_error or (src_stats or {}).get("error"),
            "uptime_s": round(time.time() - self.started_at, 1),
        }

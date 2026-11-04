"""Detection loop + shared state between the video source(s) and the HTTP API.

One shared model serves one or more *channels*. A channel is one video feed: its
LatestFrame, its newest detection result and its stats. Single-source mode
(file, webcam, plain udp) has exactly one channel with id None. Multi-drone mode
has one channel per drone id.
"""

from __future__ import annotations

import logging
import threading
import time
from collections import deque
from typing import Callable, Optional

from .detect import Detector, annotate, build_result
from .frames import Frame, LatestFrame
from .sources import Source

log = logging.getLogger("metoera.vision.service")


class UnknownDrone(KeyError):
    pass


class Channel:
    """Per-feed state: newest frame, newest result, detection timing."""

    def __init__(self, drone_id: Optional[str], frames: LatestFrame,
                 stats: Optional[Callable[[], dict]] = None, address: Optional[str] = None) -> None:
        self.id = drone_id
        self.frames = frames
        self.stats = stats
        self.address = address
        self.lock = threading.Lock()
        self.result: Optional[dict] = None
        self.result_seq = 0  # bumps on every new detection result
        self.detect_times: deque[float] = deque(maxlen=64)
        self.detections_run = 0
        self.last_error: Optional[str] = None
        self.jpeg_cache: tuple[tuple[int, int], bytes] | None = None
        # scheduler state
        self.last_seq = 0  # newest frame seq already detected
        self.next_due = 0.0  # monotonic time before which this channel isn't served again

    @property
    def fps_detect(self) -> float:
        """Detections per second over the last ~3 s."""
        now = time.monotonic()
        recent = [t for t in self.detect_times if now - t <= 3.0]
        if len(recent) < 2:
            return 0.0
        span = now - recent[0]
        return (len(recent) - 1) / span if span > 0 else 0.0


class VisionService:
    """`VisionService(source, detector, frames)` is the single-feed service.
    Pass `channels=[Channel(...), ...]` (and frames=None) for several drones."""

    def __init__(self, source: Optional[Source], detector: Detector, frames: Optional[LatestFrame] = None,
                 detect_fps: float = 5.0, jpeg_quality: int = 75,
                 channels: Optional[list[Channel]] = None) -> None:
        if channels is None:
            if frames is None:
                raise ValueError("need frames or channels")
            channels = [Channel(None, frames)]
        if not channels:
            raise ValueError("no channels")
        self.source = source
        self.detector = detector
        self.channels = list(channels)
        self._by_id = {c.id: c for c in self.channels}
        self.multi = self.channels[0].id is not None
        self.frames = self.channels[0].frames  # default (first) feed
        self.detect_fps = detect_fps
        self.jpeg_quality = jpeg_quality
        self._wake = threading.Event()
        for c in self.channels:
            c.frames.add_listener(self._wake.set)
        self._rr = 0  # round-robin cursor
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self.started_at = time.time()

    # ---- channel lookup ---------------------------------------------------
    @property
    def drone_ids(self) -> list[str]:
        return [c.id for c in self.channels if c.id is not None]

    def channel(self, drone: Optional[str] = None) -> Channel:
        """The channel for `drone`; the first one when `drone` is None/empty.
        Raises UnknownDrone for an id that isn't configured."""
        if not drone:
            return self.channels[0]
        c = self._by_id.get(drone) if self.multi else None
        if c is None:
            raise UnknownDrone(drone)
        return c

    # ---- lifecycle -------------------------------------------------------
    def start(self) -> None:
        if self.source is not None:
            self.source.start()
        self._thread = threading.Thread(target=self._loop, name="detector", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._wake.set()
        if self.source is not None:
            self.source.stop()

    # ---- detection -------------------------------------------------------
    def process(self, frame: Frame, channel: Optional[Channel] = None) -> dict:
        """Run the model on one frame and publish the result on `channel` (default: first)."""
        ch = channel or self.channels[0]
        t0 = time.perf_counter()
        boxes = self.detector.detect(frame.image)
        ms = (time.perf_counter() - t0) * 1000
        w, h = frame.size
        res = build_result(boxes, w, h, timestamp=frame.t, frame_seq=frame.seq, inference_ms=ms)
        if ch.id is not None:
            res["drone"] = ch.id
        with ch.lock:
            ch.result = res
            ch.result_seq += 1
            ch.detections_run += 1
        return res

    def _pick(self, now: float) -> tuple[Optional[Channel], Optional[Frame], float]:
        """Round-robin over channels that have a newer frame and are due.
        Returns (channel, frame, seconds until something might become due)."""
        n = len(self.channels)
        wait = 0.5
        for i in range(n):
            ch = self.channels[(self._rr + i) % n]
            frame = ch.frames.peek()
            if frame is None or frame.seq <= ch.last_seq:
                continue
            if now < ch.next_due:
                wait = min(wait, ch.next_due - now)
                continue
            self._rr = (self._rr + i + 1) % n  # next scan starts after this one
            return ch, ch.frames.get(), 0.0
        return None, None, wait

    def _loop(self) -> None:
        period = 1.0 / self.detect_fps if self.detect_fps > 0 else 0.0
        while not self._stop.is_set():
            self._wake.clear()
            started = time.monotonic()
            ch, frame, wait = self._pick(started)
            if ch is None:
                # Woken by a new frame on any channel, or when a channel becomes due.
                self._wake.wait(wait)
                continue
            # Always the newest frame of that channel; anything older was overwritten.
            ch.last_seq = frame.seq
            ch.next_due = started + period
            try:
                self.process(frame, ch)
                ch.last_error = None
            except Exception as e:  # keep the loop alive on a bad frame
                ch.last_error = f"{type(e).__name__}: {e}"
                log.exception("detection failed%s", f" ({ch.id})" if ch.id else "")
            ch.detect_times.append(time.monotonic())

    # ---- backward-compatible single-feed accessors -------------------------
    @property
    def fps_detect(self) -> float:
        return self.channels[0].fps_detect

    @property
    def detections_run(self) -> int:
        return sum(c.detections_run for c in self.channels)

    @property
    def last_error(self) -> Optional[str]:
        return next((c.last_error for c in self.channels if c.last_error), None)

    # ---- read side -------------------------------------------------------
    def latest_result(self, drone: Optional[str] = None) -> Optional[dict]:
        ch = self.channel(drone)
        with ch.lock:
            return ch.result

    def annotated_jpeg(self, drone: Optional[str] = None) -> Optional[bytes]:
        """Newest frame with the newest detections drawn on it (cached per frame/result pair)."""
        import cv2

        ch = self.channel(drone)
        frame = ch.frames.get()
        if frame is None:
            return None
        with ch.lock:
            res, rseq = ch.result, ch.result_seq
        key = (frame.seq, rseq)
        cache = ch.jpeg_cache
        if cache is not None and cache[0] == key:
            return cache[1]
        img = annotate(frame.image, res)
        ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, self.jpeg_quality])
        if not ok:
            return None
        data = buf.tobytes()
        ch.jpeg_cache = (key, data)
        return data

    def _channel_health(self, ch: Channel) -> dict:
        frame = ch.frames.get()
        now = time.time()
        age_ms = None if frame is None else round((now - frame.t) * 1000)
        with ch.lock:
            res = ch.result
        dstats = ch.stats() if ch.stats is not None else {}
        src_err = (self.source.stats().get("error") if self.source is not None else None)
        ok = frame is not None and age_ms < 3000 and ch.last_error is None and not src_err
        return {
            "ok": bool(ok),
            "address": ch.address,
            "fps_in": round(ch.frames.fps_in, 1),
            "fps_detect": round(ch.fps_detect, 1),
            "last_frame_age_ms": age_ms,
            "last_detection_age_ms": None if res is None else round((now - res["timestamp"]) * 1000),
            "frame_size": list(frame.size) if frame is not None else None,
            "frames_dropped": ch.frames.dropped,
            "detections_run": ch.detections_run,
            "decode_errors": dstats.get("decode_errors", 0),
            "packets": dstats.get("packets", 0),
            "frames_decoded": dstats.get("frames_decoded", 0),
            "error": ch.last_error or src_err,
        }

    def health(self, drone: Optional[str] = None) -> dict:
        if not self.multi:
            return self._single_health()
        src_stats = self.source.stats() if self.source is not None else None
        common = {
            "source": self.source.description if self.source is not None else None,
            "detect_fps_target": self.detect_fps,
            "model": getattr(self.detector, "name", "?"),
            "device": getattr(self.detector, "device", "?"),
            "uptime_s": round(time.time() - self.started_at, 1),
        }
        if drone:  # one drone, in the familiar flat shape
            ch = self.channel(drone)
            out = {"drone": ch.id, **self._channel_health(ch), **common}
            return out
        drones = {c.id: self._channel_health(c) for c in self.channels}
        first = drones[self.channels[0].id]
        return {
            # ok: every configured drone has fresh video and no errors
            "ok": all(d["ok"] for d in drones.values()),
            "default_drone": self.channels[0].id,
            # flat fields mirror the default (first) drone, for single-drone callers
            **{k: first[k] for k in ("fps_in", "fps_detect", "last_frame_age_ms", "last_detection_age_ms",
                                     "frame_size", "frames_dropped")},
            **common,
            "detections_run": self.detections_run,
            "drones": drones,
            "source_stats": src_stats,
            "error": (src_stats or {}).get("error") or self.last_error,
        }

    def _single_health(self) -> dict:
        ch = self.channels[0]
        frame = ch.frames.get()
        age_ms = None if frame is None else round((time.time() - frame.t) * 1000)
        res = self.latest_result()
        src_stats = self.source.stats() if self.source is not None else None
        ok = (frame is not None and age_ms is not None and age_ms < 3000 and self.last_error is None
              and not (src_stats and src_stats.get("error")))
        return {
            "ok": bool(ok),
            "source": self.source.description if self.source is not None else None,
            "fps_in": round(ch.frames.fps_in, 1),
            "fps_detect": round(self.fps_detect, 1),
            "detect_fps_target": self.detect_fps,
            "last_frame_age_ms": age_ms,
            "last_detection_age_ms": None if res is None else round((time.time() - res["timestamp"]) * 1000),
            "frame_size": list(frame.size) if frame is not None else None,
            "model": getattr(self.detector, "name", "?"),
            "device": getattr(self.detector, "device", "?"),
            "frames_dropped": ch.frames.dropped,
            "detections_run": self.detections_run,
            "source_stats": src_stats,
            "error": self.last_error or (src_stats or {}).get("error"),
            "uptime_s": round(time.time() - self.started_at, 1),
        }

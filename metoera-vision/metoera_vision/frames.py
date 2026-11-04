"""Latest-frame holder: producers overwrite, consumers only ever see the newest frame."""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from typing import Optional

import numpy as np


@dataclass(frozen=True)
class Frame:
    image: np.ndarray  # BGR, HxWx3
    seq: int  # monotonically increasing per accepted frame
    t: float  # time.time() when received

    @property
    def size(self) -> tuple[int, int]:
        h, w = self.image.shape[:2]
        return w, h


class LatestFrame:
    """A single-slot buffer. `put` replaces whatever is there (old frames are dropped),
    so a slow consumer never works through a backlog."""

    def __init__(self) -> None:
        self._cond = threading.Condition()
        self._frame: Optional[Frame] = None
        self._seq = 0
        self.dropped = 0  # frames overwritten before anyone read them
        self._last_read_seq = 0
        # input fps (exponential moving average)
        self._last_put_t: Optional[float] = None
        self.fps_in = 0.0

    def put(self, image: np.ndarray, t: Optional[float] = None) -> Frame:
        t = time.time() if t is None else t
        with self._cond:
            if self._frame is not None and self._frame.seq > self._last_read_seq:
                self.dropped += 1
            self._seq += 1
            self._frame = Frame(image=image, seq=self._seq, t=t)
            if self._last_put_t is not None:
                dt = t - self._last_put_t
                if dt > 0:
                    inst = 1.0 / dt
                    self.fps_in = inst if self.fps_in == 0 else 0.9 * self.fps_in + 0.1 * inst
            self._last_put_t = t
            self._cond.notify_all()
            return self._frame

    def get(self) -> Optional[Frame]:
        with self._cond:
            if self._frame is not None:
                self._last_read_seq = max(self._last_read_seq, self._frame.seq)
            return self._frame

    def wait_newer(self, seq: int, timeout: float) -> Optional[Frame]:
        """Block until a frame with seq > `seq` exists (or timeout). Returns newest frame or None."""
        deadline = time.monotonic() + timeout
        with self._cond:
            while self._frame is None or self._frame.seq <= seq:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return None
                self._cond.wait(remaining)
            self._last_read_seq = max(self._last_read_seq, self._frame.seq)
            return self._frame

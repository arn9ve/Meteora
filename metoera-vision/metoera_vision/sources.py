"""Video sources. Each source runs in its own thread and pushes BGR frames into a LatestFrame.

This module never sends anything to the drone. The UDP source only binds a local
port and *receives* the H.264 stream that the Tello pushes after the controlling
app (metoera-voice) has sent `streamon` on its own command socket.
"""

from __future__ import annotations

import logging
import socket
import threading
import time
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse

import numpy as np

from .frames import LatestFrame

log = logging.getLogger("metoera.vision.source")

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}


class Source(threading.Thread):
    kind = "base"

    def __init__(self, sink: LatestFrame, description: str) -> None:
        super().__init__(daemon=True, name=f"source-{self.kind}")
        self.sink = sink
        self.description = description
        self._stop_evt = threading.Event()
        self.error: Optional[str] = None
        self.frames_decoded = 0
        self.decode_errors = 0

    def stop(self) -> None:
        self._stop_evt.set()

    @property
    def stopped(self) -> bool:
        return self._stop_evt.is_set()

    def stats(self) -> dict:
        return {
            "kind": self.kind,
            "frames_decoded": self.frames_decoded,
            "decode_errors": self.decode_errors,
            "error": self.error,
        }


class UdpH264Source(Source):
    """Receives a raw H.264 elementary stream over UDP (the Tello video format).

    The Tello splits each NAL unit across several ~1460-byte datagrams with no
    container or RTP header. We feed every datagram into libavcodec's H.264 parser,
    which reassembles complete access units regardless of how they were split.
    Before the first SPS/PPS + IDR the decoder emits errors or grey/smeared
    frames; those are discarded until a keyframe has been decoded.
    """

    kind = "udp"

    def __init__(self, sink: LatestFrame, host: str, port: int, keyframe_grace_s: float = 4.0) -> None:
        super().__init__(sink, f"udp://{host}:{port}")
        self.host = host
        self.port = port
        self.keyframe_grace_s = keyframe_grace_s
        self.packets = 0
        self.bytes = 0
        self.last_packet_t: Optional[float] = None
        self.garbage_frames_skipped = 0

    def stats(self) -> dict:
        s = super().stats()
        s.update(packets=self.packets, bytes=self.bytes, garbage_frames_skipped=self.garbage_frames_skipped)
        return s

    def _new_codec(self):
        import av

        ctx = av.CodecContext.create("h264", "r")
        # Low-latency decode; tolerate the occasional corrupt packet.
        try:
            ctx.flags |= av.codec.context.Flags.low_delay
        except Exception:  # pragma: no cover - flag naming differs across PyAV versions
            pass
        return ctx

    def run(self) -> None:
        import av

        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4 * 1024 * 1024)
        except OSError:
            pass
        try:
            sock.bind((self.host, self.port))
        except OSError as e:
            self.error = f"bind {self.host}:{self.port} failed: {e}"
            log.error(self.error)
            return
        sock.settimeout(0.5)
        log.info("listening for H.264 on udp://%s:%d (no commands are sent to the drone)", self.host, self.port)

        codec = self._new_codec()
        seen_keyframe = False
        first_frame_t: Optional[float] = None

        while not self.stopped:
            try:
                data, _addr = sock.recvfrom(65536)
            except socket.timeout:
                continue
            except OSError as e:
                self.error = f"recv failed: {e}"
                log.error(self.error)
                break
            self.packets += 1
            self.bytes += len(data)
            self.last_packet_t = time.time()
            try:
                packets = codec.parse(data)
            except av.error.FFmpegError:
                self.decode_errors += 1
                continue
            for pkt in packets:
                try:
                    frames = codec.decode(pkt)
                except av.error.FFmpegError:
                    # Typical at stream start (no SPS/PPS yet) or after packet loss.
                    self.decode_errors += 1
                    continue
                for vf in frames:
                    now = time.time()
                    if first_frame_t is None:
                        first_frame_t = now
                    if not seen_keyframe:
                        if vf.key_frame or (now - first_frame_t) > self.keyframe_grace_s:
                            seen_keyframe = True
                        else:
                            self.garbage_frames_skipped += 1
                            continue
                    try:
                        img = vf.to_ndarray(format="bgr24")
                    except Exception:
                        self.decode_errors += 1
                        continue
                    self.frames_decoded += 1
                    self.sink.put(img, now)
        sock.close()


class FileSource(Source):
    """Plays a video file (looping, paced to real time) or repeats a still image."""

    kind = "file"

    def __init__(self, sink: LatestFrame, path: str, loop: bool = True, image_fps: float = 10.0) -> None:
        super().__init__(sink, str(path))
        self.path = Path(path)
        self.loop = loop
        self.image_fps = image_fps

    def run(self) -> None:
        if not self.path.exists():
            self.error = f"file not found: {self.path}"
            log.error(self.error)
            return
        if self.path.suffix.lower() in IMAGE_EXTS:
            self._run_image()
        else:
            self._run_video()

    def _run_image(self) -> None:
        import cv2

        img = cv2.imread(str(self.path))
        if img is None:
            self.error = f"cannot read image: {self.path}"
            return
        period = 1.0 / self.image_fps
        while not self.stopped:
            self.frames_decoded += 1
            self.sink.put(img)
            time.sleep(period)

    def _run_video(self) -> None:
        import av

        while not self.stopped:
            try:
                container = av.open(str(self.path))
            except av.error.FFmpegError as e:
                self.error = f"cannot open {self.path}: {e}"
                log.error(self.error)
                return
            stream = container.streams.video[0]
            rate = float(stream.average_rate or stream.guessed_rate or 30)
            period = 1.0 / rate if rate > 0 else 1 / 30
            next_t = time.monotonic()
            try:
                for vf in container.decode(stream):
                    if self.stopped:
                        break
                    self.frames_decoded += 1
                    self.sink.put(vf.to_ndarray(format="bgr24"))
                    next_t += period
                    delay = next_t - time.monotonic()
                    if delay > 0:
                        time.sleep(delay)
                    else:
                        next_t = time.monotonic()
            except av.error.FFmpegError:
                self.decode_errors += 1
            finally:
                container.close()
            if not self.loop:
                break


class WebcamSource(Source):
    kind = "webcam"

    def __init__(self, sink: LatestFrame, index: int) -> None:
        super().__init__(sink, f"webcam:{index}")
        self.index = index

    def run(self) -> None:
        import cv2

        cap = cv2.VideoCapture(self.index)
        if not cap.isOpened():
            self.error = f"cannot open webcam {self.index} (camera permission?)"
            log.error(self.error)
            return
        while not self.stopped:
            ok, img = cap.read()
            if not ok:
                self.decode_errors += 1
                time.sleep(0.05)
                continue
            self.frames_decoded += 1
            self.sink.put(img)
        cap.release()


def make_source(spec: str, sink: LatestFrame, loop: bool = True) -> Source:
    """`udp://HOST:PORT` | `webcam:N` | bare integer N | file path."""
    spec = spec.strip()
    if spec.startswith("udp://"):
        u = urlparse(spec)
        return UdpH264Source(sink, u.hostname or "0.0.0.0", u.port or 11111)
    if spec.startswith("webcam:"):
        return WebcamSource(sink, int(spec.split(":", 1)[1]))
    if spec.isdigit():
        return WebcamSource(sink, int(spec))
    return FileSource(sink, spec, loop=loop)


def blank_frame(w: int = 960, h: int = 720) -> np.ndarray:
    return np.zeros((h, w, 3), dtype=np.uint8)

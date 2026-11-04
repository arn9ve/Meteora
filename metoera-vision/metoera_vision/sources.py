"""Video sources. Each source runs in its own thread and pushes BGR frames into a LatestFrame.

This module never sends anything to the drone. The UDP source only binds a local
port and *receives* the H.264 stream that the Tello pushes after the controlling
app (metoera-voice) has sent `streamon` on its own command socket.
"""

from __future__ import annotations

import logging
import re
import socket
import threading
import time
from dataclasses import dataclass
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


class H264StreamDecoder:
    """Turns one sender's raw H.264 datagrams into BGR frames in a LatestFrame.

    The Tello splits each NAL unit across several ~1460-byte datagrams with no
    container or RTP header. Every datagram goes into libavcodec's H.264 parser,
    which reassembles complete access units however they were split. Before the
    first SPS/PPS + IDR the decoder emits errors or grey/smeared frames; those are
    discarded until a keyframe has been decoded (with a grace fallback).

    One instance per stream: the parser and decoder keep state, so datagrams from
    two drones must never be fed into the same instance.
    """

    def __init__(self, sink: LatestFrame, keyframe_grace_s: float = 4.0) -> None:
        self.sink = sink
        self.keyframe_grace_s = keyframe_grace_s
        self.packets = 0
        self.bytes = 0
        self.last_packet_t: Optional[float] = None
        self.frames_decoded = 0
        self.decode_errors = 0
        self.garbage_frames_skipped = 0
        self._codec = None
        self._seen_keyframe = False
        self._first_frame_t: Optional[float] = None

    @staticmethod
    def _new_codec():
        import av

        ctx = av.CodecContext.create("h264", "r")
        # Low-latency decode; tolerate the occasional corrupt packet.
        try:
            ctx.flags |= av.codec.context.Flags.low_delay
        except Exception:  # pragma: no cover - flag naming differs across PyAV versions
            pass
        return ctx

    def feed(self, data: bytes) -> None:
        import av

        if self._codec is None:
            self._codec = self._new_codec()
        codec = self._codec
        self.packets += 1
        self.bytes += len(data)
        self.last_packet_t = time.time()
        try:
            packets = codec.parse(data)
        except av.error.FFmpegError:
            self.decode_errors += 1
            return
        for pkt in packets:
            try:
                frames = codec.decode(pkt)
            except av.error.FFmpegError:
                # Typical at stream start (no SPS/PPS yet) or after packet loss.
                self.decode_errors += 1
                continue
            for vf in frames:
                now = time.time()
                if self._first_frame_t is None:
                    self._first_frame_t = now
                if not self._seen_keyframe:
                    if vf.key_frame or (now - self._first_frame_t) > self.keyframe_grace_s:
                        self._seen_keyframe = True
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

    def stats(self) -> dict:
        return {
            "packets": self.packets,
            "bytes": self.bytes,
            "frames_decoded": self.frames_decoded,
            "decode_errors": self.decode_errors,
            "garbage_frames_skipped": self.garbage_frames_skipped,
            "last_packet_age_ms": None if self.last_packet_t is None
            else round((time.time() - self.last_packet_t) * 1000),
        }


def _open_udp_socket(host: str, port: int) -> socket.socket:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4 * 1024 * 1024)
    except OSError:
        pass
    try:
        sock.bind((host, port))
    except OSError:
        sock.close()
        raise
    sock.settimeout(0.5)
    return sock


class UdpH264Source(Source):
    """Receives a raw H.264 elementary stream over UDP (the Tello video format).

    Every datagram, whoever sent it, goes into a single H264StreamDecoder. For
    several drones on one port use MultiDroneUdpSource instead.
    """

    kind = "udp"

    def __init__(self, sink: LatestFrame, host: str, port: int, keyframe_grace_s: float = 4.0) -> None:
        self._dec = H264StreamDecoder(sink, keyframe_grace_s)
        super().__init__(sink, f"udp://{host}:{port}")
        self.host = host
        self.port = port
        self.keyframe_grace_s = keyframe_grace_s

    # Counters live on the decoder; these keep the old attribute names working.
    packets = property(lambda self: self._dec.packets)
    bytes = property(lambda self: self._dec.bytes)
    last_packet_t = property(lambda self: self._dec.last_packet_t)
    garbage_frames_skipped = property(lambda self: self._dec.garbage_frames_skipped)
    frames_decoded = property(lambda self: self._dec.frames_decoded,
                              lambda self, v: setattr(self._dec, "frames_decoded", v))
    decode_errors = property(lambda self: self._dec.decode_errors,
                             lambda self, v: setattr(self._dec, "decode_errors", v))

    def stats(self) -> dict:
        s = super().stats()
        s.update(packets=self.packets, bytes=self.bytes, garbage_frames_skipped=self.garbage_frames_skipped)
        return s

    def run(self) -> None:
        try:
            sock = _open_udp_socket(self.host, self.port)
        except OSError as e:
            self.error = f"bind {self.host}:{self.port} failed: {e}"
            log.error(self.error)
            return
        log.info("listening for H.264 on udp://%s:%d (no commands are sent to the drone)", self.host, self.port)
        while not self.stopped:
            try:
                data, _addr = sock.recvfrom(65536)
            except socket.timeout:
                continue
            except OSError as e:
                self.error = f"recv failed: {e}"
                log.error(self.error)
                break
            self._dec.feed(data)
        sock.close()


# ---- several drones on one port -------------------------------------------------

@dataclass(frozen=True)
class DroneSpec:
    """One configured drone: datagrams from `ip` (and `port`, if given) belong to it."""

    id: str
    ip: str
    port: Optional[int] = None

    @property
    def address(self) -> str:
        return self.ip if self.port is None else f"{self.ip}:{self.port}"


def parse_drones(spec: str) -> list[DroneSpec]:
    """`tello=192.168.5.137,rmtt=192.168.5.68` or with source ports `a=127.0.0.1:50001,...`."""
    out: list[DroneSpec] = []
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        if "=" not in part:
            raise ValueError(f"bad drone entry {part!r}: expected id=ip or id=ip:port")
        did, addr = (x.strip() for x in part.split("=", 1))
        if not did or not addr:
            raise ValueError(f"bad drone entry {part!r}: expected id=ip or id=ip:port")
        if not re.fullmatch(r"[A-Za-z0-9_-]+", did):
            raise ValueError(f"bad drone id {did!r}: use letters, digits, '-' or '_'")
        port: Optional[int] = None
        if ":" in addr:
            addr, p = addr.rsplit(":", 1)
            if not p.isdigit() or not 0 < int(p) < 65536:
                raise ValueError(f"bad port in drone entry {part!r}")
            port = int(p)
        try:
            socket.inet_aton(addr)
        except OSError:
            raise ValueError(f"bad IPv4 address in drone entry {part!r}") from None
        if any(d.id == did for d in out):
            raise ValueError(f"duplicate drone id {did!r}")
        if any(d.ip == addr and d.port == port for d in out):
            raise ValueError(f"two drones share the address {addr}{'' if port is None else f':{port}'}")
        out.append(DroneSpec(did, addr, port))
    if not out:
        raise ValueError("no drones given")
    return out


class MultiDroneUdpSource(Source):
    """One UDP socket, several drones. Each datagram is routed by its sender
    address to that drone's own H.264 parser/decoder and LatestFrame, so streams
    never mix. An `ip:port` entry must match both; an `ip` entry matches any
    source port. Datagrams from anyone else are counted and dropped."""

    kind = "udp-multi"
    MAX_UNKNOWN_TRACKED = 32

    def __init__(self, drones: list[DroneSpec], sinks: dict[str, LatestFrame], host: str = "0.0.0.0",
                 port: int = 11111, keyframe_grace_s: float = 4.0) -> None:
        super().__init__(sinks[drones[0].id], f"udp://{host}:{port}")
        self.host = host
        self.port = port
        self.drones = list(drones)
        self.decoders: dict[str, H264StreamDecoder] = {
            d.id: H264StreamDecoder(sinks[d.id], keyframe_grace_s) for d in drones}
        self._by_addr = {(d.ip, d.port): d.id for d in drones if d.port is not None}
        self._by_ip = {d.ip: d.id for d in drones if d.port is None}
        self.packets = 0
        self.unknown_packets = 0
        self.unknown_senders: dict[str, int] = {}

    def route(self, addr: tuple) -> Optional[str]:
        ip, port = addr[0], addr[1]
        return self._by_addr.get((ip, port)) or self._by_ip.get(ip)

    def handle(self, data: bytes, addr: tuple) -> Optional[str]:
        """Route one datagram. Returns the drone id, or None if the sender is unknown."""
        self.packets += 1
        did = self.route(addr)
        if did is None:
            self.unknown_packets += 1
            key = f"{addr[0]}:{addr[1]}"
            if key in self.unknown_senders or len(self.unknown_senders) < self.MAX_UNKNOWN_TRACKED:
                if key not in self.unknown_senders:
                    log.warning("dropping video from unknown sender %s", key)
                self.unknown_senders[key] = self.unknown_senders.get(key, 0) + 1
            return None
        self.decoders[did].feed(data)
        return did

    def drone_stats(self, drone_id: str) -> dict:
        return self.decoders[drone_id].stats()

    def stats(self) -> dict:
        return {
            "kind": self.kind,
            "packets": self.packets,
            "unknown_packets": self.unknown_packets,
            "unknown_senders": dict(self.unknown_senders),
            "frames_decoded": sum(d.frames_decoded for d in self.decoders.values()),
            "decode_errors": sum(d.decode_errors for d in self.decoders.values()),
            "drones": {d.id: d.address for d in self.drones},
            "error": self.error,
        }

    def run(self) -> None:
        try:
            sock = _open_udp_socket(self.host, self.port)
        except OSError as e:
            self.error = f"bind {self.host}:{self.port} failed: {e}"
            log.error(self.error)
            return
        log.info("listening for H.264 from %d drones on udp://%s:%d (%s; no commands are sent)",
                 len(self.drones), self.host, self.port,
                 ", ".join(f"{d.id}={d.address}" for d in self.drones))
        while not self.stopped:
            try:
                data, addr = sock.recvfrom(65536)
            except socket.timeout:
                continue
            except OSError as e:
                self.error = f"recv failed: {e}"
                log.error(self.error)
                break
            self.handle(data, addr)
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

"""The simulated Tello's video: rendered frames as raw H.264, split like the real stream.

The Tello sends raw H.264 (no container, no RTP) in datagrams of at most 1460 bytes to port
11111. metoera-vision parses whatever arrives, so the split does not have to follow NAL units.
A keyframe, with its SPS and PPS, comes every second, so a receiver can join at any time.

The colour conversion to YUV 4:2:0 runs on the GPU (rgb_to_yuv420p): done by swscale on the
CPU it took 14 ms a frame, more than rendering and encoding together.
"""

from __future__ import annotations

from fractions import Fraction
from typing import Iterator, Optional

import numpy as np

DATAGRAM = 1460
FPS = 30
ENCODERS = (  # name, options; the first that opens is used
    ("libx264", {"preset": "ultrafast", "tune": "zerolatency"}),
    ("h264_nvenc", {"preset": "p1", "tune": "ll", "zerolatency": "1"}),
    ("h264_mf", {}),
)


class H264Encoder:
    def __init__(self, width: int, height: int, fps: int = FPS, bit_rate: int = 2_500_000, codec: Optional[str] = None) -> None:
        import av

        errors = []
        for name, options in ENCODERS:
            if codec and name != codec:
                continue
            try:
                ctx = av.CodecContext.create(name, "w")
                ctx.width, ctx.height, ctx.pix_fmt = width, height, "yuv420p"
                ctx.time_base = Fraction(1, fps)
                ctx.framerate = Fraction(fps, 1)
                ctx.gop_size = fps  # a keyframe every second
                ctx.max_b_frames = 0
                ctx.bit_rate = bit_rate
                ctx.options = dict(options)
                ctx.open()
            except Exception as e:  # noqa: BLE001 - try the next encoder
                errors.append(f"{name}: {e}")
                continue
            self.ctx, self.name = ctx, name
            break
        else:
            raise RuntimeError("no H.264 encoder: " + "; ".join(errors))
        self._av = av
        self._n = 0

    def encode(self, image: np.ndarray) -> bytes:
        """One frame in, its H.264 bytes (Annex B) out. `image` is planar YUV 4:2:0
        [H*3/2, W] (from rgb_to_yuv420p), or HxWx3 RGB (converted on the CPU, slower)."""
        if image.ndim == 2:
            frame = self._av.VideoFrame.from_ndarray(np.ascontiguousarray(image), format="yuv420p")
        else:
            frame = self._av.VideoFrame.from_ndarray(np.ascontiguousarray(image), format="rgb24").reformat(format="yuv420p")
        frame.pts = self._n
        self._n += 1
        return b"".join(bytes(p) for p in self.ctx.encode(frame))


def rgb_to_yuv420p(rgb) -> np.ndarray:
    """HxWx3 RGB tensor in 0..1 (any device) to planar YUV 4:2:0 [H*3/2, W] uint8, BT.601
    limited range: what swscale makes by default, and what decoders assume."""
    h, w = rgb.shape[:2]
    r, g, b = (rgb.float() * 255).unbind(-1)
    y = 16 + 0.257 * r + 0.504 * g + 0.098 * b
    u = 128 - 0.148 * r - 0.291 * g + 0.439 * b
    v = 128 + 0.439 * r - 0.368 * g - 0.071 * b
    u = u.reshape(h // 2, 2, w // 2, 2).mean((1, 3))
    v = v.reshape(h // 2, 2, w // 2, 2).mean((1, 3))
    planes = [y.flatten(), u.flatten(), v.flatten()]
    import torch

    return torch.cat(planes).round().clamp(0, 255).to(torch.uint8).reshape(h * 3 // 2, w).cpu().numpy()


def datagrams(data: bytes, size: int = DATAGRAM) -> Iterator[bytes]:
    for i in range(0, len(data), size):
        yield data[i:i + size]

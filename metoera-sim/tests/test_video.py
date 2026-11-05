"""The video path: colour conversion, H.264 encoding, and joining the stream mid-way (CPU only)."""

import av
import numpy as np
import torch

from metoera_sim.video import DATAGRAM, H264Encoder, datagrams, rgb_to_yuv420p


def picture(i: int, w: int = 320, h: int = 240) -> np.ndarray:
    img = np.zeros((h, w, 3), np.uint8)
    img[:, : w // 2] = (200, 30, 30)  # red left half
    img[:, w // 2 :] = (30, 60, 200)  # blue right half
    img[h // 3 : h // 3 + 20, (i * 4) % w : (i * 4) % w + 20] = 255  # a white square moving right
    return img


def test_yuv_matches_swscale():
    rgb = picture(0)
    ours = rgb_to_yuv420p(torch.from_numpy(rgb).float() / 255)
    theirs = av.VideoFrame.from_ndarray(rgb, format="rgb24").reformat(format="yuv420p").to_ndarray()
    assert ours.shape == theirs.shape == (360, 320)
    d = np.abs(ours.astype(int) - theirs.astype(int))
    assert d[:240].max() <= 1  # brightness: the same
    # colour: the same except right at sharp edges, where swscale places its samples a little differently
    assert np.percentile(d[240:], 99) <= 1 and d.mean() < 0.1


def test_a_receiver_can_join_mid_stream():
    enc = H264Encoder(320, 240, codec="libx264")
    stream = b"".join(enc.encode(rgb_to_yuv420p(torch.from_numpy(picture(i)).float() / 255)) for i in range(45))
    keyframe = stream.find(b"\x00\x00\x00\x01\x67", 10)  # the second SPS: the keyframe one second in
    assert keyframe > 0
    dec = av.CodecContext.create("h264", "r")
    frames = []
    chunks = list(datagrams(stream[keyframe:]))
    assert max(len(c) for c in chunks) <= DATAGRAM
    for chunk in chunks:
        for packet in dec.parse(chunk):
            frames += dec.decode(packet)
    assert len(frames) >= 10
    rgb = frames[-1].to_ndarray(format="rgb24")
    left, right = rgb[200, 40].astype(int), rgb[200, 280].astype(int)
    assert left[0] > 150 and left[2] < 80  # still red
    assert right[2] > 150 and right[0] < 80  # still blue

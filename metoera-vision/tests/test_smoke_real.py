"""Real-model smoke tests. They use the actual YOLO weights (downloaded on first run)
and, for the UDP test, ffmpeg to replay a raw H.264 stream like the Tello's."""

import shutil
import socket
import subprocess
import time
from pathlib import Path

import pytest

from metoera_vision.frames import LatestFrame
from metoera_vision.sources import FileSource, UdpH264Source

ROOT = Path(__file__).resolve().parent.parent
pytestmark = pytest.mark.smoke


def bus_jpg() -> Path:
    import ultralytics

    return Path(ultralytics.__file__).parent / "assets" / "bus.jpg"


@pytest.fixture(scope="module")
def yolo():
    from metoera_vision.detect import YoloDetector

    return YoloDetector("yolo11n.pt")


def test_real_model_on_sample_image(yolo):
    import cv2

    from metoera_vision.detect import build_result, find_best

    img = cv2.imread(str(bus_jpg()))
    h, w = img.shape[:2]
    r = build_result(yolo.detect(img), w, h)
    labels = [o["label"] for o in r["objects"]]
    assert "person" in labels and "bus" in labels
    assert find_best(r, "bus")["confidence"] > 0.5


def _free_udp_port() -> int:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")
def test_udp_h264_ingest_end_to_end(yolo, tmp_path):
    """Stream the bus image as raw H.264 over UDP in 1460-byte datagrams (Tello-like),
    starting mid-stream garbage included, and check we decode 960x720 frames and detect."""
    from metoera_vision.service import VisionService

    port = _free_udp_port()
    lf = LatestFrame()
    src = UdpH264Source(lf, "127.0.0.1", port)
    svc = VisionService(src, yolo, lf, detect_fps=5)
    svc.start()
    time.sleep(0.2)
    # Prepend junk datagrams to mimic start-of-stream garbage.
    junk = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    for _ in range(5):
        junk.sendto(b"\x00\x00\x01\x41" + bytes(range(256)) * 5, ("127.0.0.1", port))
    junk.close()
    ff = subprocess.Popen([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-re", "-loop", "1", "-t", "4", "-i", str(bus_jpg()),
        "-vf", "scale=960:720", "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-g", "15",
        "-pix_fmt", "yuv420p", "-r", "30", "-f", "h264", f"udp://127.0.0.1:{port}?pkt_size=1460"])
    try:
        deadline = time.time() + 15
        res = None
        while time.time() < deadline:
            res = svc.latest_result()
            if res and res["objects"]:
                break
            time.sleep(0.1)
    finally:
        ff.wait(timeout=20)
        svc.stop()
    assert src.packets > 10
    assert src.frames_decoded > 5
    assert res is not None and res["frame_size"] == [960, 720]
    assert any(o["label"] == "person" for o in res["objects"])


def test_file_source_plays_video(tmp_path):
    sample = ROOT / "samples" / "sample.mp4"
    if not sample.exists():
        pytest.skip("run scripts/make_sample.sh first")
    lf = LatestFrame()
    src = FileSource(lf, str(sample), loop=False)
    src.start()
    f = lf.wait_newer(0, timeout=5)
    time.sleep(0.5)
    src.stop()
    assert f is not None and f.size == (960, 720)
    assert lf.fps_in > 10  # paced near 30 fps


def test_two_drones_replayed_on_one_port(yolo):
    """Replay samples/sample.h264 from two source ports to one UDP port at the same time
    (scripts/replay_udp_multi.py); both drones must decode and get real detections."""
    import sys

    from metoera_vision.service import Channel, VisionService
    from metoera_vision.sources import MultiDroneUdpSource, parse_drones

    sample = ROOT / "samples" / "sample.h264"
    if not sample.exists():
        pytest.skip("run scripts/make_sample.sh first")
    port, pa, pb = _free_udp_port(), _free_udp_port(), _free_udp_port()
    drones = parse_drones(f"tello=127.0.0.1:{pa},rmtt=127.0.0.1:{pb}")
    sinks = {d.id: LatestFrame() for d in drones}
    src = MultiDroneUdpSource(drones, sinks, "127.0.0.1", port)
    chans = [Channel(d.id, sinks[d.id], stats=lambda i=d.id: src.drone_stats(i)) for d in drones]
    svc = VisionService(src, yolo, detect_fps=5, channels=chans)
    svc.start()
    time.sleep(0.2)
    sender = subprocess.Popen([sys.executable, str(ROOT / "scripts" / "replay_udp_multi.py"),
                               "--from", f"127.0.0.1:{pa}", "--from", f"127.0.0.1:{pb}",
                               "--to", f"127.0.0.1:{port}", "--duration", "6"])
    try:
        time.sleep(4.5)
        h = svc.health()
        res = {d.id: svc.latest_result(d.id) for d in drones}
    finally:
        sender.wait(timeout=20)
        svc.stop()
    for did in ("tello", "rmtt"):
        dh = h["drones"][did]
        assert dh["ok"], dh
        assert dh["frame_size"] == [960, 720]
        assert dh["fps_in"] > 15 and 3.0 <= dh["fps_detect"] <= 6.0, dh
        assert res[did] is not None and res[did]["drone"] == did and res[did]["objects"]
    assert src.unknown_packets == 0

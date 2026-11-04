import json
import threading
import time
import urllib.request

import numpy as np
import pytest

from metoera_vision.frames import LatestFrame
from metoera_vision.server import make_server
from metoera_vision.service import VisionService


def tagged(v: int) -> np.ndarray:
    img = np.zeros((72, 96, 3), dtype=np.uint8)
    img[0, 0, 0] = v
    return img


def test_latest_frame_keeps_only_newest():
    lf = LatestFrame()
    for i in range(1, 11):
        lf.put(tagged(i))
    f = lf.get()
    assert f.seq == 10 and f.image[0, 0, 0] == 10
    assert lf.dropped == 9  # 9 frames were overwritten unread
    assert lf.wait_newer(10, timeout=0.05) is None  # nothing newer
    lf.put(tagged(11))
    assert lf.wait_newer(10, timeout=0.05).seq == 11


def test_detection_loop_skips_backlog(stub):
    """A slow detector fed by a fast producer only ever sees recent frames, never a queue."""
    stub.delay = 0.05
    lf = LatestFrame()
    svc = VisionService(None, stub, lf, detect_fps=100)
    svc.start()
    stop = threading.Event()

    def producer():
        i = 0
        while not stop.is_set() and i < 250:
            i += 1
            lf.put(tagged(i))
            time.sleep(0.002)

    t = threading.Thread(target=producer)
    t.start()
    t.join()
    time.sleep(0.15)
    stop.set()
    svc.stop()
    produced = 250
    assert len(stub.seen) < produced / 3  # far fewer inferences than frames
    assert stub.seen == sorted(stub.seen)  # strictly forward in time
    assert max(stub.seen) >= produced - 5  # caught up to (nearly) the newest frame
    assert lf.dropped > produced / 2


@pytest.fixture
def api(stub):
    lf = LatestFrame()
    svc = VisionService(None, stub, lf, detect_fps=20)
    svc.start()
    srv = make_server(svc, "127.0.0.1", 0, ["http://localhost:18787"])
    th = threading.Thread(target=srv.serve_forever, daemon=True)
    th.start()
    base = f"http://127.0.0.1:{srv.server_address[1]}"
    yield base, lf, svc
    srv.shutdown()
    svc.stop()


def get(url, headers=None):
    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(req, timeout=5) as r:
        return r.status, dict(r.headers), r.read()


def test_api_endpoints_with_stub(api):
    base, lf, svc = api
    st, _, body = get(base + "/detections")
    assert json.loads(body)["objects"] == []

    lf.put(np.zeros((720, 960, 3), dtype=np.uint8))
    deadline = time.time() + 3
    while svc.latest_result() is None and time.time() < deadline:
        time.sleep(0.02)

    st, hdr, body = get(base + "/detections", {"Origin": "http://localhost:18787"})
    d = json.loads(body)
    assert st == 200 and hdr["Access-Control-Allow-Origin"] == "http://localhost:18787"
    assert d["frame_size"] == [960, 720]
    assert d["objects"][0]["box"] == {"x": 0.1, "y": 0.1, "w": 0.2, "h": 0.5}

    st, _, body = get(base + "/find?label=bottle")
    f = json.loads(body)
    assert f["match"]["label"] == "bottle" and f["match"]["position"] == "lower right"
    st, _, body = get(base + "/find?label=unicorn")
    assert json.loads(body)["match"] is None

    st, _, body = get(base + "/health")
    h = json.loads(body)
    for k in ("ok", "source", "fps_in", "fps_detect", "last_frame_age_ms", "model"):
        assert k in h
    assert h["model"] == "stub" and h["last_frame_age_ms"] is not None

    st, hdr, body = get(base + "/frame.jpg")
    assert hdr["Content-Type"] == "image/jpeg" and body[:2] == b"\xff\xd8"

    # MJPEG: read the first part only
    with urllib.request.urlopen(base + "/stream", timeout=5) as r:
        assert r.headers["Content-Type"].startswith("multipart/x-mixed-replace")
        chunk = r.read(200)
        assert b"--metoeraframe" in chunk and b"image/jpeg" in chunk


def test_cors_preflight(api):
    base, _, _ = api
    req = urllib.request.Request(base + "/detections", method="OPTIONS",
                                 headers={"Origin": "http://localhost:18787"})
    with urllib.request.urlopen(req, timeout=5) as r:
        assert r.status == 204
        assert r.headers["Access-Control-Allow-Origin"] == "http://localhost:18787"


def test_find_requires_label(api):
    base, _, _ = api
    with pytest.raises(urllib.error.HTTPError) as e:
        get(base + "/find")
    assert e.value.code == 400

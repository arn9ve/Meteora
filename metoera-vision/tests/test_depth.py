"""/depth with a stub depth model: geometry, box/column statistics, caching, routing, errors."""

import json
import threading
import time
import urllib.error
import urllib.request

import numpy as np
import pytest

from metoera_vision.depth import (DepthEngine, bearing_deg, box_depth, build_depth_result, column_depths,
                                  focal_px)
from metoera_vision.frames import LatestFrame
from metoera_vision.server import make_server
from metoera_vision.service import Channel, DepthUnavailable, VisionService


class StubDepth:
    """Depth = 1 m at the left edge rising linearly to 10 m at the right edge; counts calls."""

    name = "stub-depth"
    device = "cpu"

    def __init__(self, delay=0.0):
        self.calls = 0
        self.delay = delay

    def predict(self, image):
        self.calls += 1
        if self.delay:
            time.sleep(self.delay)
        h, w = image.shape[:2]
        row = np.linspace(1.0, 10.0, w, dtype=np.float32)
        return np.tile(row, (h, 1))


def engine(model=None):
    m = model or StubDepth()
    return DepthEngine(lambda: m, "stub-depth", "cpu"), m


# ---- pure geometry / statistics ------------------------------------------------------------

def test_bearings_and_focal():
    assert bearing_deg(0.5) == 0
    assert bearing_deg(1.0) == pytest.approx(35.0)
    assert bearing_deg(0.0) == pytest.approx(-35.0)
    assert bearing_deg(0.75) == pytest.approx(-bearing_deg(0.25))
    # pinhole, not linear: a quarter of the way in is less than half the half-FOV
    assert 19 < bearing_deg(0.75) < 19.5
    assert focal_px(960) == pytest.approx(685.5, abs=1)


def test_columns_bearings_and_band():
    d = np.full((720, 960), 5.0, dtype=np.float32)
    d[: int(0.35 * 720) - 1] = 0.4  # ceiling: outside the band
    d[int(0.80 * 720) + 1:] = 0.3  # floor: outside the band
    d[300:400, 0:40] = 1.2  # an obstacle in the first column
    cols = column_depths(d)
    assert len(cols) == 24
    xs = [c["x"] for c in cols]
    assert xs == sorted(xs) and xs[0] == pytest.approx(1 / 48, abs=1e-3) and xs[-1] == pytest.approx(47 / 48, abs=1e-3)
    bs = [c["bearing_deg"] for c in cols]
    assert bs == sorted(bs) and bs[0] < -30 and bs[-1] > 30
    assert bs[0] == pytest.approx(-bs[-1]) and bs[11] == pytest.approx(-bs[12])
    assert cols[0]["depth_m"] == pytest.approx(1.2)  # 10th percentile catches the near obstacle
    assert all(c["depth_m"] == pytest.approx(5.0) for c in cols[1:])  # floor/ceiling ignored


def test_box_depth_uses_the_centre_of_the_box():
    d = np.full((720, 960), 9.0, dtype=np.float32)  # background
    # box 200..400 x 100..500 px; its inner 50% w x 60% h is 250..350 x 180..420
    d[100:500, 200:400] = 6.0  # box edges (e.g. floor at the feet, wall beside the head)
    d[180:420, 250:350] = 2.0
    d[180:200, 250:350] = 2.4  # some variation inside the core
    box = {"x": 200 / 960, "y": 100 / 720, "w": 200 / 960, "h": 400 / 720}
    med, iqr = box_depth(d, box)
    assert med == pytest.approx(2.0)
    assert 0 <= iqr < 0.5
    # a degenerate box still yields a value
    med, _ = box_depth(d, {"x": 300 / 960, "y": 300 / 720, "w": 0.0, "h": 0.0})
    assert med == pytest.approx(2.0)
    # NaN/inf/zero are ignored
    d2 = np.full((10, 10), np.nan, dtype=np.float32)
    assert box_depth(d2, {"x": 0, "y": 0, "w": 1, "h": 1}) == (None, None)


def test_build_depth_result_shape():
    d = StubDepth().predict(np.zeros((720, 960, 3), np.uint8))
    det = {"objects": [{"label": "person", "confidence": 0.9, "box": {"x": 0.0, "y": 0.2, "w": 0.2, "h": 0.6},
                        "center": {"x": 0.1, "y": 0.5}}]}
    r = build_depth_result(d, det, timestamp=123.0, inference_ms=12.34, model="m")
    assert r["frame_size"] == [960, 720] and r["inference_ms"] == 12.3 and r["model"] == "m"
    assert r["timestamp"] == 123.0 and "optical axis" in r["note"]
    o = r["objects"][0]
    assert set(o) >= {"label", "confidence", "box", "center", "depth_m", "depth_spread_m", "bearing_deg"}
    assert o["depth_m"] == pytest.approx(1.9, abs=0.05)  # depth at x=0.1 in the 1..10 m ramp
    assert len(r["columns"]) == 24
    assert r["columns"][0]["depth_m"] < r["columns"][-1]["depth_m"]


# ---- through the service and HTTP --------------------------------------------------------------

def get(url):
    with urllib.request.urlopen(url, timeout=5) as r:
        return r.status, json.loads(r.read())


def get_err(url):
    with pytest.raises(urllib.error.HTTPError) as e:
        get(url)
    return e.value.code, json.loads(e.value.read())


def tagged(v, w=960, h=720):
    img = np.zeros((h, w, 3), dtype=np.uint8)
    img[0, 0, 0] = v
    return img


def wait_for(cond, timeout=3.0):
    deadline = time.time() + timeout
    while not cond() and time.time() < deadline:
        time.sleep(0.02)
    assert cond()


def serve(svc):
    srv = make_server(svc, "127.0.0.1", 0, ["*"])
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"http://127.0.0.1:{srv.server_address[1]}"


@pytest.fixture
def multi(stub):
    eng, model = engine()
    fa, fb = LatestFrame(), LatestFrame()
    svc = VisionService(None, stub, detect_fps=20, depth=eng,
                        channels=[Channel("tello", fa), Channel("rmtt", fb)])
    svc.start()
    srv, base = serve(svc)
    yield base, svc, fa, fb, model
    srv.shutdown()
    svc.stop()


def test_depth_per_drone(multi):
    base, svc, fa, fb, model = multi
    fa.put(tagged(1))
    wait_for(lambda: svc.latest_result("tello") is not None)
    code, d = get(base + "/depth?drone=tello")
    assert code == 200 and d["drone"] == "tello" and d["cached"] is False
    assert d["frame_size"] == [960, 720] and d["model"] == "stub-depth" and d["inference_ms"] >= 0
    # depth ran on the frame the YOLO result came from
    assert d["frame_seq"] == d["detection_frame_seq"] == svc.latest_result("tello")["frame_seq"]
    assert "detect_ms" not in d
    labels = [o["label"] for o in d["objects"]]
    assert labels == [o["label"] for o in svc.latest_result("tello")["objects"]]
    person = d["objects"][0]  # stub box 96..288 px wide -> centre x=0.2 -> ~2.8 m on the ramp
    assert person["label"] == "person" and person["depth_m"] == pytest.approx(2.8, abs=0.1)
    assert person["bearing_deg"] < 0
    assert len(d["columns"]) == 24 and all(c["depth_m"] is not None for c in d["columns"])
    assert model.calls == 1

    # other drone has no frame yet
    code, e = get_err(base + "/depth?drone=rmtt")
    assert code == 503 and "no frame" in e["error"] and e["drone"] == "rmtt"

    h = get(base + "/health")[1]
    assert h["depth"]["loaded"] is True and h["depth"]["device"] == "cpu" and h["depth"]["last_ms"] is not None
    assert get(base + "/health?drone=tello")[1]["depth"]["enabled"] is True


def test_depth_cache(multi):
    base, svc, fa, fb, model = multi
    svc.depth_cache_s = 0.15
    fa.put(tagged(1))
    wait_for(lambda: svc.latest_result("tello") is not None)
    first = get(base + "/depth?drone=tello")[1]
    again = get(base + "/depth?drone=tello")[1]
    assert again["cached"] is True and again["frame_seq"] == first["frame_seq"] and model.calls == 1
    # past the time window but still the same frame: still reused
    time.sleep(0.2)
    assert get(base + "/depth?drone=tello")[1]["cached"] is True and model.calls == 1
    # a new frame (and its detection) past the window: computed again
    fa.put(tagged(2))
    wait_for(lambda: svc.latest_result("tello")["frame_seq"] == 2)
    d = get(base + "/depth?drone=tello")[1]
    assert d["cached"] is False and d["frame_seq"] == 2 and model.calls == 2
    # caches are per drone
    fb.put(tagged(3))
    wait_for(lambda: svc.latest_result("rmtt") is not None)
    assert get(base + "/depth?drone=rmtt")[1]["cached"] is False and model.calls == 3


def test_depth_concurrent_calls_compute_once(multi):
    base, svc, fa, fb, _ = multi
    slow = StubDepth(delay=0.1)
    svc.depth = engine(slow)[0]
    fa.put(tagged(1))
    wait_for(lambda: svc.latest_result("tello") is not None)
    out = []
    ts = [threading.Thread(target=lambda: out.append(get(base + "/depth?drone=tello")[1])) for _ in range(4)]
    for t in ts:
        t.start()
    for t in ts:
        t.join()
    assert len(out) == 4 and slow.calls == 1
    assert sum(not d["cached"] for d in out) == 1


def test_depth_routing_errors(multi):
    base = multi[0]
    code, e = get_err(base + "/depth")
    assert code == 400 and e["drones"] == ["tello", "rmtt"]
    code, e = get_err(base + "/depth?drone=nope")
    assert code == 404 and e["error"] == "unknown drone"


def test_depth_disabled_is_503(stub):
    fa = LatestFrame()
    svc = VisionService(None, stub, detect_fps=20, channels=[Channel("tello", fa)])  # depth=None
    srv, base = serve(svc)
    try:
        fa.put(tagged(1))
        code, e = get_err(base + "/depth?drone=tello")
        assert code == 503 and "disabled" in e["error"] and e["depth"]["enabled"] is False
        h = get(base + "/health")[1]
        assert h["depth"] == {"enabled": False, "loaded": False, "device": None, "last_ms": None}
        code, _ = get_err(base + "/depth?drone=nope")
        assert code == 404
    finally:
        srv.shutdown()


def test_depth_load_failure_is_503(stub):
    def broken():
        raise OSError("no network")
    lf = LatestFrame()
    svc = VisionService(None, stub, lf, depth=DepthEngine(broken, "x", "cpu"))
    lf.put(tagged(1))
    with pytest.raises(DepthUnavailable, match="no network"):
        svc.depth_result()
    assert svc.depth_health()["error"].startswith("OSError")


def test_single_source_depth_runs_yolo_when_no_result_yet(stub):
    """Detection loop not started: /depth detects on the newest frame itself."""
    eng, model = engine()
    lf = LatestFrame()
    svc = VisionService(None, stub, lf, depth=eng)
    srv, base = serve(svc)
    try:
        code, e = get_err(base + "/depth")
        assert code == 503
        lf.put(tagged(7))
        d = get(base + "/depth")[1]
        assert "drone" not in d and d["frame_seq"] == 1 and "detect_ms" in d
        assert len(d["objects"]) == 3 and stub.seen == [7]
        assert svc.latest_result()["frame_seq"] == 1  # the detection is published too
        code, _ = get_err(base + "/depth?drone=tello")
        assert code == 404
    finally:
        srv.shutdown()


def test_stale_detection_is_redone_on_newest_frame(stub):
    eng, _ = engine()
    lf = LatestFrame()
    svc = VisionService(None, stub, lf, depth=eng, depth_max_result_lag_s=0.5)
    svc.process(lf.put(tagged(1), t=100.0))
    lf.put(tagged(2), t=101.0)  # detection loop stalled for a second
    d = svc.depth_result()
    assert d["frame_seq"] == 2 and d["detection_frame_seq"] == 2 and "detect_ms" in d
    lf.put(tagged(3), t=101.2)  # within the lag: depth stays on the detected frame (after cache expiry)
    svc.depth_cache_s = 0
    d = svc.depth_result()
    assert d["frame_seq"] == 2 and d["cached"] is True  # same frame -> cached


def test_cli_flags():
    from metoera_vision.__main__ import parse_args

    a = parse_args(["--no-depth"])
    assert a.no_depth is True
    a = parse_args([])
    assert a.no_depth is False and a.depth_model.endswith("Metric-Indoor-Small-hf") and a.depth_device == "auto"

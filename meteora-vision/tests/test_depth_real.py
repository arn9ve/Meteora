"""Real Depth Anything V2 Metric Indoor + YOLO on samples/bus.jpg (downloads ~99 MB once into .hf-cache/)."""

import time
from pathlib import Path

import pytest

from meteora_vision.frames import LatestFrame
from meteora_vision.service import VisionService

ROOT = Path(__file__).resolve().parent.parent
pytestmark = pytest.mark.smoke


def test_real_depth_on_bus_jpg(capsys):
    import cv2

    from meteora_vision.depth import DepthEngine
    from meteora_vision.detect import YoloDetector

    img = cv2.imread(str(ROOT / "samples" / "bus.jpg"))
    if img is None:
        pytest.skip("samples/bus.jpg missing")
    eng = DepthEngine.huggingface()
    t0 = time.perf_counter()
    eng.load()
    load_s = time.perf_counter() - t0
    lf = LatestFrame()
    svc = VisionService(None, YoloDetector("yolo11n.pt"), lf, depth=eng, depth_cache_s=0)
    svc.process(lf.put(img))
    first = svc.depth_result()
    warm = []
    for i in range(5):
        svc.process(lf.put(img))  # new frame each time: no cache
        d = svc.depth_result()
        assert d["cached"] is False
        warm.append(d["inference_ms"])

    people = [o for o in first["objects"] if o["label"] == "person"]
    assert len(people) >= 3
    for o in people:
        assert 0.5 <= o["depth_m"] <= 15, o
    # the people in bus.jpg stand a few metres from the camera
    assert 1.5 <= sorted(o["depth_m"] for o in people)[len(people) // 2] <= 8
    cols = [c["depth_m"] for c in first["columns"]]
    assert len(cols) == 24 and all(0.3 <= c <= 20 for c in cols)
    with capsys.disabled():
        print(f"\n[depth] device={eng.health()['device']} load+warmup={load_s:.1f}s "
              f"first={first['inference_ms']}ms warm={sorted(warm)}ms")
        print("[depth] " + ", ".join(f"{o['label']}={o['depth_m']}m±{o['depth_spread_m']}" for o in first["objects"]))

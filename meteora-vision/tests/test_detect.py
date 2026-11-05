import numpy as np

from meteora_vision.detect import RawBox, annotate, build_result, describe_position, find_best


def test_result_shape_and_normalization():
    boxes = [RawBox(96, 72, 288, 432, 0.91234, "person"), RawBox(480, 360, 960, 720, 0.5, "dog")]
    r = build_result(boxes, 960, 720, timestamp=123.0)
    assert set(r) >= {"timestamp", "frame_size", "objects"}
    assert r["timestamp"] == 123.0
    assert r["frame_size"] == [960, 720]
    p = r["objects"][0]
    assert set(p) == {"label", "confidence", "box", "center"}
    assert p["label"] == "person"
    assert p["confidence"] == 0.9123
    assert p["box"] == {"x": 0.1, "y": 0.1, "w": 0.2, "h": 0.5}
    assert p["center"] == {"x": 0.2, "y": 0.35}
    d = r["objects"][1]
    assert d["box"] == {"x": 0.5, "y": 0.5, "w": 0.5, "h": 0.5}
    assert d["center"] == {"x": 0.75, "y": 0.75}


def test_values_clamped_to_unit_range_and_sorted():
    boxes = [RawBox(-20, -10, 1000, 800, 0.3, "car"), RawBox(10, 10, 20, 20, 0.9, "cup")]
    r = build_result(boxes, 960, 720)
    assert [o["label"] for o in r["objects"]] == ["cup", "car"]  # by confidence
    for o in r["objects"]:
        for v in (*o["box"].values(), *o["center"].values()):
            assert 0.0 <= v <= 1.0
    car = r["objects"][1]
    assert car["box"] == {"x": 0.0, "y": 0.0, "w": 1.0, "h": 1.0}


def test_empty_result():
    r = build_result([], 640, 480)
    assert r["objects"] == [] and r["frame_size"] == [640, 480]


def test_find_best_picks_highest_confidence(stub):
    r = build_result(stub.boxes, 960, 720)
    m = find_best(r, "Person")
    assert m["label"] == "person" and m["confidence"] == 0.91
    assert m["count"] == 2
    assert m["position"] == "left"
    assert find_best(r, "giraffe") is None
    assert find_best(None, "person") is None
    assert find_best(r, "") is None


def test_find_min_confidence_and_substring():
    r = build_result([RawBox(0, 0, 10, 10, 0.3, "cell phone")], 100, 100)
    assert find_best(r, "phone")["label"] == "cell phone"
    assert find_best(r, "phone", min_confidence=0.5) is None


def test_find_prefers_exact_match():
    r = build_result([RawBox(0, 0, 10, 10, 0.9, "wine glass"), RawBox(0, 0, 10, 10, 0.4, "glass")], 100, 100)
    assert find_best(r, "glass")["label"] == "glass"


def test_describe_position():
    assert describe_position({"x": 0.5, "y": 0.5}) == "center"
    assert describe_position({"x": 0.9, "y": 0.1}) == "upper right"
    assert describe_position({"x": 0.5, "y": 0.9}) == "lower center"


def test_annotate_draws_without_mutating_input():
    img = np.zeros((720, 960, 3), dtype=np.uint8)
    r = build_result([RawBox(96, 72, 288, 432, 0.9, "person")], 960, 720)
    out = annotate(img, r)
    assert out.shape == img.shape
    assert img.sum() == 0
    assert out.sum() > 0

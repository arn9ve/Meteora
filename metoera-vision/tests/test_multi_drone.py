"""Several drones on one UDP port: sender routing, per-drone API, fair detection loop."""

import json
import socket
import threading
import time
import urllib.error
import urllib.request
from fractions import Fraction

import numpy as np
import pytest

from metoera_vision.frames import LatestFrame
from metoera_vision.server import make_server
from metoera_vision.service import Channel, VisionService
from metoera_vision.sources import DroneSpec, MultiDroneUdpSource, parse_drones


# ---- config parsing ------------------------------------------------------------

def test_parse_drones():
    ds = parse_drones("tello=192.168.5.137, rmtt=192.168.5.68")
    assert ds == [DroneSpec("tello", "192.168.5.137"), DroneSpec("rmtt", "192.168.5.68")]
    ds = parse_drones("a=127.0.0.1:50001,b=127.0.0.1:50002")
    assert [(d.id, d.ip, d.port) for d in ds] == [("a", "127.0.0.1", 50001), ("b", "127.0.0.1", 50002)]
    for bad in ("", "tello", "=1.2.3.4", "a=1.2.3.4,a=1.2.3.5", "a=nothost", "a=1.2.3.4:99999",
                "a=1.2.3.4,b=1.2.3.4", "a b=1.2.3.4"):
        with pytest.raises(ValueError):
            parse_drones(bad)


def test_route_by_ip_and_by_ip_port():
    drones = parse_drones("tello=192.168.5.137,a=127.0.0.1:50001,b=127.0.0.1:50002")
    src = MultiDroneUdpSource(drones, {d.id: LatestFrame() for d in drones}, "127.0.0.1", 0)
    assert src.route(("192.168.5.137", 11111)) == "tello"
    assert src.route(("192.168.5.137", 40000)) == "tello"  # ip-only entry: any source port
    assert src.route(("127.0.0.1", 50001)) == "a"
    assert src.route(("127.0.0.1", 50002)) == "b"
    assert src.route(("127.0.0.1", 50003)) is None  # ip:port entries need both to match
    assert src.route(("192.168.5.68", 11111)) is None
    assert src.handle(b"junk", ("10.0.0.9", 1234)) is None
    assert src.unknown_packets == 1 and src.unknown_senders == {"10.0.0.9:1234": 1}
    assert src.decoders["tello"].packets == 0


# ---- real routing over UDP with two synthetic H.264 streams -----------------------

def h264_datagrams(w: int, h: int, n: int, value: int) -> list[bytes]:
    """A raw Annex-B H.264 stream of n flat frames (w x h), cut into 1460-byte datagrams."""
    import av

    enc = av.CodecContext.create("libx264", "w")
    enc.width, enc.height, enc.pix_fmt = w, h, "yuv420p"
    enc.time_base = Fraction(1, 30)
    enc.framerate = 30
    enc.options = {"preset": "ultrafast", "tune": "zerolatency", "g": "10"}
    data = b""
    for i in range(n):
        img = np.full((h, w, 3), value, dtype=np.uint8)
        img[:, : (i * 4) % w] = 255 - value  # some motion
        vf = av.VideoFrame.from_ndarray(img, format="bgr24")
        vf.pts = i
        data += b"".join(bytes(p) for p in enc.encode(vf))
    data += b"".join(bytes(p) for p in enc.encode(None))
    return [data[i:i + 1460] for i in range(0, len(data), 1460)]


def _udp_sock():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.bind(("127.0.0.1", 0))
    return s


def test_two_senders_on_one_port_are_decoded_separately():
    a_sock, b_sock, stranger = _udp_sock(), _udp_sock(), _udp_sock()
    pa, pb, ps = (s.getsockname()[1] for s in (a_sock, b_sock, stranger))
    drones = parse_drones(f"a=127.0.0.1:{pa},b=127.0.0.1:{pb}")
    sinks = {d.id: LatestFrame() for d in drones}
    probe = _udp_sock()
    port = probe.getsockname()[1]
    probe.close()
    src = MultiDroneUdpSource(drones, sinks, "127.0.0.1", port)
    src.start()
    try:
        time.sleep(0.2)
        da = h264_datagrams(320, 240, 40, 40)
        db = h264_datagrams(160, 128, 40, 200)
        # Interleave datagram by datagram: one decoder fed with both would be garbage.
        for i in range(max(len(da), len(db))):
            if i < len(da):
                a_sock.sendto(da[i], ("127.0.0.1", port))
            if i < len(db):
                b_sock.sendto(db[i], ("127.0.0.1", port))
            if i % 5 == 0:
                stranger.sendto(b"\x00\x00\x00\x01\x65" + bytes(500), ("127.0.0.1", port))
            time.sleep(0.001)
        deadline = time.time() + 5
        while time.time() < deadline and (src.decoders["a"].frames_decoded < 30
                                          or src.decoders["b"].frames_decoded < 30):
            time.sleep(0.05)
    finally:
        src.stop()
        src.join(timeout=2)
        for s in (a_sock, b_sock, stranger):
            s.close()

    fa, fb = sinks["a"].get(), sinks["b"].get()
    assert fa is not None and fa.size == (320, 240)
    assert fb is not None and fb.size == (160, 128)
    assert src.decoders["a"].packets == len(da) and src.decoders["b"].packets == len(db)
    assert src.decoders["a"].decode_errors == 0 and src.decoders["b"].decode_errors == 0
    assert src.decoders["a"].frames_decoded >= 30 and src.decoders["b"].frames_decoded >= 30
    assert src.unknown_packets > 0
    st = src.stats()
    assert st["unknown_senders"] == {f"127.0.0.1:{ps}": src.unknown_packets}


# ---- per-drone HTTP API ------------------------------------------------------------

def tagged(v: int, w: int = 96, h: int = 72) -> np.ndarray:
    img = np.zeros((h, w, 3), dtype=np.uint8)
    img[0, 0, 0] = v
    return img


def two_channel_service(stub, detect_fps=20.0):
    fa, fb = LatestFrame(), LatestFrame()
    stats = {"tello": {"decode_errors": 3, "packets": 10, "frames_decoded": 5},
             "rmtt": {"decode_errors": 0, "packets": 7, "frames_decoded": 4}}
    chans = [Channel("tello", fa, stats=lambda: stats["tello"], address="192.168.5.137"),
             Channel("rmtt", fb, stats=lambda: stats["rmtt"], address="192.168.5.68")]
    return VisionService(None, stub, detect_fps=detect_fps, channels=chans), fa, fb


def get(url, headers=None):
    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(req, timeout=5) as r:
        return r.status, dict(r.headers), r.read()


@pytest.fixture
def multi_api(stub):
    svc, fa, fb = two_channel_service(stub)
    svc.start()
    srv = make_server(svc, "127.0.0.1", 0, ["http://localhost:18787"])
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}", fa, fb, svc
    srv.shutdown()
    svc.stop()


def wait_for(cond, timeout=3.0):
    deadline = time.time() + timeout
    while not cond() and time.time() < deadline:
        time.sleep(0.02)
    assert cond()


def test_per_drone_endpoints(multi_api):
    base, fa, fb, svc = multi_api
    _, _, body = get(base + "/detections?drone=rmtt")
    d = json.loads(body)
    assert d["objects"] == [] and d["drone"] == "rmtt"

    fa.put(tagged(1, 960, 720))
    fb.put(tagged(2, 480, 360))
    wait_for(lambda: svc.latest_result("tello") is not None and svc.latest_result("rmtt") is not None)

    _, _, body = get(base + "/detections?drone=tello")
    d = json.loads(body)
    assert d["drone"] == "tello" and d["frame_size"] == [960, 720] and "age_ms" in d
    _, _, body = get(base + "/detections?drone=rmtt")
    d = json.loads(body)
    assert d["drone"] == "rmtt" and d["frame_size"] == [480, 360]
    _, hdr, body = get(base + "/detections?drone=tello", {"Origin": "http://localhost:18787"})
    assert hdr["Access-Control-Allow-Origin"] == "http://localhost:18787"

    _, _, body = get(base + "/find?label=bottle&drone=rmtt")
    f = json.loads(body)
    assert f["drone"] == "rmtt" and f["match"]["label"] == "bottle"
    _, _, body = get(base + "/find?label=person&drone=tello")
    assert json.loads(body)["drone"] == "tello"

    _, _, body = get(base + "/health")
    h = json.loads(body)
    assert h["ok"] is True and set(h["drones"]) == {"tello", "rmtt"}
    # No default drone: nothing at the top level stands for one of them.
    assert "default_drone" not in h and "fps_in" not in h and "frame_size" not in h
    for did, dh in h["drones"].items():
        for k in ("ok", "fps_in", "fps_detect", "last_frame_age_ms", "decode_errors"):
            assert k in dh
        assert dh["last_frame_age_ms"] is not None
    assert h["drones"]["tello"]["decode_errors"] == 3 and h["drones"]["rmtt"]["frame_size"] == [480, 360]
    _, _, body = get(base + "/health?drone=rmtt")
    h1 = json.loads(body)
    assert h1["drone"] == "rmtt" and h1["frame_size"] == [480, 360] and h1["address"] == "192.168.5.68"

    import cv2
    _, hdr, body = get(base + "/frame.jpg?drone=rmtt")
    img = cv2.imdecode(np.frombuffer(body, np.uint8), cv2.IMREAD_COLOR)
    assert hdr["Content-Type"] == "image/jpeg" and img.shape[:2] == (360, 480)
    _, _, body = get(base + "/frame.jpg?drone=tello")
    assert cv2.imdecode(np.frombuffer(body, np.uint8), cv2.IMREAD_COLOR).shape[:2] == (720, 960)

    with urllib.request.urlopen(base + "/stream?drone=rmtt", timeout=5) as r:
        assert r.headers["Content-Type"].startswith("multipart/x-mixed-replace")
        chunk = r.read(200)
        assert b"--metoeraframe" in chunk

    _, _, body = get(base + "/")
    assert b"rmtt" in body and b"tello" in body


def test_health_not_ok_when_one_drone_silent(multi_api):
    base, fa, fb, svc = multi_api
    fa.put(tagged(1))
    wait_for(lambda: svc.latest_result("tello") is not None)
    h = json.loads(get(base + "/health")[2])
    assert h["ok"] is False
    assert h["drones"]["tello"]["ok"] is True and h["drones"]["rmtt"]["ok"] is False
    assert h["drones"]["rmtt"]["last_frame_age_ms"] is None


@pytest.mark.parametrize("path", ["/detections", "/find?label=person", "/frame.jpg", "/stream"])
def test_a_request_without_a_drone_is_400(multi_api, path):
    base = multi_api[0]
    with pytest.raises(urllib.error.HTTPError) as e:
        get(f"{base}{path}")
    assert e.value.code == 400
    body = json.loads(e.value.read())
    assert body["drones"] == ["tello", "rmtt"] and "drone" in body["error"]


def test_the_cli_refuses_a_drone_stream_without_the_drone_list(monkeypatch):
    from metoera_vision.__main__ import main

    monkeypatch.delenv("METOERA_VISION_DRONES", raising=False)
    assert main(["--source", "udp://127.0.0.1:11111"]) == 2  # exits before loading the model


@pytest.mark.parametrize("path", ["/health", "/detections", "/find?label=person", "/frame.jpg", "/stream", "/"])
def test_unknown_drone_is_404(multi_api, path):
    base = multi_api[0]
    sep = "&" if "?" in path else "?"
    with pytest.raises(urllib.error.HTTPError) as e:
        get(f"{base}{path}{sep}drone=nope")
    assert e.value.code == 404
    body = json.loads(e.value.read())
    assert body["error"] == "unknown drone" and body["drones"] == ["tello", "rmtt"]


def test_single_source_rejects_drone_param(stub):
    svc = VisionService(None, stub, LatestFrame(), detect_fps=20)
    srv = make_server(svc, "127.0.0.1", 0, ["*"])
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        base = f"http://127.0.0.1:{srv.server_address[1]}"
        d = json.loads(get(base + "/detections")[2])
        assert "drone" not in d
        assert "drones" not in json.loads(get(base + "/health")[2])
        with pytest.raises(urllib.error.HTTPError) as e:
            get(base + "/detections?drone=tello")
        assert e.value.code == 404
    finally:
        srv.shutdown()


# ---- fairness of the shared detection loop ---------------------------------------------

def run_producers(frames_and_tags, seconds, interval=0.002):
    stop = threading.Event()

    def produce(lf, tag):
        while not stop.is_set():
            lf.put(tagged(tag))
            time.sleep(interval)

    ts = [threading.Thread(target=produce, args=fa, daemon=True) for fa in frames_and_tags]
    for t in ts:
        t.start()
    time.sleep(seconds)
    stop.set()
    for t in ts:
        t.join()


def test_fair_round_robin_when_model_is_the_bottleneck(stub):
    """Model can do ~40/s total, target is 100/s per drone: both drones get an equal share."""
    stub.delay = 0.025
    svc, fa, fb = two_channel_service(stub, detect_fps=100)
    svc.start()
    run_producers([(fa, 1), (fb, 2)], 1.0)
    svc.stop()
    a, b = stub.seen.count(1), stub.seen.count(2)
    assert a > 10 and b > 10
    assert abs(a - b) <= 2, (a, b)
    # strictly alternating while both have new frames
    assert all(x != y for x, y in zip(stub.seen, stub.seen[1:])), stub.seen


def test_each_drone_paced_to_target_fps(stub):
    svc, fa, fb = two_channel_service(stub, detect_fps=5)
    svc.start()
    run_producers([(fa, 1), (fb, 2)], 2.0)
    svc.stop()
    a, b = stub.seen.count(1), stub.seen.count(2)
    # ~5 fps each over 2 s (first one immediate) -> about 10-11 each, not 2x and not starved
    assert 8 <= a <= 12 and 8 <= b <= 12, (a, b)


def test_idle_drone_does_not_slow_the_other(stub):
    stub.delay = 0.01
    svc, fa, fb = two_channel_service(stub, detect_fps=20)
    svc.start()
    run_producers([(fa, 1)], 1.0)
    svc.stop()
    assert stub.seen.count(2) == 0
    assert stub.seen.count(1) >= 15  # close to the 20 fps target
    assert svc.channel("tello").last_seq > 0 and svc.channel("rmtt").detections_run == 0


def test_detects_latest_frame_only_per_drone(stub):
    """Slow model, fast producers: each drone's frames are seen in order and far fewer than produced."""
    stub.delay = 0.03
    svc, fa, fb = two_channel_service(stub, detect_fps=100)
    seqs = {"tello": [], "rmtt": []}
    orig = svc.process

    def spy(frame, channel=None):
        seqs[channel.id].append(frame.seq)
        return orig(frame, channel)

    svc.process = spy
    svc.start()
    run_producers([(fa, 1), (fb, 2)], 0.8)
    svc.stop()
    for did, lf in (("tello", fa), ("rmtt", fb)):
        s = seqs[did]
        assert s == sorted(s) and len(set(s)) == len(s)
        assert len(s) < lf.peek().seq / 3

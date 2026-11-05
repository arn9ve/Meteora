"""Simulated red-zone phones, against a fake red-zone service."""

import json
import math
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import pytest
import torch

from metoera_sim.phones import DETECT_EVERY_S, DWELL_NEED_S, Phones, camera_pose, intrinsics, plausible


class FakeRedzone:
    """Records what the phones post; answers a join with a token and a heartbeat with commands."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict]] = []
        self.commands: list[dict] = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):  # noqa: N802
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])) or b"{}")
                outer.calls.append((self.path, body))
                reply = {"ok": True}
                if self.path.endswith("/join"):
                    reply["token"] = "t0k3n"
                if self.path.endswith("/heartbeat"):
                    reply["commands"], outer.commands = outer.commands, []
                data = json.dumps(reply).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"

    def posted(self, action):
        return [body for path, body in self.calls if path.endswith("/" + action)]


@pytest.fixture
def redzone():
    fake = FakeRedzone()
    yield fake
    fake.server.shutdown()


def test_plausible_people_like_the_page():
    assert plausible({"x": 0.4, "y": 0.2, "w": 0.15, "h": 0.6, "score": 0.8}, 0.71)
    assert not plausible({"x": 0.4, "y": 0.2, "w": 0.15, "h": 0.6, "score": 0.6}, 0.71)  # under the sensitivity's bar
    assert not plausible({"x": 0.4, "y": 0.2, "w": 0.05, "h": 0.2, "score": 0.9}, 0.71)  # tiny
    assert not plausible({"x": 0.0, "y": 0.8, "w": 0.9, "h": 0.1, "score": 0.9}, 0.71)  # lying across the picture


def test_a_phone_joins_watches_and_raises_an_intrusion(redzone):
    person = [(0.40, 0.20, 0.15, 0.60, 0.9)]
    seen = {"boxes": []}
    phones = Phones(redzone.url, lambda pose, k: np.zeros((k.height, k.width, 3), np.uint8), lambda image: seen["boxes"], log=lambda t: None)
    phones.place({"1": {"x": 11.2, "y": 2.0, "heading": 260, "z": 2.2, "tilt": 22}, "4": {"x": 0, "y": 0, "heading": 0}})
    assert list(phones.phones) == ["1"]  # slots 1-3 only
    t = 0.0
    phones.tick(t)
    assert redzone.posted("join") == [{"name": "Sim phone 1"}]

    def run(seconds):
        nonlocal t
        end = t + seconds
        while t < end:
            t += 0.05
            phones.tick(t)

    run(2.0)
    assert redzone.posted("people")[-1]["boxes"] == []  # watching, nobody there
    assert redzone.posted("heartbeat")[-1]["watching"] is True
    assert redzone.posted("preview")[-1]["jpeg"].startswith("data:image/jpeg;base64,")
    # The console draws a red zone over the person's spot: an intrusion after about a second.
    redzone.commands = [{"type": "roi", "roi": {"x": 0.3, "y": 0.1, "w": 0.4, "h": 0.8}}, {"type": "sensitivity", "sensitivity": 50}]
    run(2.0)
    assert phones.phones["1"].roi and phones.phones["1"].sensitivity == 50
    seen["boxes"] = person
    run(DWELL_NEED_S - 2 * DETECT_EVERY_S)
    assert redzone.posted("intrusion") == []  # not a second yet
    run(1.0)
    intrusion = redzone.posted("intrusion")
    assert len(intrusion) == 1 and intrusion[0]["score"] == 0.9 and intrusion[0]["note"] == "person-in-roi-1s"
    assert redzone.posted("people")[-1]["boxes"][0]["score"] == 0.9
    # Taken off the plan: it leaves its slot.
    phones.place({})
    assert redzone.posted("leave") and not phones.phones


@pytest.mark.skipif(not torch.cuda.is_available(), reason="renders with gsplat on CUDA")
def test_phone_1_sees_the_walker_in_the_red_zone(tmp_path):
    from metoera_sim import venue
    from metoera_sim.people import PEOPLE, Composer, Crowd, load_people
    from metoera_sim.phones import yolo_people
    from metoera_sim.render import Renderer

    config = venue.room_config(tmp_path)
    crowd = Crowd(load_people(PEOPLE))
    walker = crowd.walkers[1]
    t = next(t / 10 for t in range(150, 600) if walker.position(t / 10)[1] < -1.85)  # down the zone's middle
    composer = Composer(venue.build(venue.load_plan(), config["objects"]), crowd)
    cam = config["cameras"]["1"]
    pose, k = camera_pose(cam), intrinsics("normal")
    image = Renderer(k).render(composer.for_eye(t, (pose.x, pose.y)), pose).image
    boxes = [b for b in ({"x": x, "y": y, "w": w, "h": h, "score": s} for x, y, w, h, s in yolo_people()(image)) if plausible(b, 0.71)]
    assert boxes, "phone 1 does not see the walker"
    # Where the voice server will put them (src/room.ts floorFromMount): near the walker's feet.
    b = boxes[0]
    u, v = b["x"] + b["w"] / 2, b["y"] + b["h"]
    hfov = math.radians(68)
    vfov = 2 * math.atan(math.tan(hfov / 2) * 9 / 16)
    a, c = (u - 0.5) * 2 * math.tan(hfov / 2), (v - 0.5) * 2 * math.tan(vfov / 2)
    h, tilt = math.radians(cam["heading"]), math.radians(cam["tilt"])
    f = (math.cos(h) * math.cos(tilt), math.sin(h) * math.cos(tilt), -math.sin(tilt))
    right = (math.sin(h), -math.cos(h), 0.0)
    down = (-math.cos(h) * math.sin(tilt), -math.sin(h) * math.sin(tilt), -math.cos(tilt))
    ray = [f[i] + a * right[i] + c * down[i] for i in range(3)]
    s = cam["z"] / -ray[2]
    x, y = cam["x"] + ray[0] * s, cam["y"] + ray[1] * s
    wx, wy = walker.position(t)
    assert math.hypot(x - wx, y - wy) < 0.6, ((x, y), (wx, wy))

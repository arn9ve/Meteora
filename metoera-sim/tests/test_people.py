"""People who stand and walk in the venue."""

import math

import pytest
import torch

from metoera_sim.camera import Pose
from metoera_sim.drone import LANDED_Z, Obstacles
from metoera_sim.people import PEOPLE, Crowd, Walker, WithPeople, cutout, load_people
from metoera_sim.tello import SimTello

from test_tello import Clock, airborne


def test_walking_along_a_path():
    w = Walker("w", {}, [[0, 0], [1, 0]], speed=1.0, wait=1.0, loop=True, start_after=2.0)
    assert w.position(0.0) == (0.0, 0.0) and w.position(2.0) == (0.0, 0.0)  # not started yet
    assert w.position(2.5) == pytest.approx((0.5, 0.0))
    assert w.position(3.5) == (1.0, 0.0)  # waiting at the far end
    assert w.position(4.5) == pytest.approx((0.5, 0.0))  # on the way back
    assert w.position(2.5 + 4.0) == pytest.approx((0.5, 0.0))  # round again: 4 s a lap
    assert Walker("s", {}, [[3, 4]]).position(100.0) == (3.0, 4.0)  # one point: standing
    assert Walker("o", {}, [[0, 0], [2, 0]], speed=1.0, wait=0.0, loop=False).position(10.0) == (2.0, 0.0)


def test_the_default_people_are_on_the_floor_plan():
    people = load_people(PEOPLE)
    assert [p.name for p in people] == ["man in a beige coat", "man in a dark coat and red shirt"]
    for p in people:
        for x, y in p.path:
            assert -11.4 < x < 11.4 and -3.75 < y < 5.6  # inside the hall


def test_cut_out_of_the_photo():
    pts, rgb = cutout("bus.jpg", [47, 399, 239, 904])
    assert pts[:, 1].min() >= 0 and pts[:, 1].max() == pytest.approx(1.7, abs=0.02)  # feet to head
    box = (pts[:, 0].max() - pts[:, 0].min()) * 1.7
    assert len(pts) * 0.012 ** 2 < 0.8 * box  # the background is gone, not a rectangle
    assert rgb.shape == (len(pts), 3)


def test_people_face_the_camera():
    crowd = Crowd([Walker("standing", {"image": "bus.jpg", "box": [47, 399, 239, 904]}, [[0, 0]])], device="cpu")
    seen_from_x = crowd.means(0.0, (5.0, 0.0))
    seen_from_y = crowd.means(0.0, (0.0, 5.0))
    assert float(seen_from_x[:, 0].abs().max()) < 1e-5 and float(seen_from_x[:, 1].abs().max()) > 0.2  # across y
    assert float(seen_from_y[:, 1].abs().max()) < 1e-5 and float(seen_from_y[:, 0].abs().max()) > 0.2  # across x


def test_a_move_into_a_person_is_refused():
    clock = Clock()
    crowd = Crowd([Walker("standing", {"image": "bus.jpg", "box": [47, 399, 239, 904]}, [[0, 0]])], device="cpu")
    nothing = Obstacles.of_points(torch.tensor([[50.0, 50.0, 0.0]]))  # an empty hall
    world = WithPeople(nothing, crowd, lambda: 0.0)
    tello = SimTello("tello", "SIMTELLO0001", Pose(-1.0, 0.0, LANDED_Z, 0.0), world, clock=clock)
    airborne(tello, clock)
    assert tello.receive("forward 100") == ["error blocked: person 70 cm ahead: at most 65 cm"]
    assert tello.receive("go 100 0 0 50") == ["error blocked: person 70 cm on the way: at most 65 cm"]
    assert world.person_clearance(tello.pose) == pytest.approx(1.0 - 0.25 - 0.07)
    assert world.check_move(tello.pose, "left", 1.0) is None


@pytest.mark.skipif(not torch.cuda.is_available(), reason="renders with gsplat on CUDA")
def test_yolo_sees_the_person_from_blacks_start(tmp_path):
    import os

    os.environ.setdefault("YOLO_CONFIG_DIR", str(tmp_path))
    from ultralytics import YOLO

    from metoera_sim import venue
    from metoera_sim.drone import camera_pose
    from metoera_sim.people import Composer
    from metoera_sim.render import Renderer

    config = venue.room_config(tmp_path)
    crowd = Crowd(load_people(PEOPLE))
    splats = Composer(venue.build(venue.load_plan(), config["objects"]), crowd)
    eye = camera_pose(Pose(6.2, -3.0, 0.8, 90.0))  # Black after takeoff, facing the man 6.6 m away
    image = Renderer().render(splats.for_eye(0.0, (eye.x, eye.y)), eye).image
    weights = venue.SIM / "weights" / "yolo11n.pt"
    found = YOLO(str(weights) if weights.exists() else "yolo11n.pt")(image[:, :, ::-1], verbose=False, conf=0.25)[0]
    people = [float(c) for c, k in zip(found.boxes.conf, found.boxes.cls) if int(k) == 0]
    assert people and max(people) >= 0.5, people

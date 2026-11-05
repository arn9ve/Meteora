"""The drone's size and the obstacle check, on the install check's synthetic room (on the CPU).

The room: a red box (40 cm cube) centred at (2, 0, 0.8), so its front face is at x = 1.8 and
its left face at y = 0.2; a blue box (60 cm) at (1.5, 1.2, 0.3); a wall at x = 4.
"""

import math

import pytest

from metoera_sim.camera import Pose
from metoera_sim.check import synthetic_room
from metoera_sim.drone import CAMERA_FORWARD_M, LENGTH_M, MARGIN_M, Obstacles, camera_pose, half_extents


@pytest.fixture(scope="module")
def room():
    return Obstacles(synthetic_room(device="cpu"))


def test_keep_out_box_is_the_tello_plus_the_margin():
    hf, hl, hu = half_extents()
    assert (hf * 2, hl * 2, hu * 2) == pytest.approx((0.198, 0.1925, 0.141))  # 98 x 92.5 x 41 mm + 2 x 5 cm
    assert half_extents(0.02)[0] == pytest.approx(LENGTH_M / 2 + 0.02)


def test_camera_sits_at_the_nose():
    eye = camera_pose(Pose(1.0, 2.0, 0.8, 90.0))
    assert (eye.x, eye.y, eye.z, eye.yaw) == pytest.approx((1.0, 2.0 + CAMERA_FORWARD_M, 0.8, 90.0))


def test_forward_stops_short_of_the_red_box(room):
    hover = Pose(0.0, 0.0, 0.8, 0.0)
    assert room.check_move(hover, "forward", 1.5) is None
    blocked = room.check_move(hover, "forward", 1.8)
    assert blocked is not None
    # box face at 1.8, minus half the body (4.9 cm) and the margin (5 cm)
    assert blocked.free_cm == 170
    assert blocked.gap_cm == 175
    assert blocked.message == "obstacle 175 cm ahead: at most 170 cm"


def test_blind_spot_to_the_right(room):
    # Beside the red box, which is to the right where the camera cannot see it:
    # the body's right edge is 15 cm from the box's left face.
    beside = Pose(2.0, 0.40, 0.8, 0.0)
    blocked = room.check_move(beside, "right", 0.20)
    assert blocked is not None and blocked.message == "obstacle 15 cm to the right: at most 10 cm"
    assert room.check_move(beside, "right", 0.10) is None
    assert room.check_move(beside, "left", 0.20) is None  # the blue box is lower than the drone


def test_too_close_may_back_away_but_not_go_further_in(room):
    # 2.5 cm from the red box's front face, inside the 5 cm margin.
    touching = Pose(1.8 - LENGTH_M / 2 - MARGIN_M / 2, 0.0, 0.8, 0.0)
    assert room.check_move(touching, "back", 0.5) is None
    blocked = room.check_move(touching, "forward", 0.2)
    assert blocked is not None and blocked.free_cm == 0


def test_up_and_down(room):
    hover = Pose(0.0, 0.0, 0.8, 0.0)
    assert room.check_move(hover, "down", 0.5) is None
    blocked = room.check_move(hover, "down", 0.8)
    assert blocked is not None and blocked.direction == "down"
    under_nothing = Pose(0.0, 0.0, 0.8, 0.0)
    assert room.check_move(under_nothing, "up", 2.0) is None  # no ceiling in this room


def test_turning_next_to_the_box(room):
    assert room.check_turn(Pose(0.0, 0.0, 0.8, 0.0), 360) is None
    # The keep-out box's front is 2 cm from the red box: going straight is fine, but its
    # corners swing out when it turns.
    close = Pose(1.8 - half_extents()[0] - 0.02, 0.0, 0.8, 0.0)
    assert room.check_move(close, "back", 0.2) is None
    blocked = room.check_turn(close, -45)
    assert blocked is not None and blocked.direction == "turn" and blocked.free_deg < 45


def test_ground_below(room):
    assert room.ground_below(Pose(0.0, 0.0, 0.8, 0.0)) == pytest.approx(0.0, abs=0.01)  # floor (the pad)
    assert room.ground_below(Pose(1.5, 1.2, 0.8, 0.0)) == pytest.approx(0.6, abs=0.01)  # top of the blue box
    assert not math.isnan(room.ground_below(Pose(9.0, 9.0, 0.8, 0.0)))  # off the scan: the floor at 0

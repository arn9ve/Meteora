"""The simulated Tello's SDK, with a fake clock, in the synthetic room (on the CPU)."""

import re

import pytest

from metoera_sim.camera import Pose
from metoera_sim.check import synthetic_room
from metoera_sim.drone import HOVER_Z, LANDED_Z, Obstacles
from metoera_sim.tello import CLIMB_M_S, IDLE_LAND_S, SETTLE_S, SPIN_UP_S, TURN_DEG_S, SimTello


class Clock:
    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t


@pytest.fixture(scope="module")
def room():
    return Obstacles(synthetic_room(device="cpu"))


@pytest.fixture
def clock():
    return Clock()


@pytest.fixture
def tello(room, clock):
    return SimTello("tello", "SIMTELLO0001", Pose(0.0, 0.0, LANDED_Z, 0.0), room, clock=clock)


def wait(tello, clock, seconds, every=0.05):
    """Let time pass like serve.py does (step() many times a second); the replies on the way."""
    replies, end = [], clock.t + seconds
    while clock.t < end:
        clock.t = min(end, clock.t + every)
        replies += tello.step()
    return replies


def fly(tello, clock, command, seconds):
    """Send a motion command and wait for it to answer."""
    assert tello.receive(command) == []
    return wait(tello, clock, seconds)


def telemetry(tello, key):
    """Read one field the way metoera-voice does (src/tello.ts, #onState)."""
    match = re.search(rf"(?:^|;){key}:(-?\d+)(?:;|$)", tello.state())
    return int(match.group(1)) if match else None


def airborne(tello, clock):
    assert tello.receive("command") == ["ok"]
    assert fly(tello, clock, "takeoff", SPIN_UP_S + (HOVER_Z - LANDED_Z) / CLIMB_M_S + 0.1) == ["ok"]


def test_handshake(tello):
    assert tello.receive("sn?") == []  # nothing before `command`, like the real drone
    assert tello.receive("command") == ["ok"]
    assert tello.receive("sn?") == ["SIMTELLO0001"]
    assert tello.receive("battery?") == ["90"]
    assert tello.receive("streamon") == ["ok"] and tello.video


def test_takeoff_climbs_to_hover_and_answers_when_up(tello, clock):
    tello.receive("command")
    assert tello.receive("takeoff") == []
    assert wait(tello, clock, SPIN_UP_S) == []  # motors spinning up, still on the floor
    assert tello.pose.z == pytest.approx(LANDED_Z)
    assert wait(tello, clock, (HOVER_Z - LANDED_Z) / CLIMB_M_S + 0.1) == ["ok"]
    assert tello.pose.z == pytest.approx(HOVER_Z)
    assert telemetry(tello, "h") == 78  # above the takeoff spot
    assert tello.flying


def test_move_flies_at_the_set_speed(tello, clock):
    airborne(tello, clock)
    assert tello.receive("speed 50") == ["ok"]
    assert fly(tello, clock, "forward 100", 100 / 50) == []  # 2 s of flight, then it steadies
    assert wait(tello, clock, SETTLE_S + 0.05) == ["ok"]
    assert (tello.pose.x, tello.pose.y) == pytest.approx((1.0, 0.0))


def test_blocked_in_the_blind_spot(tello, clock):
    # Fly beside the red box, then ask to go right into it: the camera faces +x and never sees it.
    airborne(tello, clock)
    assert fly(tello, clock, "left 40", 2.0) == ["ok"]
    assert fly(tello, clock, "forward 200", 3.0) == ["ok"]
    before = tello.pose
    assert tello.receive("right 20") == ["error blocked: obstacle 15 cm to the right: at most 10 cm"]
    assert tello.pose == before and not tello.busy
    assert tello.events[-1].startswith("blocked:")


def test_land_is_never_refused(tello, clock):
    tello.receive("command")
    assert tello.receive("land") == ["ok"]  # already down
    assert tello.receive("takeoff") == []
    wait(tello, clock, 1.0)
    assert tello.receive("land") == []  # mid-takeoff: lands instead
    assert wait(tello, clock, 4.0) == ["ok"]  # the takeoff never answers
    assert not tello.flying and tello.pose.z == pytest.approx(LANDED_Z)
    assert telemetry(tello, "h") == 0


def test_stop_cancels_a_move(tello, clock):
    airborne(tello, clock)
    assert fly(tello, clock, "forward 100", 0.6) == []
    assert tello.receive("stop") == ["ok"]
    assert wait(tello, clock, 5.0) == []  # the cancelled move never answers
    assert 0.0 < tello.pose.x < 1.0


def test_busy_while_moving_but_still_answers_questions(tello, clock):
    airborne(tello, clock)
    assert tello.receive("forward 100") == []
    assert tello.receive("forward 20") == ["error busy"]
    assert tello.receive("battery?") == [str(round(tello.battery))]


def test_out_of_range(tello, clock):
    airborne(tello, clock)
    assert tello.receive("forward 10") == ["error"]
    assert tello.receive("cw 400") == ["error"]
    assert tello.receive("speed 5") == ["error"]


def test_turns_and_yaw_in_telemetry(tello, clock):
    airborne(tello, clock)
    assert fly(tello, clock, "cw 90", 90 / TURN_DEG_S + SETTLE_S + 0.05) == ["ok"]
    assert tello.pose.yaw == pytest.approx(-90.0)  # the world's yaw is counterclockwise
    assert telemetry(tello, "yaw") == 90  # the Tello's is clockwise
    assert fly(tello, clock, "ccw 360", 360 / TURN_DEG_S + SETTLE_S + 0.05) == ["ok"]
    assert tello.pose.yaw == pytest.approx(-90.0)


def test_lands_by_itself_after_15_s_without_a_command(tello, clock):
    airborne(tello, clock)
    wait(tello, clock, IDLE_LAND_S - 5)
    assert tello.receive("battery?")  # a keep-alive restarts the 15 s
    assert wait(tello, clock, IDLE_LAND_S - 1) == [] and tello.flying
    assert wait(tello, clock, 5.0) == []  # lands, and nobody asked, so no reply
    assert not tello.flying
    assert any("no command" in e for e in tello.events)


def test_emergency_cuts_the_motors_at_once(tello, clock):
    airborne(tello, clock)
    assert tello.receive("emergency") == ["ok"]
    assert not tello.flying
    wait(tello, clock, 1.0)
    assert tello.pose.z == pytest.approx(LANDED_Z, abs=0.005)  # on the takeoff pad, 3 mm thick


def test_telemetry_has_what_the_voice_server_reads(tello, clock):
    tello.receive("command")
    assert telemetry(tello, "bat") == 90
    assert telemetry(tello, "h") == 0
    assert telemetry(tello, "yaw") == 0
    assert tello.state().endswith(";\r\n")


def test_moves_drift_like_a_real_tello(room, clock):
    tello = SimTello("tello", "SIMTELLO0001", Pose(0.0, 0.0, LANDED_Z, 0.0), room, clock=clock, drift=0.1, seed=7)
    airborne(tello, clock)
    assert fly(tello, clock, "forward 100", 100 / 100 + SETTLE_S + 0.1) == ["ok"]
    x = tello.pose.x
    assert x != pytest.approx(1.0, abs=1e-6) and 0.9 <= x <= 1.1  # off, but by at most 10 %


def test_mission_pads_in_telemetry(room, clock):
    pads = {"1": [0.0, 0.0, 0.0], "2": [2.0, -1.0, 0.0]}
    tello = SimTello("tello", "SIMTELLO0001", Pose(0.05, -0.02, LANDED_Z, 0.0), room, clock=clock, mission_pads=pads)
    airborne(tello, clock)
    assert telemetry(tello, "mid") == -1  # pads are off until `mon`
    assert tello.receive("mon") == ["ok"] and tello.receive("mdirection 0") == ["ok"]
    assert telemetry(tello, "mid") == 1
    assert (telemetry(tello, "x"), telemetry(tello, "y"), telemetry(tello, "z")) == (5, -2, 80)
    assert re.search(r"mpry:0,0,0;", tello.state())
    assert fly(tello, clock, "cw 90", 90 / TURN_DEG_S + SETTLE_S + 0.1) == ["ok"]
    assert re.search(r"mpry:0,0,90;", tello.state())  # clockwise, like the Tello's yaw
    assert fly(tello, clock, "left 100", 100 / 100 + SETTLE_S + 0.1) == ["ok"]  # facing -y, left is +x
    assert telemetry(tello, "mid") == -1  # 1 m away: out of sight
    assert tello.receive("moff") == ["ok"]


def test_no_pad_on_the_ground(room, clock):
    tello = SimTello("tello", "SIMTELLO0001", Pose(0.0, 0.0, LANDED_Z, 0.0), room, clock=clock, mission_pads={"1": [0, 0, 0]})
    tello.receive("command")
    tello.receive("mon")
    assert telemetry(tello, "mid") == -1  # too close to see it


# ---- what metoera-voice's approach branch uses: go, go with a pad, ground speed


def test_go_flies_a_straight_line(tello, clock):
    airborne(tello, clock)
    assert tello.receive("go 10 10 10 50") == ["error"]  # every axis under 20 cm
    assert tello.receive("go 100 0 0 5") == ["error"]  # speed 10-100
    assert tello.receive("go 600 0 0 50") == ["error"]  # 500 at most
    assert fly(tello, clock, "go 100 50 0 50", 112 / 50 + SETTLE_S + 0.1) == ["ok"]  # x forward, y left
    assert (tello.pose.x, tello.pose.y, tello.pose.z) == pytest.approx((1.0, 0.5, HOVER_Z))


def test_go_is_checked_like_a_move(room, tello, clock):
    airborne(tello, clock)
    hover = tello.pose
    for sdk, (f, l, u), direction in (("go 200 0 0 50", (2.0, 0, 0), "forward"), ("go 0 0 -100 50", (0, 0, -1.0), "down")):
        move, go = room.check_move(hover, direction, abs(f + l + u)), room.check_go(hover, f, l, u)
        assert move and go and go.free_cm == move.free_cm  # the same rule along an axis
    assert room.check_go(hover, 0.0, 0.5, 0.0) is None  # nothing to the left
    # Diagonal: ahead and a little left, past the red box's edge (it spans y -0.2..0.2).
    assert tello.receive("go 200 20 0 50") == ["error blocked: obstacle 175 cm on the way: at most 170 cm"]
    assert tello.pose == hover


def test_go_to_a_mission_pad(room, clock):
    pads = {"1": [0.0, 0.0, 0.0], "2": [2.0, -1.0, 0.0]}
    tello = SimTello("tello", "SIMTELLO0001", Pose(0.1, -0.05, LANDED_Z, 0.0), room, clock=clock, mission_pads=pads)
    airborne(tello, clock)
    assert tello.receive("go 0 0 80 30 m1") == ["error No mission pad detected"]  # pads off
    tello.receive("mon")
    assert tello.receive("go 0 0 80 30 m2") == ["error No mission pad detected"]  # not below
    assert fly(tello, clock, "go 0 0 100 30 m1", 25 / 30 + SETTLE_S + 0.1) == ["ok"]
    assert (tello.pose.x, tello.pose.y, tello.pose.z) == pytest.approx((0.0, 0.0, 1.0))
    assert (telemetry(tello, "x"), telemetry(tello, "y"), telemetry(tello, "z")) == (0, 0, 100)


def decode(vgx, vgy, imu_yaw_deg):
    """metoera-voice's reading of the real Tello EDU (src/odometry.ts #step: compass axes,
    yawSign 1, mirror 1, flip -1): the drone's (forward, right) speed in cm/s."""
    import math

    psi = math.radians(imu_yaw_deg)
    vx, vy = -vgx * 12.2, -vgy * 12.2
    return vx * math.cos(psi) + vy * math.sin(psi), -vx * math.sin(psi) + vy * math.cos(psi)


@pytest.mark.parametrize("start_yaw", [0.0, 90.0, -135.0])
def test_ground_speed_reads_like_the_real_tello(room, clock, start_yaw):
    tello = SimTello("tello", "SIMTELLO0001", Pose(-0.5, 0.0, LANDED_Z, start_yaw), room, clock=clock)
    airborne(tello, clock)
    assert telemetry(tello, "yaw") == 0  # the IMU's 0 is where it faced when switched on
    assert (telemetry(tello, "vgx"), telemetry(tello, "vgy")) == (0, 0)  # hovering
    for turn, sdk, want in ((None, "forward 50", (1, 0)), ("cw 90", "left 50", (0, -1)), ("ccw 45", "back 50", (-1, 0))):
        if turn:
            assert fly(tello, clock, turn, 2.0) == ["ok"]
        assert tello.receive(sdk) == []
        wait(tello, clock, 0.65)  # the middle of the move: full speed
        forward, right = decode(telemetry(tello, "vgx"), telemetry(tello, "vgy"), telemetry(tello, "yaw"))
        speed = 0.5 * 6 * 0.25 / (0.5 + SETTLE_S) * 100  # cm/s at the middle of a smooth 50 cm move
        assert forward == pytest.approx(want[0] * speed, abs=12.2) and right == pytest.approx(want[1] * speed, abs=12.2)
        assert wait(tello, clock, 1.0) == ["ok"]
    assert telemetry(tello, "yaw") == 45


def test_hover_slide(room, clock):
    tello = SimTello("tello", "SIMTELLO0001", Pose(0.0, 0.0, LANDED_Z, 0.0), room, clock=clock, drift=0.03, seed=3)
    airborne(tello, clock)
    before = tello.pose
    for _ in range(4):
        wait(tello, clock, 5.0)
        tello.receive("battery?")  # the server's keep-alive
    moved = ((tello.pose.x - before.x) ** 2 + (tello.pose.y - before.y) ** 2) ** 0.5
    assert 0.0 < moved < 0.4  # 20 s at under 2 cm/s
    assert (telemetry(tello, "vgx"), telemetry(tello, "vgy")) == (0, 0)  # too slow to show


def test_no_valid_imu(room, clock):
    tello = SimTello("tello", "SIMTELLO0001", Pose(0.0, 0.0, LANDED_Z, 0.0), room, clock=clock, imu_errors=1.0, seed=1)
    airborne(tello, clock)
    outcomes = set()
    for _ in range(8):
        x = tello.pose.x
        replies = tello.receive("back 20") + wait(tello, clock, 2.0)
        assert replies == ["error No valid imu"]
        outcomes.add("moved" if abs(tello.pose.x - x) > 0.1 else "stayed")
    assert outcomes == {"moved", "stayed"}

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

"""The venue built from metoera-voice's floor plan (on the CPU)."""

import json

import pytest

from metoera_sim import venue
from metoera_sim.camera import Pose
from metoera_sim.drone import HOVER_Z, LANDED_Z, Obstacles
from metoera_sim.tello import SETTLE_S, SimTello

from test_tello import Clock, airborne, fly, telemetry


@pytest.fixture(scope="module")
def config(tmp_path_factory):
    return venue.room_config(tmp_path_factory.mktemp("voice-data"))  # a copy of venue/room.json


@pytest.fixture(scope="module")
def hall(config):
    return Obstacles(venue.build(venue.load_plan(), config["objects"], device="cpu"))


def test_the_default_room_is_written_for_the_voice_server(tmp_path):
    config = venue.room_config(tmp_path)
    assert json.loads((tmp_path / ".room.json").read_text()) == config
    assert [o["name"] for o in config["objects"]] == [f"table {n}" for n in range(1, 7)]
    assert set(config["drones"]) == {"tello", "rmtt"} and set(config["cameras"]) == {"1", "2"}


def test_start_spots_and_surfaces(config):
    env = {"TELLO_START": "620,-300,90", "RMTT_START": "0,0,0"}
    assert venue.start_spots(config, env)["rmtt"] == (4.21, -1.37, 90.0)  # placed on the Room panel
    assert venue.start_spots({}, env)["tello"] == (6.2, -3.0, 90.0)  # else sim.env, in cm
    assert venue.surface_height(config["objects"], 4.21, -1.37) == 0.75  # table 3
    assert venue.surface_height(config["objects"], 6.2, -3.0) == 0.0
    pads = venue.default_pads(venue.start_spots(config, env), config["objects"])
    assert pads["1"] == (6.2, -3.0, 0.0) and pads["2"] == pytest.approx((6.2, -1.0, 0.0))


def test_a_pillar_blocks_a_move(hall):
    clock = Clock()
    tello = SimTello("tello", "SIMTELLO0001", Pose(6.0, 0.94, LANDED_Z, 0.0), hall, clock=clock)
    airborne(tello, clock)  # pillar 4 spans x 6.64..7.84 ahead
    assert tello.receive("forward 100") == ["error blocked: obstacle 59 cm ahead: at most 54 cm"]
    assert tello.receive("go 100 0 0 50") == ["error blocked: obstacle 59 cm on the way: at most 54 cm"]


def test_take_off_from_a_table(hall):
    clock = Clock()
    red = SimTello("rmtt", "SIMRMTT00002", Pose(4.21, -1.37, venue.TABLE_HEIGHT_M + LANDED_Z, 90.0), hall, clock=clock)
    assert red.receive("command") == ["ok"]
    assert telemetry(red, "tof") == 10  # on the table: the sensor's minimum
    airborne(red, clock)
    assert telemetry(red, "h") == 78  # above the take-off spot, the table top
    assert telemetry(red, "tof") == 78
    assert fly(red, clock, "forward 100", 1.0 + SETTLE_S + 0.1) == ["ok"]  # off the table's edge
    assert telemetry(red, "tof") == 153 and telemetry(red, "h") == 78
    assert red.pose.z == pytest.approx(venue.TABLE_HEIGHT_M + HOVER_Z)


def test_a_landed_drone_is_carried(hall):
    clock = Clock()
    tello = SimTello("tello", "SIMTELLO0001", Pose(6.2, -3.0, LANDED_Z, 90.0), hall, clock=clock)
    tello.receive("command")
    assert tello.carry(Pose(6.2, -2.0, LANDED_Z, 0.0))
    assert telemetry(tello, "yaw") == 90  # the IMU kept its 0: turned 90 to the right
    airborne(tello, clock)
    assert not tello.carry(Pose(0.0, 0.0, LANDED_Z, 0.0))  # not while flying

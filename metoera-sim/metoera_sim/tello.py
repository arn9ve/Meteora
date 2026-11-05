"""The simulated Tello's SDK: what it answers and how it flies.

Plain Python with an injected clock and obstacle check, so it can be tested without a GPU or a
network. serve.py puts it on UDP and renders its camera.

Like the real drone:
- it ignores everything until it gets `command`;
- a move flies at the set speed and answers `ok` when it arrives;
- `stop` hovers at once and cancels the move under way (which then never answers);
- `land` and `emergency` are always obeyed, whatever the drone is doing;
- with no command for 15 s it lands by itself (the server's `battery?` keeps it up);
- the battery drains while flying, about 13 minutes from 100 %.

Unlike the real drone, a move or turn that would run the drone (plus its margin) into the
scan is refused: it answers `error blocked: obstacle 15 cm to the right: at most 10 cm` and
stays put. The real one would hit the wall; the simulator is for finding those blind spots.

The timings are estimates. Check them against a real Tello before trusting them:
`speed?` (DEFAULT_SPEED_CM_S), and how long a takeoff, a `forward 100` and a `cw 90` take.
"""

from __future__ import annotations

import math
import time
from dataclasses import dataclass, replace
from typing import Callable, Optional, Protocol

from .camera import Pose
from .drone import HEIGHT_M, HOVER_Z, LANDED_Z, Blocked

DEFAULT_SPEED_CM_S = 100  # what `speed?` reportedly answers on a fresh Tello
SPEED_RANGE = (10, 100)
MOVE_RANGE_CM = (20, 500)
TURN_RANGE_DEG = (1, 360)
TURN_DEG_S = 90.0
SETTLE_S = 0.8  # every move or turn: speeding up, slowing down, steadying
SPIN_UP_S = 1.5  # takeoff: motors starting before it climbs
CLIMB_M_S = 0.3
LAND_M_S = 0.35
TOUCHDOWN_S = 1.0  # landing: from touching the floor to motors off
FLIP_S = 1.5
FLIP_ROOM_M = 0.3  # a flip swings this far to its side
FLIP_MIN_BATTERY = 50
IDLE_LAND_S = 15.0
FLIGHT_S = 13 * 60  # from 100 % to empty
LOW_BATTERY = 5  # it lands by itself below this
FLIPS = {"l": "left", "r": "right", "f": "forward", "b": "back"}
MOVES = ("forward", "back", "left", "right", "up", "down")


class ObstacleCheck(Protocol):
    margin: float

    def check_move(self, body: Pose, direction: str, distance_m: float) -> Optional[Blocked]: ...
    def check_turn(self, body: Pose, degrees: float) -> Optional[Blocked]: ...
    def ground_below(self, body: Pose) -> float: ...


@dataclass
class _Motion:
    kind: str  # takeoff, land, move, turn, flip, fall
    start: Pose
    end: Pose
    t0: float
    duration: float
    turn: float = 0.0  # degrees, counterclockwise (a 360 ends where it began)
    delay: float = 0.0  # seconds before it starts moving (motors spinning up)
    reply: Optional[str] = "ok"  # sent when it is done

    def at(self, now: float) -> Pose:
        span = self.duration - self.delay
        u = 1.0 if span <= 0 else min(1.0, max(0.0, (now - self.t0 - self.delay) / span))
        u = u * u * (3 - 2 * u)  # smooth start and stop
        a, b = self.start, self.end
        return replace(a, x=a.x + (b.x - a.x) * u, y=a.y + (b.y - a.y) * u, z=a.z + (b.z - a.z) * u,
                       yaw=(a.yaw + self.turn * u + 180) % 360 - 180)


def _int_arg(args: list[str], low: int, high: int) -> Optional[int]:
    if len(args) != 1 or not args[0].lstrip("-").isdigit():
        return None
    value = int(args[0])
    return value if low <= value <= high else None


class SimTello:
    def __init__(self, name: str, serial: str, start: Pose, obstacles: ObstacleCheck,
                 clock: Callable[[], float] = time.monotonic, battery: float = 90.0) -> None:
        self.name = name
        self.serial = serial
        self.obstacles = obstacles
        self.clock = clock
        self.battery = float(battery)
        self.speed = DEFAULT_SPEED_CM_S
        self.sdk = False  # got `command`
        self.flying = False  # motors on
        self.video = False
        self.flight_time = 0.0
        self.events: list[str] = []  # for the log: blocked moves, self-landing
        self._pose = start
        self._takeoff_z = start.z
        self._motion: Optional[_Motion] = None
        now = clock()
        self._last_command = now
        self._last_step = now

    # ---- where it is
    def pose_at(self, now: float) -> Pose:
        return self._motion.at(now) if self._motion else self._pose

    @property
    def pose(self) -> Pose:
        return self.pose_at(self.clock())

    @property
    def busy(self) -> bool:
        return self._motion is not None

    # ---- the SDK
    def receive(self, text: str) -> list[str]:
        """One datagram in; the replies to send at once (later ones come from step())."""
        now = self.clock()
        replies = self.step(now)
        words = text.replace("\0", "").strip().split()
        if not words:
            return replies
        cmd, args = words[0].lower(), words[1:]
        if cmd == "command":
            self.sdk = True
            self._last_command = now
            return replies + ["ok"]
        if not self.sdk:
            return replies  # a real Tello ignores everything before `command`
        self._last_command = now
        reply = self._handle(cmd, args, now)
        return replies + ([reply] if reply is not None else [])

    def _handle(self, cmd: str, args: list[str], now: float) -> Optional[str]:
        queries = {
            "battery?": lambda: str(max(0, round(self.battery))),
            "sn?": lambda: self.serial,
            "speed?": lambda: f"{self.speed:.1f}",
            "time?": lambda: f"{int(self.flight_time)}s",
            "height?": lambda: f"{self.height_cm(now) // 10}dm",
            "tof?": lambda: f"{self.tof_cm(now) * 10}mm",
            "wifi?": lambda: "90",
            "sdk?": lambda: "30",
        }
        if cmd in queries:
            return queries[cmd]()
        if cmd == "emergency":
            self._emergency(now)
            return "ok"
        if cmd == "land":
            return self._land(now)
        if cmd == "stop":
            if self._motion and self._motion.kind in ("move", "turn", "flip"):
                self._pose = self._motion.at(now)  # hover here; the cancelled move never answers
                self._motion = None
            return "ok"
        if cmd in ("streamon", "streamoff"):
            self.video = cmd == "streamon"
            return "ok"
        if cmd == "speed":
            value = _int_arg(args, *SPEED_RANGE)
            if value is None:
                return "error"
            self.speed = value
            return "ok"
        if cmd == "rc":
            return None  # joystick: the real drone does not answer it either (not simulated)
        if cmd in ("takeoff", "flip", "cw", "ccw") or cmd in MOVES:
            if self.busy:
                return "error busy"
            if cmd == "takeoff":
                return self._takeoff(now)
            if not self.flying:
                return "error not flying"
            if cmd in MOVES:
                return self._move(cmd, args, now)
            if cmd in ("cw", "ccw"):
                return self._turn(cmd, args, now)
            return self._flip(args, now)
        return f"unknown command: {cmd}"

    def _blocked(self, blocked: Blocked) -> str:
        self.events.append(f"blocked: {blocked.message}")
        return f"error blocked: {blocked.message}"

    def _takeoff(self, now: float) -> Optional[str]:
        if self.flying:
            return "error already flying"
        if self.battery < 10:
            return "error battery low"
        pose = self._pose
        climb = HOVER_Z - LANDED_Z
        # Checked from just above the floor: a real scan's floor is a few cm thick and must not
        # count as something above the drone.
        lift = HEIGHT_M / 2 + self.obstacles.margin
        blocked = self.obstacles.check_move(replace(pose, z=pose.z + lift), "up", climb - lift)
        if blocked:
            return self._blocked(blocked)
        self.flying = True
        self._takeoff_z = pose.z
        self._motion = _Motion("takeoff", pose, replace(pose, z=pose.z + climb), now,
                               SPIN_UP_S + climb / CLIMB_M_S, delay=SPIN_UP_S)
        return None

    def _land(self, now: float) -> Optional[str]:
        if not self.flying:
            return "ok"  # already down: never refuse a land
        pose = self.pose_at(now)
        target = self.obstacles.ground_below(pose) + LANDED_Z
        drop = max(0.0, pose.z - target)
        self._motion = _Motion("land", pose, replace(pose, z=min(pose.z, target)), now, drop / LAND_M_S + TOUCHDOWN_S)
        return None

    def _emergency(self, now: float) -> None:
        pose = self.pose_at(now)
        ground = self.obstacles.ground_below(pose) + LANDED_Z
        fall = max(0.0, pose.z - ground)
        self.flying = False  # motors off at once
        self._motion = _Motion("fall", pose, replace(pose, z=min(pose.z, ground)), now,
                               math.sqrt(2 * fall / 9.81), reply=None)

    def _move(self, direction: str, args: list[str], now: float) -> str | None:
        cm = _int_arg(args, *MOVE_RANGE_CM)
        if cm is None:
            return "error"
        pose = self._pose
        blocked = self.obstacles.check_move(pose, direction, cm / 100)
        if blocked:
            return self._blocked(blocked)
        sign = -1 if direction in ("back", "right", "down") else 1
        axis = {"forward": "forward", "back": "forward", "left": "left", "right": "left", "up": "up", "down": "up"}[direction]
        end = pose.moved(**{axis: sign * cm / 100})
        self._motion = _Motion("move", pose, end, now, cm / self.speed + SETTLE_S)
        return None

    def _turn(self, cmd: str, args: list[str], now: float) -> str | None:
        deg = _int_arg(args, *TURN_RANGE_DEG)
        if deg is None:
            return "error"
        turn = -deg if cmd == "cw" else deg  # the world's yaw is counterclockwise
        pose = self._pose
        blocked = self.obstacles.check_turn(pose, turn)
        if blocked:
            return self._blocked(blocked)
        self._motion = _Motion("turn", pose, pose.moved(turn=turn), now, deg / TURN_DEG_S + SETTLE_S, turn=turn)
        return None

    def _flip(self, args: list[str], now: float) -> str | None:
        if len(args) != 1 or args[0] not in FLIPS:
            return "error"
        if self.battery < FLIP_MIN_BATTERY:
            return "error battery low"
        blocked = self.obstacles.check_move(self._pose, FLIPS[args[0]], FLIP_ROOM_M)
        if blocked:
            return self._blocked(blocked)
        self._motion = _Motion("flip", self._pose, self._pose, now, FLIP_S)
        return None

    # ---- time passing
    def step(self, now: Optional[float] = None) -> list[str]:
        """Advance to `now`; the replies of motions that just ended."""
        now = self.clock() if now is None else now
        dt, self._last_step = max(0.0, now - self._last_step), now
        if self.flying:
            self.battery = max(0.0, self.battery - dt * 100 / FLIGHT_S)
            self.flight_time += dt
        out = []
        m = self._motion
        if m and now >= m.t0 + m.duration:
            self._pose = m.at(now)
            self._motion = None
            if m.kind == "land":
                self.flying = False
            if m.reply:
                out.append(m.reply)
        if self.flying and not self._motion:
            if now - self._last_command > IDLE_LAND_S:
                self.events.append(f"no command for {IDLE_LAND_S:.0f} s: landing by itself")
                self._land(now)
                self._motion.reply = None
            elif self.battery < LOW_BATTERY:
                self.events.append("battery low: landing by itself")
                self._land(now)
                self._motion.reply = None
        return out

    # ---- telemetry
    def height_cm(self, now: float) -> int:
        """`h`: above the takeoff spot while flying, 0 once the motors are off."""
        return max(0, round((self.pose_at(now).z - self._takeoff_z) * 100)) if self.flying else 0

    def tof_cm(self, now: float) -> int:
        """`tof`: from the drone's bottom to what is under it (the sensor reads at least 10)."""
        pose = self.pose_at(now)
        gap = pose.z - HEIGHT_M / 2 - self.obstacles.ground_below(pose)
        return max(10, round(gap * 100))

    def state(self, now: Optional[float] = None) -> str:
        """The telemetry datagram, in the Tello EDU's format (yaw is clockwise there)."""
        now = self.clock() if now is None else now
        pose = self.pose_at(now)
        yaw = round((-pose.yaw + 180) % 360 - 180)
        return (f"mid:-1;x:-100;y:-100;z:-100;mpry:0,0,0;pitch:0;roll:0;yaw:{yaw};vgx:0;vgy:0;vgz:0;"
                f"templ:63;temph:65;tof:{self.tof_cm(now)};h:{self.height_cm(now)};bat:{max(0, round(self.battery))};"
                f"baro:{50 + pose.z:.2f};time:{int(self.flight_time)};agx:0.00;agy:0.00;agz:-1000.00;\r\n")

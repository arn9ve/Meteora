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

With `drift`, moves and turns come out a little off, as on the real drone: a move travels its
distance x (1 +- drift), a turn its angle x (1 +- 2/3 drift), and a hovering drone slides slowly
(at most 2 cm/s, too slow for the telemetry to show). Telemetry tells the truth (yaw, h, the
ground speed of moves).

`go x y z speed` flies a straight line in the drone's frame (x forward, y left, z up), and
`go x y z speed mN` to a point in mission pad N's frame while the drone sees that pad.

Ground speed (`vgx vgy vgz`) is given the way metoera-voice measured it on the real Tello EDU
(flight log of 5 Nov 2026, src/odometry.ts): in compass axes (x where the IMU yaw is 0, y 90
degrees clockwise from it), with the opposite sign, 12.2 cm/s per unit, in whole units. The IMU
yaw is 0 where the drone faced when it was switched on (the simulator's start), clockwise.

With `imu_errors`, a move sometimes answers `error No valid imu` (the drone cannot see the floor
well): half the time without moving, half the time after moving anyway, as on 5 Nov.

Mission pads: after `mon`, while the drone is 0.3-1.2 m above a pad and within 30 cm of its
centre, telemetry carries `mid` (the pad's number), `x y z` (the drone's position from the pad's
centre, in cm, in the pad's frame) and `mpry` (its yaw from the pad's, clockwise). The pads are
assumed to lie with their rocket towards +x, so the pad's frame is the room's. That frame and
those signs must be checked on a real drone.

Unlike the real drone, a move or turn that would run the drone (plus its margin) into the
scan is refused: it answers `error blocked: obstacle 15 cm to the right: at most 10 cm` and
stays put. The real one would hit the wall; the simulator is for finding those blind spots.

The timings are estimates. Check them against a real Tello before trusting them:
`speed?` (DEFAULT_SPEED_CM_S), and how long a takeoff, a `forward 100` and a `cw 90` take.
"""

from __future__ import annotations

import math
import random
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
PAD_HEIGHTS = (0.3, 1.2)  # the downward camera finds a pad between these heights above it
PAD_REACH = 0.3  # ... and this far from its centre
FLIPS = {"l": "left", "r": "right", "f": "forward", "b": "back"}
MOVES = ("forward", "back", "left", "right", "up", "down")
GO_RANGE_CM = 500  # each axis of a `go`, either way
GO_MIN_CM = 20  # a `go` needs at least one axis this long
VG_CM_S_PER_UNIT = 12.2  # what one unit of vgx/vgy/vgz is, measured on the real Tello EDU
SLIDE_MAX_M_S = 0.02  # hover slide: at most 2 cm/s ...
SLIDE_TAU_S = 3.0  # ... changing over a few seconds
IMU_ERROR = "error No valid imu"


class ObstacleCheck(Protocol):
    margin: float

    def check_move(self, body: Pose, direction: str, distance_m: float) -> Optional[Blocked]: ...
    def check_go(self, body: Pose, forward: float, left: float, up: float) -> Optional[Blocked]: ...
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

    def velocity(self, now: float) -> tuple[float, float, float]:
        """World velocity (m/s) at `now`: the derivative of at()."""
        span = self.duration - self.delay
        if span <= 0:
            return 0.0, 0.0, 0.0
        u = (now - self.t0 - self.delay) / span
        if not 0.0 < u < 1.0:
            return 0.0, 0.0, 0.0
        k = 6 * u * (1 - u) / span
        a, b = self.start, self.end
        return (b.x - a.x) * k, (b.y - a.y) * k, (b.z - a.z) * k


def _int_arg(args: list[str], low: int, high: int) -> Optional[int]:
    if len(args) != 1 or not args[0].lstrip("-").isdigit():
        return None
    value = int(args[0])
    return value if low <= value <= high else None


class SimTello:
    def __init__(self, name: str, serial: str, start: Pose, obstacles: ObstacleCheck,
                 clock: Callable[[], float] = time.monotonic, battery: float = 90.0, drift: float = 0.0,
                 seed: Optional[int] = None, mission_pads: Optional[dict] = None, imu_errors: float = 0.0) -> None:
        self.name = name
        self.drift = drift
        self.imu_errors = imu_errors
        self._rng = random.Random(seed)
        # Their own generators, so the moves' drift comes out the same with or without them.
        self._slide_rng = random.Random(None if seed is None else seed + 1000)
        self._imu_rng = random.Random(None if seed is None else seed + 2000)
        self._slide = (0.0, 0.0)  # hover slide, world m/s
        self._yaw0 = start.yaw  # the IMU's yaw 0: where it faced when switched on
        self.mission_pads = {int(k): tuple(v) for k, v in (mission_pads or {}).items()}
        self.pads_on = False  # `mon` / `moff`
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
        if cmd in ("mon", "moff"):
            self.pads_on = cmd == "mon"
            return "ok"
        if cmd == "mdirection":
            return "ok" if _int_arg(args, 0, 2) is not None else "error"
        if cmd == "speed":
            value = _int_arg(args, *SPEED_RANGE)
            if value is None:
                return "error"
            self.speed = value
            return "ok"
        if cmd == "rc":
            return None  # joystick: the real drone does not answer it either (not simulated)
        if cmd in ("takeoff", "flip", "cw", "ccw", "go") or cmd in MOVES:
            if self.busy:
                return "error busy"
            if cmd == "takeoff":
                return self._takeoff(now)
            if not self.flying:
                return "error not flying"
            if cmd in MOVES:
                return self._move(cmd, args, now)
            if cmd == "go":
                return self._go(args, now)
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

    def _imu(self) -> str:
        """`ok`, or with imu_errors: `stay` (error, no move) or `moved` (error after moving)."""
        if self.imu_errors <= 0 or self._imu_rng.random() >= self.imu_errors:
            return "ok"
        return "stay" if self._imu_rng.random() < 0.5 else "moved"

    def _move(self, direction: str, args: list[str], now: float) -> str | None:
        cm = _int_arg(args, *MOVE_RANGE_CM)
        if cm is None:
            return "error"
        pose = self._pose
        actual = cm / 100 * (1 + self.drift * self._rng.uniform(-1, 1))
        imu = self._imu()
        if imu == "stay":
            return IMU_ERROR
        blocked = self.obstacles.check_move(pose, direction, actual)
        if blocked:
            return self._blocked(blocked)
        sign = -1 if direction in ("back", "right", "down") else 1
        axis = {"forward": "forward", "back": "forward", "left": "left", "right": "left", "up": "up", "down": "up"}[direction]
        end = pose.moved(**{axis: sign * actual})
        self._motion = _Motion("move", pose, end, now, cm / self.speed + SETTLE_S, reply=IMU_ERROR if imu == "moved" else "ok")
        return None

    def _go(self, args: list[str], now: float) -> str | None:
        """`go x y z speed` (drone frame, cm) or `go x y z speed mN` (pad N's frame, while seen)."""
        if len(args) not in (4, 5) or not all(a.lstrip("-").isdigit() for a in args[:4]):
            return "error"
        x, y, z, speed = (int(a) for a in args[:4])
        if max(abs(x), abs(y), abs(z)) > GO_RANGE_CM or not SPEED_RANGE[0] <= speed <= SPEED_RANGE[1]:
            return "error"
        pose = self._pose
        if len(args) == 5:
            mark = args[4].lower()
            if not (mark.startswith("m") and mark[1:].lstrip("-").isdigit()):
                return "error"
            want = int(mark[1:])  # m-1 / m-2: whichever pad it sees
            pad = self.pad_below(pose)
            if pad is None or (want > 0 and pad[0] != want):
                return "error No mission pad detected"
            _, (px, py, pz) = pad
            # The pad's frame is taken to be the room's (see the module docstring): into the drone's.
            wx, wy, wz = px + x / 100 - pose.x, py + y / 100 - pose.y, pz + z / 100 - pose.z
            c, s = math.cos(math.radians(pose.yaw)), math.sin(math.radians(pose.yaw))
            f, l, u = wx * c + wy * s, -wx * s + wy * c, wz  # the pad camera guides it: no drift
        else:
            if max(abs(x), abs(y), abs(z)) < GO_MIN_CM:
                return "error"
            k = 1 + self.drift * self._rng.uniform(-1, 1)
            f, l, u = x / 100 * k, y / 100 * k, z / 100 * k
        imu = self._imu()
        if imu == "stay":
            return IMU_ERROR
        blocked = self.obstacles.check_go(pose, f, l, u)
        if blocked:
            return self._blocked(blocked)
        length_cm = math.sqrt(f * f + l * l + u * u) * 100
        self._motion = _Motion("move", pose, pose.moved(forward=f, left=l, up=u), now, length_cm / speed + SETTLE_S,
                               reply=IMU_ERROR if imu == "moved" else "ok")
        return None

    def _turn(self, cmd: str, args: list[str], now: float) -> str | None:
        deg = _int_arg(args, *TURN_RANGE_DEG)
        if deg is None:
            return "error"
        turn = (-deg if cmd == "cw" else deg) * (1 + self.drift * 2 / 3 * self._rng.uniform(-1, 1))  # world yaw: counterclockwise
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

    def carry(self, pose: Pose) -> bool:
        """Picked up on the ground and put down at `pose`, as a person would. The IMU keeps its
        yaw 0 (it was not switched off), so the telemetry yaw shows the new heading."""
        if self.flying or self.busy:
            return False
        self._pose = pose
        return True

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
        if self.flying and not self._motion and self.drift > 0 and dt > 0:
            self._hover_slide(dt)
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

    def _hover_slide(self, dt: float) -> None:
        """A hovering Tello holds its spot with its downward camera, not perfectly: a slow slide
        whose speed wanders (at most SLIDE_MAX_M_S). That is under one unit of the telemetry's
        ground speed (12.2 cm/s), so the telemetry reads 0 and nothing on the server notices."""
        a = math.exp(-dt / SLIDE_TAU_S)
        sigma = SLIDE_MAX_M_S / 2 * math.sqrt(1 - a * a)
        vx = a * self._slide[0] + sigma * self._slide_rng.gauss(0, 1)
        vy = a * self._slide[1] + sigma * self._slide_rng.gauss(0, 1)
        speed = math.hypot(vx, vy)
        if speed > SLIDE_MAX_M_S:
            vx, vy = vx * SLIDE_MAX_M_S / speed, vy * SLIDE_MAX_M_S / speed
        self._slide = (vx, vy)
        p = self._pose
        self._pose = replace(p, x=p.x + vx * dt, y=p.y + vy * dt)

    # ---- telemetry
    def velocity(self, now: float) -> tuple[float, float, float]:
        """World velocity in m/s: the motion under way, or the hover slide."""
        if self._motion:
            return self._motion.velocity(now)
        return (*self._slide, 0.0) if self.flying else (0.0, 0.0, 0.0)

    def ground_speed(self, now: float) -> tuple[int, int, int]:
        """`vgx vgy vgz` as the real Tello EDU gives them: compass axes, opposite sign, 12.2 cm/s
        per unit. Compass x is where the IMU yaw is 0; compass y is 90 degrees clockwise from it."""
        vx, vy, vz = self.velocity(now)
        c, s = math.cos(math.radians(self._yaw0)), math.sin(math.radians(self._yaw0))
        along, across = vx * c + vy * s, vx * s - vy * c  # onto compass x and y
        unit = VG_CM_S_PER_UNIT / 100
        return round(-along / unit), round(-across / unit), round(-vz / unit)

    def height_cm(self, now: float) -> int:
        """`h`: above the takeoff spot while flying, 0 once the motors are off."""
        return max(0, round((self.pose_at(now).z - self._takeoff_z) * 100)) if self.flying else 0

    def tof_cm(self, now: float) -> int:
        """`tof`: from the drone's bottom to what is under it (the sensor reads at least 10)."""
        pose = self.pose_at(now)
        gap = pose.z - HEIGHT_M / 2 - self.obstacles.ground_below(pose)
        return max(10, round(gap * 100))

    def pad_below(self, pose: Pose) -> Optional[tuple[int, tuple]]:
        """The mission pad the downward camera sees, if pads are on: (number, its position)."""
        if not self.pads_on:
            return None
        for pid, (px, py, pz) in sorted(self.mission_pads.items()):
            if PAD_HEIGHTS[0] <= pose.z - pz <= PAD_HEIGHTS[1] and abs(pose.x - px) <= PAD_REACH and abs(pose.y - py) <= PAD_REACH:
                return pid, (px, py, pz)
        return None

    def state(self, now: Optional[float] = None) -> str:
        """The telemetry datagram, in the Tello EDU's format. `yaw` is the IMU's, clockwise from
        where the drone faced when switched on; `mpry`'s yaw is clockwise from the pad's +x."""
        now = self.clock() if now is None else now
        pose = self.pose_at(now)
        yaw = round((-(pose.yaw - self._yaw0) + 180) % 360 - 180)
        pad = self.pad_below(pose)
        if pad is None:
            mission = "mid:-1;x:-100;y:-100;z:-100;mpry:0,0,0;"
        else:
            pid, (px, py, pz) = pad
            pad_yaw = round((-pose.yaw + 180) % 360 - 180)
            mission = f"mid:{pid};x:{round((pose.x - px) * 100)};y:{round((pose.y - py) * 100)};z:{round((pose.z - pz) * 100)};mpry:0,0,{pad_yaw};"
        vgx, vgy, vgz = self.ground_speed(now)
        return (f"{mission}pitch:0;roll:0;yaw:{yaw};vgx:{vgx};vgy:{vgy};vgz:{vgz};"
                f"templ:63;temph:65;tof:{self.tof_cm(now)};h:{self.height_cm(now)};bat:{max(0, round(self.battery))};"
                f"baro:{50 + pose.z:.2f};time:{int(self.flight_time)};agx:0.00;agy:0.00;agz:-1000.00;\r\n")

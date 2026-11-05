"""Simulated Tellos on UDP, for metoera-voice and metoera-vision to use instead of real drones.

    python -m metoera_sim.serve venue                       # the event venue, from the floor plan
    python -m metoera_sim.serve scenes/practice             # both drones, in an aligned scan
    python -m metoera_sim.serve synthetic --drones tello    # the install check's synthetic room

In the venue (venue.py) the drones start where they are placed on the voice page's Room panel
(or TELLO_START / RMTT_START in sim.env), the Room panel's tables are furniture, and changes made
there are followed while the simulator runs: furniture is rebuilt, a landed drone moved on the
plan is carried there.

Each drone listens on this computer only (127.0.0.1):

    tello  commands on 9001, telemetry to 8880, video from 50001 to 11111, serial SIMTELLO0001
    rmtt   commands on 9002, telemetry to 8881, video from 50002 to 11111, serial SIMRMTT00002

Replies go to one fixed port of whoever sent the command, as the real drone's do: 8879 here
(`--reply-port`), not the real 8889, so a voice server flying real drones on the same laptop
keeps its ports. Telemetry and video go to whoever sent `command`. The two drones need their
own telemetry ports because both live at 127.0.0.1 and the voice server tells telemetry apart
by address only. sim.env sets the voice server to match.

Then, in two more terminals:

    metoera-voice:   node --env-file=../metoera-sim/sim.env server.ts
    metoera-vision:  python -m metoera_vision --port 18800 --drones tello=127.0.0.1:50001,rmtt=127.0.0.1:50002

In a scan, tello starts on the takeoff pad facing +x; rmtt on pad B (from scene.json), or 1 m to
the left.

Moves drift by 3 % (--drift), as a real Tello's do, and the drones see the mission pads marked
in the viewer (after `mon`), so the voice server's position tracking can be tried here.

Every run writes a flight log, runs/<date-time>.jsonl: commands, replies, the moves the
simulator itself refused ("would_hit": the voice server's guard let them through), and five
times a second each drone's pose and clearance (the distance from its body to the scan).
tools/rehearse.mjs in metoera-voice reads it.
"""

from __future__ import annotations

import argparse
import json
import math
import select
import socket
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional, TextIO

from .camera import Pose
from .drone import LANDED_Z, MARGIN_M, Obstacles, camera_pose
from .tello import SimTello
from .video import FPS, H264Encoder, datagrams

DRONES = {
    "tello": dict(serial="SIMTELLO0001", command_port=9001, state_port=8880, video_port=50001),
    "rmtt": dict(serial="SIMRMTT00002", command_port=9002, state_port=8881, video_port=50002),
}
REPLY_PORT = 8879  # TELLO_LOCAL_PORT in sim.env; the real drones answer to 8889
VIDEO_PORT = 11111
STATE_HZ = 10
SYNTHETIC_PADS = {"b": (2.0, -1.0)}  # the magenta pad of check.synthetic_room()
LOG_HZ = 5
ROOM_CHECK_S = 1.0  # how often the venue looks for changes made on the Room panel
NEAR_PERSON_M = 0.3  # the flight log notes a person this close to a flying drone
RUNS = Path(__file__).resolve().parent.parent / "runs"


def log(name: str, text: str) -> None:
    print(f"{time.strftime('%H:%M:%S')} {name:5} {text}", flush=True)


class FlightLog:
    """One JSON object per line: {"t": seconds since the epoch, "drone": name, "kind": ..., ...}."""

    def __init__(self, path: Optional[Path]) -> None:
        self.path = path
        self._file: Optional[TextIO] = None
        if path:
            path.parent.mkdir(parents=True, exist_ok=True)
            self._file = path.open("a", encoding="utf-8")

    def write(self, drone: str, kind: str, **data) -> None:
        if self._file:
            self._file.write(json.dumps({"t": round(time.time(), 3), "drone": drone, "kind": kind, **data}) + "\n")
            self._file.flush()

    def close(self) -> None:
        if self._file:
            self._file.close()


def _udp(bind: str, port: int) -> socket.socket:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.bind((bind, port))
    s.setblocking(False)
    return s


@dataclass
class Drone:
    name: str
    sim: SimTello
    state_port: int
    reply_port: int
    commands: socket.socket
    video_out: socket.socket
    state_out: socket.socket
    verbose: bool = False
    flight_log: FlightLog = field(default_factory=lambda: FlightLog(None))
    commander: Optional[str] = None  # who sent `command`: telemetry and video go there
    last_sender: Optional[str] = None  # replies of moves that end later go there
    encoder: Optional[H264Encoder] = None
    sent_bytes: int = field(default=0)
    near_person: bool = False  # for logging a near miss once, when it starts

    def poll(self) -> None:
        while True:
            try:
                data, (host, _port) = self.commands.recvfrom(2048)
            except (BlockingIOError, InterruptedError):
                return
            except ConnectionResetError:
                continue  # Windows: an earlier reply hit a closed port; nothing to do
            text = data.decode("utf-8", "replace").replace("\0", "").strip()
            if text.lower() == "command":
                self.commander = host
            self.last_sender = host
            quiet = text.endswith("?") and not self.verbose  # the server's keep-alive `battery?`
            if not quiet:
                log(self.name, f"<- {text}")
                self.flight_log.write(self.name, "command", text=text)
            for reply in self.sim.receive(text):
                self.reply(reply, host, quiet)
            self.drain_events()

    def reply(self, text: str, host: str, quiet: bool = False) -> None:
        try:
            self.commands.sendto(text.encode(), (host, self.reply_port))
        except OSError as e:
            log(self.name, f"cannot reply to {host}:{self.reply_port}: {e}")
        if not quiet:
            log(self.name, f"-> {text}")
            self.flight_log.write(self.name, "reply", text=text)

    def step(self) -> None:
        for reply in self.sim.step():
            if self.last_sender:
                self.reply(reply, self.last_sender)
        self.drain_events()

    def drain_events(self) -> None:
        while self.sim.events:
            event = self.sim.events.pop(0)
            log(self.name, f"!! {event}")
            kind = "would_hit" if event.startswith("blocked:") else "event"
            self.flight_log.write(self.name, kind, text=event)

    def log_state(self, obstacles) -> None:
        if not self.sim.sdk:
            return
        p = self.sim.pose
        airborne = self.sim.flying and self.sim.height_cm(self.sim.clock()) >= 10  # not spinning up on the pad
        clear = obstacles.clearance(p) if airborne else math.inf
        person = obstacles.person_clearance(p) if airborne and hasattr(obstacles, "person_clearance") else math.inf
        cm = lambda m: None if math.isinf(m) else round(m * 100, 1)  # noqa: E731
        self.flight_log.write(self.name, "state", x=round(p.x, 3), y=round(p.y, 3), z=round(p.z, 3), yaw=round(p.yaw, 1),
                              flying=self.sim.flying, clearance_cm=cm(clear), person_clearance_cm=cm(person))
        near = person < NEAR_PERSON_M
        if near and not self.near_person:
            text = f"a person within {person * 100:.0f} cm of the drone"
            log(self.name, f"!! {text}")
            self.flight_log.write(self.name, "near_person", text=text, cm=cm(person))
        self.near_person = near

    def send_state(self) -> None:
        if self.commander and self.sim.sdk:
            try:
                self.state_out.sendto(self.sim.state().encode(), (self.commander, self.state_port))
            except OSError:
                pass

    def send_frame(self, renderer, splats_for) -> None:
        """One video frame; `splats_for(camera pose)` gives the scene seen from there (the people
        turn to face the camera)."""
        if not (self.commander and self.sim.video):
            return
        if self.encoder is None:
            self.encoder = H264Encoder(renderer.k.width, renderer.k.height)
            log(self.name, f"video: {self.encoder.name}, {renderer.k.width}x{renderer.k.height} at {FPS} fps to {self.commander}:{VIDEO_PORT}")
        eye = camera_pose(self.sim.pose)
        view = renderer.render(splats_for(eye), eye, yuv420p=True)
        for chunk in datagrams(self.encoder.encode(view.yuv)):
            try:
                self.video_out.sendto(chunk, (self.commander, VIDEO_PORT))
                self.sent_bytes += len(chunk)
            except (BlockingIOError, ConnectionResetError):
                pass  # receiver busy or not there yet: drop, like a lossy Wi-Fi link


@dataclass
class World:
    """What the drones fly in: splats, mission pads {number: (x, y, z)}, and where each drone
    starts {name: (x, y, z of the body centre, heading)}."""

    splats: object
    mission_pads: dict
    starts: dict
    room_mtime: Optional[float] = None  # the venue: .room.json's time when it was read


def load(scene_arg: str, max_gaussians: Optional[int], margin: float) -> World:
    if scene_arg == "venue":
        return load_venue()
    if scene_arg == "synthetic":
        from .check import synthetic_room
        from .room import SYNTHETIC_PADS as MISSION_PADS

        splats, pads, mission = synthetic_room(posters=True), dict(SYNTHETIC_PADS), dict(MISSION_PADS)
    else:
        from .scene import load_scene

        scene = load_scene(scene_arg, max_gaussians=max_gaussians)
        if "origin" not in scene.meta.get("aligned", []):
            print(f"warning: {scene_arg} is not aligned yet (no takeoff pad): run the viewer and save with p first")
        pads = {k: (float(v[0]), float(v[1])) for k, v in scene.meta.get("pads", {}).items()}
        splats, mission = scene.splats, scene.meta.get("mission_pads", {})
    # tello on the takeoff pad facing +x; rmtt on pad B, or 1 m to the left.
    obstacles = Obstacles(splats, margin=margin)
    starts = {}
    for name, (x, y) in (("tello", (0.0, 0.0)), ("rmtt", pads.get("b", (0.0, 1.0)))):
        starts[name] = (x, y, obstacles.ground_below(Pose(x, y, 0.5)) + LANDED_Z, 0.0)
    return World(splats, mission, starts)


def load_venue(pads: Optional[dict] = None) -> World:
    """The Capannone Gragnani from metoera-voice's floor plan, with the furniture, drone spots
    and phones of the voice server's .room.json (see venue.py). The mission pads: `pads`, or
    pad 1 under Black's spot and pad 2 two metres ahead of it."""
    from . import venue

    path = venue.data_dir() / ".room.json"
    config = venue.room_config()
    objects = config.get("objects", [])
    spots = venue.start_spots(config)
    pads = pads if pads is not None else venue.default_pads(spots, objects)
    starts = {name: (x, y, venue.surface_height(objects, x, y) + LANDED_Z, heading) for name, (x, y, heading) in spots.items()}
    return World(venue.build(venue.load_plan(), objects, pads), pads, starts, path.stat().st_mtime)


def venue_changed(world: World) -> Optional[World]:
    """The venue again if the Room panel changed .room.json since it was read, else None."""
    from . import venue

    try:
        mtime = (venue.data_dir() / ".room.json").stat().st_mtime
    except OSError:
        return None
    if world.room_mtime is None or mtime == world.room_mtime:
        return None
    try:
        return load_venue(world.mission_pads)  # the pads stay where they lie
    except (OSError, ValueError, KeyError) as e:
        print(f"venue: cannot read the Room panel's changes ({e}); keeping the old room")
        world.room_mtime = mtime
        return None


def follow_room(world: World, previous: dict, drones: list[Drone], margin: float, crowd, since_start):
    """The Room panel changed .room.json (the venue was rebuilt with its furniture): carry a
    landed drone whose spot was changed on the plan (`previous`: the spots before) to it, as a
    person would. A drone whose spot did not change stays where it really is."""
    from .people import Composer, WithPeople

    obstacles = WithPeople(Obstacles(world.splats, margin=margin), crowd, since_start)
    for d in drones:
        d.sim.obstacles = obstacles
        x, y, z, heading = world.starts[d.name]
        px, py, _, ph = previous.get(d.name, (None, None, None, None))
        moved = px is None or abs(px - x) > 0.02 or abs(py - y) > 0.02 or abs(ph - heading) > 1
        if moved and not d.sim.flying and not d.sim.busy:
            d.sim.carry(Pose(x, y, z, heading))
            log(d.name, f"carried to ({x:+.2f}, {y:+.2f}), facing {heading:.0f} deg (moved on the Room panel)")
            d.flight_log.write(d.name, "event", text=f"carried to {x:.2f},{y:.2f} facing {heading:.0f}")
    log("room", f"venue rebuilt from the Room panel: {len(world.splats):,} Gaussians")
    return world, obstacles, Composer(world.splats, crowd)


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Simulated Tellos on UDP, flying in a scanned room.")
    p.add_argument("scene", help='"venue" (the event venue), a scene folder (aligned with the viewer), or "synthetic"')
    p.add_argument("--drones", default="tello,rmtt", help="which drones: tello, rmtt or both (default)")
    p.add_argument("--margin", type=float, default=MARGIN_M, help="metres kept clear around the body (default 0.05)")
    p.add_argument("--battery", type=float, default=90.0, help="starting battery, percent")
    p.add_argument("--bind", default="127.0.0.1", help="address the drones listen on (default: this computer only)")
    p.add_argument("--reply-port", type=int, default=REPLY_PORT,
                   help=f"port the replies go to (default {REPLY_PORT}, as in sim.env; 8889 for tools/test-flight.mjs)")
    p.add_argument("--max-gaussians", type=int, default=None)
    p.add_argument("--verbose", action="store_true", help="also log the `battery?` keep-alives")
    p.add_argument("--drift", type=float, default=0.03, help="how far moves come out off, as a fraction (default 0.03)")
    p.add_argument("--seed", type=int, default=None, help="repeatable drift")
    p.add_argument("--imu-zero-at-start", action="store_true",
                   help="the IMU yaw reads 0 at the start (default: switched on facing some other way, as usual)")
    p.add_argument("--imu-errors", type=float, default=0.0,
                   help="chance that a move answers `error No valid imu` (default 0; half of those move anyway)")
    p.add_argument("--no-log", action="store_true", help="no flight log in runs/")
    p.add_argument("--no-phones", action="store_true", help="no simulated red-zone phones in the venue")
    p.add_argument("--phones-idle", action="store_true", help="phones wait for the console's watch, like real ones")
    p.add_argument("--people", default=None,
                   help="people.json of who stands and walks where (default in the venue: venue/people.json; none elsewhere)")
    a = p.parse_args(argv)
    sys.stdout.reconfigure(line_buffering=True)  # the log shows up at once, even in a file

    names = [n.strip() for n in a.drones.split(",") if n.strip()]
    unknown = [n for n in names if n not in DRONES]
    if unknown or not names:
        p.error(f"--drones: use tello, rmtt or tello,rmtt (got {a.drones})")

    from .render import Renderer

    t0 = time.perf_counter()
    world = load(a.scene, a.max_gaussians, a.margin)
    splats, mission_pads = world.splats, world.mission_pads
    flight_log = FlightLog(None if a.no_log else RUNS / f"{time.strftime('%Y%m%d-%H%M%S')}.jsonl")
    from .people import Composer, Crowd, WithPeople, load_people

    walkers = load_people(Path(a.people)) if a.people else (load_people() if a.scene == "venue" else [])
    crowd = Crowd(walkers) if walkers else None
    started = time.monotonic()
    since_start = lambda: time.monotonic() - started  # noqa: E731  (the people's clock)
    obstacles = WithPeople(Obstacles(splats, margin=a.margin), crowd, since_start)
    composer = Composer(splats, crowd)
    renderer = Renderer()
    print(f"{len(splats):,} Gaussians ({len(obstacles.static.points):,} solid) loaded in {time.perf_counter() - t0:.1f} s; "
          f"the drone is a {98 + 2000 * a.margin:.0f} x {92.5 + 2000 * a.margin:.0f} x {41 + 2000 * a.margin:.0f} mm box")
    for w in walkers:
        print(f"  person: {w.name}, " + (f"standing at {w.path[0]}" if len(w.path) == 1 else
                                         f"walking {len(w.path)} points at {w.speed} m/s from {w.start_after:.0f} s"))

    # Where each drone faced when it was switched on: its IMU yaw is 0 there. A real drone is
    # usually switched on and then put down on its spot, so by default somewhere else (seeded).
    import random

    switched_on = {}
    for i, name in enumerate(DRONES):
        heading = world.starts[name][3]
        turn = 0.0 if a.imu_zero_at_start else random.Random(None if a.seed is None else a.seed * 7 + i).uniform(-180, 180)
        switched_on[name] = heading + turn

    drones: list[Drone] = []
    for i, name in enumerate(names):
        spec = DRONES[name]
        x, y, z, heading = world.starts[name]
        sim = SimTello(name, spec["serial"], Pose(x, y, z, heading), obstacles, battery=a.battery,
                       drift=a.drift, seed=None if a.seed is None else a.seed + i, mission_pads=mission_pads,
                       imu_errors=a.imu_errors, switched_on_yaw=switched_on[name])
        try:
            drone = Drone(name, sim, spec["state_port"], a.reply_port, _udp(a.bind, spec["command_port"]),
                          _udp(a.bind, spec["video_port"]), _udp(a.bind, 0), verbose=a.verbose, flight_log=flight_log)
        except OSError as e:
            print(f"{name}: cannot open its UDP ports ({e}); is another simulator running?")
            return 1
        drones.append(drone)
        print(f"  {name:5} at ({x:+.2f}, {y:+.2f}) m, {z - LANDED_Z:.2f} m up, facing {heading:.0f} deg "
              f"(switched on facing {switched_on[name] % 360:.0f}): "
              f"commands on {a.bind}:{spec['command_port']} (replies to :{a.reply_port}), "
              f"telemetry to :{spec['state_port']}, video from :{spec['video_port']} to :{VIDEO_PORT}, serial {spec['serial']}")
    print(f"  moves drift {a.drift:.0%}; mission pads {', '.join(sorted(map(str, mission_pads))) or 'none (mark them in the viewer: m)'}"
          + (f"; flight log {flight_log.path}" if flight_log.path else ""))
    vision = ",".join(f"{d.name}=127.0.0.1:{DRONES[d.name]['video_port']}" for d in drones)
    print("Then:\n  metoera-voice:   node --env-file=../metoera-sim/sim.env server.ts   (page: http://localhost:18797)\n"
          f"  metoera-vision:  python -m metoera_vision --port 18800 --drones {vision}\nCtrl+C stops.")
    if world.room_mtime is not None:
        print("The Room panel's tables, drone spots and phones are followed while this runs.")

    # The phones draw the same scene from their own thread: one at a time with the drones' video,
    # because the people's Gaussians are rewritten in place for each camera.
    scene_lock = threading.Lock()
    current = {"composer": composer}
    phones = None
    if a.scene == "venue" and not a.no_phones:
        from . import venue
        from .camera import Intrinsics
        from .phones import Phones, yolo_people

        renderers: dict[Intrinsics, Renderer] = {}

        def render_phone(pose: Pose, k: Intrinsics):
            r = renderers.get(k) or renderers.setdefault(k, Renderer(k))
            with scene_lock:
                return r.render(current["composer"].for_eye(since_start(), (pose.x, pose.y)), pose).image

        base = venue.sim_env().get("REDZONE_URL", "http://127.0.0.1:18801")
        phones = Phones(base, render_phone, yolo_people(), watching=not a.phones_idle, log=lambda text: log("phone", text))
        phones.place(venue.room_config().get("cameras", {}))
        if phones.phones:
            print(f"Phones {', '.join(sorted(phones.phones))} talk to the red-zone service at {base}:\n"
                  "  metoera-redzone:  node --env-file=../metoera-sim/sim.env server.mjs   (console: http://127.0.0.1:18801/console)")
        phones.start()

    frame_period, state_period, log_period = 1.0 / FPS, 1.0 / STATE_HZ, 1.0 / LOG_HZ
    next_frame = next_state = next_log = next_room = time.monotonic()
    sockets = [d.commands for d in drones]
    try:
        while True:
            now = time.monotonic()
            wait = max(0.0, min(next_frame, next_state, now + 0.02) - now)
            ready, _, _ = select.select(sockets, [], [], wait)
            for d in drones:
                if d.commands in ready:
                    d.poll()
                d.step()
            now = time.monotonic()
            if now >= next_state:
                for d in drones:
                    d.send_state()
                next_state = max(next_state + state_period, now)
            if now >= next_log:
                for d in drones:
                    d.log_state(obstacles)
                next_log = max(next_log + log_period, now)
            if now >= next_room:
                changed = venue_changed(world)
                if changed:
                    with scene_lock:
                        world, obstacles, current["composer"] = follow_room(changed, world.starts, drones, a.margin, crowd, since_start)
                    if phones:
                        from . import venue

                        phones.place(venue.room_config().get("cameras", {}))
                next_room = now + ROOM_CHECK_S
            if now >= next_frame:
                t_people = since_start()
                with scene_lock:
                    for d in drones:
                        d.send_frame(renderer, lambda eye: current["composer"].for_eye(t_people, (eye.x, eye.y)))
                next_frame = max(next_frame + frame_period, now)  # fell behind: skip frames, don't catch up
    except KeyboardInterrupt:
        print("stopped")
    finally:
        if phones:
            phones.stop()
        for d in drones:
            for s in (d.commands, d.video_out, d.state_out):
                s.close()
        flight_log.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())

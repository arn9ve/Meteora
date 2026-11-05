"""Simulated Tellos on UDP, for metoera-voice and metoera-vision to use instead of real drones.

    python -m metoera_sim.serve scenes/practice             # both drones, in an aligned scan
    python -m metoera_sim.serve synthetic --drones tello    # the install check's synthetic room

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
    metoera-vision:  python -m metoera_vision --drones tello=127.0.0.1:50001,rmtt=127.0.0.1:50002

tello starts on the takeoff pad facing +x; rmtt on pad B (from scene.json), or 1 m to the left.
"""

from __future__ import annotations

import argparse
import select
import socket
import sys
import time
from dataclasses import dataclass, field
from typing import Optional

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


def log(name: str, text: str) -> None:
    print(f"{time.strftime('%H:%M:%S')} {name:5} {text}", flush=True)


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
    commander: Optional[str] = None  # who sent `command`: telemetry and video go there
    last_sender: Optional[str] = None  # replies of moves that end later go there
    encoder: Optional[H264Encoder] = None
    sent_bytes: int = field(default=0)

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

    def step(self) -> None:
        for reply in self.sim.step():
            if self.last_sender:
                self.reply(reply, self.last_sender)
        self.drain_events()

    def drain_events(self) -> None:
        while self.sim.events:
            log(self.name, f"!! {self.sim.events.pop(0)}")

    def send_state(self) -> None:
        if self.commander and self.sim.sdk:
            try:
                self.state_out.sendto(self.sim.state().encode(), (self.commander, self.state_port))
            except OSError:
                pass

    def send_frame(self, renderer, splats) -> None:
        if not (self.commander and self.sim.video):
            return
        if self.encoder is None:
            self.encoder = H264Encoder(renderer.k.width, renderer.k.height)
            log(self.name, f"video: {self.encoder.name}, {renderer.k.width}x{renderer.k.height} at {FPS} fps to {self.commander}:{VIDEO_PORT}")
        view = renderer.render(splats, camera_pose(self.sim.pose), yuv420p=True)
        for chunk in datagrams(self.encoder.encode(view.yuv)):
            try:
                self.video_out.sendto(chunk, (self.commander, VIDEO_PORT))
                self.sent_bytes += len(chunk)
            except (BlockingIOError, ConnectionResetError):
                pass  # receiver busy or not there yet: drop, like a lossy Wi-Fi link


def load(scene_arg: str, max_gaussians: Optional[int]):
    """(splats in the world frame, pads {name: (x, y)})."""
    if scene_arg == "synthetic":
        from .check import synthetic_room

        return synthetic_room(), dict(SYNTHETIC_PADS)
    from .scene import load_scene

    scene = load_scene(scene_arg, max_gaussians=max_gaussians)
    if "origin" not in scene.meta.get("aligned", []):
        print(f"warning: {scene_arg} is not aligned yet (no takeoff pad): run the viewer and save with p first")
    pads = {k: (float(v[0]), float(v[1])) for k, v in scene.meta.get("pads", {}).items()}
    return scene.splats, pads


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Simulated Tellos on UDP, flying in a scanned room.")
    p.add_argument("scene", help='scene folder (aligned with the viewer), or "synthetic"')
    p.add_argument("--drones", default="tello,rmtt", help="which drones: tello, rmtt or both (default)")
    p.add_argument("--margin", type=float, default=MARGIN_M, help="metres kept clear around the body (default 0.05)")
    p.add_argument("--battery", type=float, default=90.0, help="starting battery, percent")
    p.add_argument("--bind", default="127.0.0.1", help="address the drones listen on (default: this computer only)")
    p.add_argument("--reply-port", type=int, default=REPLY_PORT,
                   help=f"port the replies go to (default {REPLY_PORT}, as in sim.env; 8889 for tools/test-flight.mjs)")
    p.add_argument("--max-gaussians", type=int, default=None)
    p.add_argument("--verbose", action="store_true", help="also log the `battery?` keep-alives")
    a = p.parse_args(argv)
    sys.stdout.reconfigure(line_buffering=True)  # the log shows up at once, even in a file

    names = [n.strip() for n in a.drones.split(",") if n.strip()]
    unknown = [n for n in names if n not in DRONES]
    if unknown or not names:
        p.error(f"--drones: use tello, rmtt or tello,rmtt (got {a.drones})")

    from .render import Renderer

    t0 = time.perf_counter()
    splats, pads = load(a.scene, a.max_gaussians)
    obstacles = Obstacles(splats, margin=a.margin)
    renderer = Renderer()
    print(f"{len(splats):,} Gaussians ({len(obstacles.points):,} solid) loaded in {time.perf_counter() - t0:.1f} s; "
          f"the drone is a {98 + 2000 * a.margin:.0f} x {92.5 + 2000 * a.margin:.0f} x {41 + 2000 * a.margin:.0f} mm box")

    drones: list[Drone] = []
    for i, name in enumerate(names):
        spec = DRONES[name]
        x, y = (0.0, 0.0) if name == "tello" else pads.get("b", (0.0, 1.0))
        ground = obstacles.ground_below(Pose(x, y, 0.5))
        sim = SimTello(name, spec["serial"], Pose(x, y, ground + LANDED_Z, 0.0), obstacles, battery=a.battery)
        try:
            drone = Drone(name, sim, spec["state_port"], a.reply_port, _udp(a.bind, spec["command_port"]),
                          _udp(a.bind, spec["video_port"]), _udp(a.bind, 0), verbose=a.verbose)
        except OSError as e:
            print(f"{name}: cannot open its UDP ports ({e}); is another simulator running?")
            return 1
        drones.append(drone)
        print(f"  {name:5} at ({x:+.2f}, {y:+.2f}) m: commands on {a.bind}:{spec['command_port']} (replies to :{a.reply_port}), "
              f"telemetry to :{spec['state_port']}, video from :{spec['video_port']} to :{VIDEO_PORT}, serial {spec['serial']}")
    vision = ",".join(f"{d.name}=127.0.0.1:{DRONES[d.name]['video_port']}" for d in drones)
    print("Then:\n  metoera-voice:   node --env-file=../metoera-sim/sim.env server.ts   (page: http://localhost:18797)\n"
          f"  metoera-vision:  python -m metoera_vision --drones {vision}\nCtrl+C stops.")

    frame_period, state_period = 1.0 / FPS, 1.0 / STATE_HZ
    next_frame = next_state = time.monotonic()
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
            if now >= next_frame:
                for d in drones:
                    d.send_frame(renderer, splats)
                next_frame = max(next_frame + frame_period, now)  # fell behind: skip frames, don't catch up
    except KeyboardInterrupt:
        print("stopped")
    finally:
        for d in drones:
            for s in (d.commands, d.video_out, d.state_out):
                s.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())

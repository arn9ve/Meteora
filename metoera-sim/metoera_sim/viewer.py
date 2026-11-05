"""Fly a virtual Tello through the scan, and align the scan with the real room.

    python -m metoera_sim.viewer scenes/practice --pad-distance 2.40

Moves (like the Tello: relative to its heading; capitals for small steps):
  w / s   forward / back 20 cm        a / d   left / right 20 cm
  r / f   up / down 20 cm             q / e   turn left / right 15 degrees
  t       top view on/off             i / k   tilt the camera up / down 10 degrees
The top view looks down from 1.5 m above the drone, with everything higher than 10 cm above it
cut away (no ceiling). The drone is drawn to scale: white is its body, yellow the margin kept
clear. A move that would run into the scan says so ("blocked: ..."); the viewer moves anyway.

Aligning (press the key, then click in the picture):
  g  click the floor          -> the floor becomes level and sits at height 0
  o  click the takeoff pad    -> it becomes (0, 0, 0); the current heading becomes +x
  1  click mission pad A      2  click mission pad B
                              -> with --pad-distance (metres, tape-measured) the scale is fixed
  x / y / z  turn the whole scan 90 degrees about that axis (when it starts sideways)

  p  save scene.json          h  help on/off          Esc  quit
"""

from __future__ import annotations

import argparse
import math
import sys
import time
from dataclasses import replace

import numpy as np

from .camera import Intrinsics, Pose, project, unproject
from .drone import DIRECTIONS, LENGTH_M, MARGIN_M, WIDTH_M, Obstacles, camera_pose, half_extents
from .render import Renderer
from .scene import Scene, load_scene, rot_x, rot_y, rot_z, rotation_between, scale, translate

WINDOW = "metoera-sim viewer"
TOP_HEIGHT_M = 1.5  # the top view's camera, above the drone
TOP_CUT_M = 0.10  # ... and what it cuts away: everything this far above the drone and higher
UP_AXES = {"x": (1, 0, 0), "-x": (-1, 0, 0), "y": (0, 1, 0), "-y": (0, -1, 0), "z": (0, 0, 1), "-z": (0, 0, -1)}
PROMPTS = {
    "floor": "click the FLOOR",
    "origin": "click the centre of the TAKEOFF pad",
    "pad_a": "click the centre of mission pad A",
    "pad_b": "click the centre of mission pad B",
}


def fit_plane(points: np.ndarray, iters: int = 400, thresh: float = 0.02, seed: int = 0):
    """RANSAC plane through `points`: (unit normal, a point on it, share of inliers)."""
    rng = np.random.default_rng(seed)
    n = len(points)
    best_count, best = 0, None
    for _ in range(iters):
        a, b, c = points[rng.choice(n, 3, replace=False)]
        normal = np.cross(b - a, c - a)
        length = np.linalg.norm(normal)
        if length < 1e-9:
            continue
        normal /= length
        count = int((np.abs((points - a) @ normal) < thresh).sum())
        if count > best_count:
            best_count, best = count, (normal, a)
    if best is None:
        raise ValueError("no plane found")
    normal, a = best
    inliers = points[np.abs((points - a) @ normal) < thresh]
    centre = inliers.mean(axis=0)
    normal = np.linalg.svd(inliers - centre)[2][-1]  # refine with every inlier
    return normal / np.linalg.norm(normal), centre, len(inliers) / n


class Viewer:
    def __init__(self, scene: Scene, pad_distance: float | None, renderer: Renderer, margin: float = MARGIN_M) -> None:
        self.scene = scene
        self.margin = margin
        self._obstacles: tuple[object, Obstacles] | None = None
        self.top = False
        self.pad_distance = pad_distance
        self.renderer = renderer
        self.k = renderer.k
        self.pads: dict[str, np.ndarray] = {k: np.array(v) for k, v in scene.meta.get("pads", {}).items()}
        self.done: set[str] = set(scene.meta.get("aligned", []))
        means = scene.splats.means.median(dim=0).values.cpu().numpy()
        self.pose = Pose(0.0, 0.0, 0.8, 0.0) if "origin" in self.done else Pose(*means.tolist(), 0.0)  # the body
        self.mode: str | None = None
        self.click: tuple[int, int] | None = None
        self.message = "h: help. Start with g (floor), then o (takeoff pad), then 1 and 2 (pads)."
        self.show_help = False
        self.unsaved = False
        self.ms = 0.0

    # ---- alignment: every correction T is applied to the scan, the drone and the marked pads
    def apply(self, t: np.ndarray, yaw_change: float = 0.0) -> None:
        self.scene.set_alignment(t @ self.scene.world_from_scene)
        p = (t @ np.append(self.pose.position, 1.0))[:3]
        self.pose = replace(self.pose, x=float(p[0]), y=float(p[1]), z=float(p[2]), yaw=self.pose.yaw + yaw_change)
        self.pads = {k: (t @ np.append(v, 1.0))[:3] for k, v in self.pads.items()}
        self.unsaved = True

    def turn_scan(self, axis: str) -> None:
        c = self.pose.position
        r = {"x": rot_x, "y": rot_y, "z": rot_z}[axis](90)
        self.apply(translate(c) @ r @ translate(-c))
        self.done.discard("floor")
        self.message = f"scan turned 90 degrees about {axis}"

    def view_pose(self) -> tuple[Pose, float]:
        """The camera of what the window shows, and its near plane."""
        p = self.pose
        if self.top:
            return Pose(p.x, p.y, p.z + TOP_HEIGHT_M, p.yaw, -90.0), TOP_HEIGHT_M - TOP_CUT_M
        return camera_pose(p), 0.05

    def obstacles(self) -> Obstacles:
        """The solid part of the scan, rebuilt whenever the alignment moves it."""
        if self._obstacles is None or self._obstacles[0] is not self.scene.splats:
            self._obstacles = (self.scene.splats, Obstacles(self.scene.splats, margin=self.margin))
        return self._obstacles[1]

    def pick(self, u: int, v: int) -> np.ndarray | None:
        cam, near = self.view_pose()
        view = self.renderer.render(self.scene.splats, cam, depth=True, near_plane=near)
        y0, y1, x0, x1 = max(0, v - 2), v + 3, max(0, u - 2), u + 3
        alpha = view.alpha[y0:y1, x0:x1]
        depth = view.depth[y0:y1, x0:x1][alpha > 0.5]
        if depth.size == 0:
            self.message = "nothing there: click on a surface of the scan"
            return None
        return unproject(cam, self.k, u, v, float(np.median(depth)))

    def on_pick(self, point: np.ndarray) -> None:
        mode, self.mode = self.mode, None
        if mode == "floor":
            means = self.scene.splats.means
            near = ((means - means.new_tensor(point)).norm(dim=1) < 0.6) & (self.scene.splats.opacities > 0.3)
            pts = means[near].cpu().numpy().astype(np.float64)
            if len(pts) > 20000:
                pts = pts[np.random.default_rng(0).choice(len(pts), 20000, replace=False)]
            if len(pts) < 50:
                self.message = "too few points around that click: try a spot with more floor"
                return
            normal, centre, share = fit_plane(pts)
            if np.dot(normal, self.pose.position - centre) < 0:
                normal = -normal  # up points towards the camera, which is above the floor
            tilt = math.degrees(math.acos(min(1.0, abs(float(normal[2])))))
            r = rotation_between(normal, np.array([0.0, 0.0, 1.0]))
            c = (r @ np.append(centre, 1.0))[:3]
            self.apply(translate((0.0, 0.0, -c[2])) @ r)
            self.done.add("floor")
            self.message = f"floor level (it was tilted {tilt:.1f} deg; {share:.0%} of nearby points on the plane)"
        elif mode == "origin":
            yaw = self.pose.yaw
            self.apply(rot_z(-yaw) @ translate(-point), yaw_change=-yaw)
            self.done.add("origin")
            self.message = "takeoff pad is now (0, 0, 0); the drone's heading is +x"
        elif mode in ("pad_a", "pad_b"):
            self.pads[mode[-1]] = point
            self.unsaved = True
            self.message = f"pad {mode[-1].upper()} marked"
            if "a" in self.pads and "b" in self.pads:
                measured = float(np.linalg.norm(self.pads["a"] - self.pads["b"]))
                if self.pad_distance:
                    s = self.pad_distance / measured
                    self.apply(scale(s))
                    self.done.add("scale")
                    self.message = f"pads {measured:.3f} m apart in the scan, {self.pad_distance:.3f} m for real: scaled x{s:.3f}"
                else:
                    self.message = f"pads are {measured:.3f} m apart in the scan (pass --pad-distance to fix the scale)"

    def save(self) -> None:
        meta = self.scene.meta
        meta["pads"] = {k: v.tolist() for k, v in self.pads.items()}
        meta["aligned"] = sorted(self.done)
        if self.pad_distance:
            meta["pad_distance_m"] = self.pad_distance
        path = self.scene.save()
        self.unsaved = False
        self.message = f"saved {path}"

    # ---- drawing
    def hud(self, img: np.ndarray) -> np.ndarray:
        import cv2

        p = self.pose
        lines = [
            f"x {p.x:+.2f}  y {p.y:+.2f}  z {p.z:+.2f} m   yaw {p.yaw:+.0f}  "
            + ("top view" if self.top else f"tilt {p.pitch:+.0f}") + f"   {self.ms:.0f} ms",
            f"aligned: {', '.join(sorted(self.done)) or 'nothing yet'}{'   (unsaved: p)' if self.unsaved else ''}",
            (">>> " + PROMPTS[self.mode]) if self.mode else self.message,
        ]
        if self.show_help:
            lines += [l for l in (__doc__ or "").splitlines()[4:] if l.strip()]
        y = 22
        for text in lines:
            cv2.putText(img, text, (10, y), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 0), 3, cv2.LINE_AA)
            cv2.putText(img, text, (10, y), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1, cv2.LINE_AA)
            y += 20
        for name, pt in self.pads.items():
            cv2.putText(img, f"pad {name.upper()}: {np.round(pt, 2).tolist()}", (10, self.k.height - 12 - 20 * (name == 'a')),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.45, (255, 255, 255), 1, cv2.LINE_AA)
        if self.mode:
            cv2.drawMarker(img, (self.k.width // 2, self.k.height // 2), (0, 255, 255), cv2.MARKER_CROSS, 16, 1)
        if self.top:
            self.draw_drone(img)
        return img

    def draw_drone(self, img: np.ndarray) -> None:
        """The drone to scale in the top view: its body, the margin kept clear, its heading."""
        import cv2

        cam, _ = self.view_pose()
        p = self.pose
        c, s = math.cos(math.radians(p.yaw)), math.sin(math.radians(p.yaw))

        def pixel(forward: float, left: float) -> tuple[int, int]:
            u, v, _ = project(cam, self.k, (p.x + forward * c - left * s, p.y + forward * s + left * c, p.z))
            return round(u), round(v)

        def outline(hf: float, hl: float) -> np.ndarray:
            return np.array([pixel(f, l) for f, l in ((hf, hl), (hf, -hl), (-hf, -hl), (-hf, hl))], np.int32)

        hf, hl, _ = half_extents(self.margin)
        cv2.polylines(img, [outline(hf, hl)], True, (0, 220, 255), 1, cv2.LINE_AA)  # BGR yellow
        cv2.polylines(img, [outline(LENGTH_M / 2, WIDTH_M / 2)], True, (255, 255, 255), 2, cv2.LINE_AA)
        cv2.arrowedLine(img, pixel(0.0, 0.0), pixel(hf + 0.08, 0.0), (0, 220, 255), 2, cv2.LINE_AA, tipLength=0.35)

    def move(self, kind: str, amount: float) -> None:
        """Fly the drone like the Tello, and say if the real one would hit something."""
        obstacles = self.obstacles()
        if kind == "turn":
            blocked = obstacles.check_turn(self.pose, amount)
            self.pose = self.pose.moved(turn=amount)
        else:
            axis, sign = DIRECTIONS[kind]
            blocked = obstacles.check_move(self.pose, kind, amount)
            self.pose = self.pose.moved(**{("forward", "left", "up")[axis]: sign * amount})
        if blocked:
            self.message = f"blocked: {blocked.message} (the viewer moves anyway)"
        elif self.message.startswith("blocked:"):
            self.message = ""

    def key(self, ch: str) -> bool:
        """Handle one key; returns False to quit."""
        small = ch.isupper()
        step, turn = (0.05, 5.0) if small else (0.2, 15.0)
        c = ch.lower()
        moves = {"w": ("forward", step), "s": ("back", step), "a": ("left", step), "d": ("right", step),
                 "r": ("up", step), "f": ("down", step), "q": ("turn", turn), "e": ("turn", -turn)}
        if c in moves:
            self.move(*moves[c])
        elif c == "t":
            self.top = not self.top
        elif c == "i":
            self.pose = replace(self.pose, pitch=min(90.0, self.pose.pitch + 10))
        elif c == "k":
            self.pose = replace(self.pose, pitch=max(-90.0, self.pose.pitch - 10))
        elif c in "xyz" and c:
            self.turn_scan(c)
        elif c == "g":
            self.mode = "floor"
        elif c == "o":
            self.mode = "origin"
        elif c == "1":
            self.mode = "pad_a"
        elif c == "2":
            self.mode = "pad_b"
        elif c == "p":
            self.save()
        elif c == "h":
            self.show_help = not self.show_help
        elif ch == "\x1b":
            if self.unsaved and self.message != "unsaved changes: p saves them, Esc again quits":
                self.message = "unsaved changes: p saves them, Esc again quits"
                return True
            return False
        return True

    def run(self) -> int:
        import cv2

        cv2.namedWindow(WINDOW, cv2.WINDOW_AUTOSIZE)

        def on_mouse(event, x, y, _flags, _param):
            if event == cv2.EVENT_LBUTTONDOWN:
                self.click = (x, y)

        cv2.setMouseCallback(WINDOW, on_mouse)
        while True:
            if self.click and self.mode:
                point = self.pick(*self.click)
                if point is not None:
                    self.on_pick(point)
            self.click = None
            cam, near = self.view_pose()
            view = self.renderer.render(self.scene.splats, cam, near_plane=near)
            self.ms = view.ms
            cv2.imshow(WINDOW, self.hud(cv2.cvtColor(view.image, cv2.COLOR_RGB2BGR)))
            code = cv2.waitKey(30)
            if cv2.getWindowProperty(WINDOW, cv2.WND_PROP_VISIBLE) < 1:
                break
            if code != -1 and not self.key(chr(code & 0xFF)):
                break
        cv2.destroyAllWindows()
        return 0


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Fly through a splat scan and align it with the real room.")
    p.add_argument("scene", help="scene folder with the .ply (scene.json is written there)")
    p.add_argument("--pad-distance", type=float, default=None, help="tape-measured metres between pads A and B")
    p.add_argument("--up", choices=sorted(UP_AXES), default="y",
                   help="which axis of the scan points up, before any scene.json exists (phone scans: y)")
    p.add_argument("--max-gaussians", type=int, default=None, help="thin a very large scan")
    p.add_argument("--margin", type=float, default=MARGIN_M, help="metres kept clear around the drone's body (default 0.05)")
    a = p.parse_args(argv)

    t0 = time.perf_counter()
    scene = load_scene(a.scene, max_gaussians=a.max_gaussians)
    if not scene.json_path.exists():
        scene.set_alignment(rotation_between(np.array(UP_AXES[a.up], dtype=float), np.array([0.0, 0.0, 1.0])))
    print(f"loaded {len(scene.splats):,} Gaussians in {time.perf_counter() - t0:.1f} s")
    return Viewer(scene, a.pad_distance, Renderer(), margin=a.margin).run()


if __name__ == "__main__":
    sys.exit(main())

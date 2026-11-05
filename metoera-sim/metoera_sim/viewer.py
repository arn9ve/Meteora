"""Fly a virtual Tello through the scan, and align the scan with the real room.

    python -m metoera_sim.viewer scenes/practice --pad-distance 2.40

Moves (like the Tello: relative to its heading; capitals for small steps):
  w / s   forward / back 20 cm        a / d   left / right 20 cm
  r / f   up / down 20 cm             q / e   turn left / right 15 degrees
  t       top-down view on/off        i / k   tilt the camera up / down 10 degrees

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

from .camera import Intrinsics, Pose, unproject
from .render import Renderer
from .scene import Scene, load_scene, rot_x, rot_y, rot_z, rotation_between, scale, translate

WINDOW = "metoera-sim viewer"
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
    def __init__(self, scene: Scene, pad_distance: float | None, renderer: Renderer) -> None:
        self.scene = scene
        self.pad_distance = pad_distance
        self.renderer = renderer
        self.k = renderer.k
        self.pads: dict[str, np.ndarray] = {k: np.array(v) for k, v in scene.meta.get("pads", {}).items()}
        self.done: set[str] = set(scene.meta.get("aligned", []))
        means = scene.splats.means.median(dim=0).values.cpu().numpy()
        self.pose = Pose(0.0, 0.0, 0.8, 0.0) if "origin" in self.done else Pose(*means.tolist(), 0.0)
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

    def pick(self, u: int, v: int) -> np.ndarray | None:
        view = self.renderer.render(self.scene.splats, self.pose, depth=True)
        y0, y1, x0, x1 = max(0, v - 2), v + 3, max(0, u - 2), u + 3
        alpha = view.alpha[y0:y1, x0:x1]
        depth = view.depth[y0:y1, x0:x1][alpha > 0.5]
        if depth.size == 0:
            self.message = "nothing there: click on a surface of the scan"
            return None
        return unproject(self.pose, self.k, u, v, float(np.median(depth)))

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
            f"x {p.x:+.2f}  y {p.y:+.2f}  z {p.z:+.2f} m   yaw {p.yaw:+.0f}  tilt {p.pitch:+.0f}   {self.ms:.0f} ms",
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
        return img

    def key(self, ch: str) -> bool:
        """Handle one key; returns False to quit."""
        small = ch.isupper()
        step, turn = (0.05, 5.0) if small else (0.2, 15.0)
        c = ch.lower()
        moves = {"w": dict(forward=step), "s": dict(forward=-step), "a": dict(left=step), "d": dict(left=-step),
                 "r": dict(up=step), "f": dict(up=-step), "q": dict(turn=turn), "e": dict(turn=-turn)}
        if c in moves:
            self.pose = self.pose.moved(**moves[c])
        elif c == "t":
            self.pose = replace(self.pose, pitch=0.0 if self.pose.pitch <= -89 else -90.0)
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
            view = self.renderer.render(self.scene.splats, self.pose)
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
    a = p.parse_args(argv)

    t0 = time.perf_counter()
    scene = load_scene(a.scene, max_gaussians=a.max_gaussians)
    if not scene.json_path.exists():
        scene.set_alignment(rotation_between(np.array(UP_AXES[a.up], dtype=float), np.array([0.0, 0.0, 1.0])))
    print(f"loaded {len(scene.splats):,} Gaussians in {time.perf_counter() - t0:.1f} s")
    return Viewer(scene, a.pad_distance, Renderer()).run()


if __name__ == "__main__":
    sys.exit(main())

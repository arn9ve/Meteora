"""The event venue, the Capannone Gragnani, as Gaussian splats: built from the floor plan that
metoera-voice flies by (room/capannone-gragnani.json) and the furniture placed on its Room panel.

    python -m metoera_sim.venue -o renders/venue     # a few views, to look at it

Everything is in the plan's own frame, which is also the simulator's world: metres, x to the
right and y up as drawn, z up from the floor, angles counterclockwise from +x.

- Walls: the plan's wall segments (cut through the CAD model at 1 m), as plaster surfaces from
  the floor to the ceiling (`height_m`), with a dark skirting board.
- Pillars: concrete boxes, floor to ceiling.
- Mezzanines (the plan's `above` bodies lower than the ceiling): their undersides, flat, at
  `z_m`. The drone may fly under them, not through.
- Floor and ceiling.
- Furniture from the voice server's .room.json (`objects`): tables as a top on four legs at their
  height (75 cm when none is given, as metoera-voice assumes), anything else as a solid box (1 m
  high when none is given).
- Mission pads: 20 cm squares lying on whatever is under them.

The colours are plain but distinct (white walls, grey concrete pillars, wooden tables), so the
camera picture means something to YOLO and to Grok vision's `localize`.

A missing .room.json in the voice server's data folder (METOERA_DATA_DIR in sim.env) is created
from venue/room.json: six tables, both drones placed, two phones and a red zone, so the voice
server and the simulator start from the same room.
"""

from __future__ import annotations

import argparse
import json
import math
import shutil
import sys
from pathlib import Path
from typing import Optional

import numpy as np

SIM = Path(__file__).resolve().parent.parent
REPO = SIM.parent
PLAN = REPO / "metoera-voice" / "room" / "capannone-gragnani.json"
DEFAULT_ROOM = SIM / "venue" / "room.json"
SIM_ENV = SIM / "sim.env"

STEP = 0.05  # metres between Gaussians on walls, floor and furniture
TABLE_HEIGHT_M = 0.75  # metoera-voice's default for a table without a height
BOX_HEIGHT_M = 1.0  # other furniture without a height
PAD_SIDE_M = 0.2

WALL = (0.86, 0.85, 0.81)
SKIRTING = (0.30, 0.29, 0.28)
CONCRETE = (0.58, 0.57, 0.55)
FLOOR = (0.47, 0.46, 0.44)
CEILING = (0.72, 0.72, 0.74)
MEZZANINE = (0.50, 0.40, 0.31)
TABLE_TOP = (0.74, 0.56, 0.37)
TABLE_LEG = (0.20, 0.19, 0.18)
BOX = (0.33, 0.42, 0.58)
PAD = (0.10, 0.10, 0.10)
PAD_MARK = (0.95, 0.95, 0.95)


def sim_env(path: Path = SIM_ENV) -> dict[str, str]:
    """KEY=value lines of sim.env (the drones' start spots, the voice server's data folder)."""
    out = {}
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, value = line.split("=", 1)
                out[key.strip()] = value.strip()
    return out


def data_dir(env: Optional[dict] = None) -> Path:
    """The voice server's data folder: METOERA_DATA_DIR from sim.env, relative to metoera-voice/."""
    env = sim_env() if env is None else env
    value = env.get("METOERA_DATA_DIR", "../metoera-sim/voice-data")
    return (REPO / "metoera-voice" / value).resolve()


def load_plan(path: Path = PLAN) -> dict:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def room_config(folder: Optional[Path] = None) -> dict:
    """The voice server's .room.json (tables, drones, phones, zones), created from venue/room.json
    the first time."""
    folder = data_dir() if folder is None else Path(folder)
    path = folder / ".room.json"
    if not path.exists():
        folder.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(DEFAULT_ROOM, path)
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


# ---- building blocks: points and colours on surfaces


class _Cloud:
    def __init__(self, rng: np.random.Generator) -> None:
        self.pts: list[np.ndarray] = []
        self.cols: list[np.ndarray] = []
        self.sizes: list[np.ndarray] = []
        self.rng = rng

    def surface(self, origin, u, v, colour, step: float = STEP, noise: float = 0.04, band=None) -> None:
        """A flat parallelogram origin + a*u + b*v (a, b in 0..1), Gaussians `step` apart.
        `band` = (height_m, colour): below that height (along v) the colour changes."""
        origin, u, v = (np.asarray(a, dtype=np.float32) for a in (origin, u, v))
        nu = max(1, int(math.ceil(np.linalg.norm(u) / step)))
        nv = max(1, int(math.ceil(np.linalg.norm(v) / step)))
        a, b = np.meshgrid((np.arange(nu) + 0.5) / nu, (np.arange(nv) + 0.5) / nv)
        a, b = a.ravel()[:, None], b.ravel()[:, None]
        pts = origin + a * u + b * v
        cols = np.tile(np.asarray(colour, dtype=np.float32), (len(pts), 1))
        if band is not None:
            below = (b[:, 0] * np.linalg.norm(v)) < band[0]
            cols[below] = band[1]
        cols = np.clip(cols * (1 + self.rng.normal(0, noise, (len(pts), 1))).astype(np.float32), 0, 1)
        self.pts.append(pts)
        self.cols.append(cols)
        self.sizes.append(np.full(len(pts), step * 0.6, dtype=np.float32))

    def box(self, centre, w: float, d: float, h: float, rotation_deg: float, colour, bottom: float = 0.0,
            step: float = STEP, top: bool = True) -> None:
        """A box standing on z = bottom: w along its x, d along its y, turned rotation_deg."""
        a = math.radians(rotation_deg)
        ex = np.array([math.cos(a), math.sin(a), 0.0]) * w
        ey = np.array([-math.sin(a), math.cos(a), 0.0]) * d
        ez = np.array([0.0, 0.0, h])
        o = np.array([centre[0], centre[1], bottom]) - ex / 2 - ey / 2
        for origin, u, v in ((o, ex, ez), (o + ey, ex, ez), (o, ey, ez), (o + ex, ey, ez)):
            self.surface(origin, u, v, colour, step)
        if top:
            self.surface(o + ez, ex, ey, colour, step)

    def splats(self, device: str):
        import torch

        from .scene import SH_C0, Splats

        pts = np.concatenate(self.pts).astype(np.float32)
        rgb = np.concatenate(self.cols).astype(np.float32)
        size = np.concatenate(self.sizes).astype(np.float32)
        n = len(pts)
        t = lambda a: torch.tensor(np.asarray(a, dtype=np.float32), device=device)  # noqa: E731
        return Splats(means=t(pts), quats=t(np.tile([1.0, 0, 0, 0], (n, 1))), scales=t(np.repeat(size[:, None], 3, axis=1)),
                      opacities=t(np.full(n, 0.97)), sh0=t((rgb - 0.5) / SH_C0)[:, None, :])


def object_height(o: dict) -> float:
    h = o.get("heightM")
    if isinstance(h, (int, float)) and h > 0:
        return float(h)
    return TABLE_HEIGHT_M if o.get("kind") == "table" else BOX_HEIGHT_M


def furniture(cloud: _Cloud, objects: list[dict]) -> None:
    for o in objects:
        try:
            x, y, w, d, rot = (float(o[k]) for k in ("x", "y", "w", "d", "rotation"))
        except (KeyError, TypeError, ValueError):
            continue
        h = object_height(o)
        if o.get("kind") == "table":
            top = 0.04
            cloud.box((x, y), w, d, top, rot, TABLE_TOP, bottom=h - top, step=0.04)
            a = math.radians(rot)
            for sx in (-1, 1):
                for sy in (-1, 1):
                    lx, ly = sx * (w / 2 - 0.08), sy * (d / 2 - 0.08)
                    cx, cy = x + lx * math.cos(a) - ly * math.sin(a), y + lx * math.sin(a) + ly * math.cos(a)
                    cloud.box((cx, cy), 0.05, 0.05, h - top, rot, TABLE_LEG, step=0.025, top=False)
        else:
            cloud.box((x, y), w, d, h, rot, BOX)


def build(plan: dict, objects: list[dict], mission_pads: Optional[dict] = None, device: str = "cuda", seed: int = 0):
    """The venue's splats. `mission_pads` = {number: (x, y, z)}, z the surface they lie on."""
    rng = np.random.default_rng(seed)
    c = _Cloud(rng)
    height = float(plan.get("height_m", 4.3))
    (x0, y0), (x1, y1) = plan["bounds"]["min"], plan["bounds"]["max"]
    c.surface((x0, y0, 0.0), (x1 - x0, 0, 0), (0, y1 - y0, 0), FLOOR, noise=0.06)
    c.surface((x0, y0, height), (x1 - x0, 0, 0), (0, y1 - y0, 0), CEILING, step=0.1)
    for wall in plan["walls"]:
        if str(wall.get("solid", "")).startswith("pillar"):
            continue  # drawn as boxes below
        (ax, ay), (bx, by) = wall["a"], wall["b"]
        if math.hypot(bx - ax, by - ay) < 1e-3:
            continue
        c.surface((ax, ay, 0.0), (bx - ax, by - ay, 0), (0, 0, height), WALL, band=(0.10, SKIRTING))
    for p in plan.get("pillars", []):
        c.box((p["x"], p["y"]), p["w"], p["d"], height, 0.0, CONCRETE, top=False)
    for a in plan.get("above", []):
        z = float(a["z_m"])
        if z < height - 0.05:
            (ax, ay), (bx, by) = a["min"], a["max"]
            c.surface((ax, ay, z), (bx - ax, 0, 0), (0, by - ay, 0), MEZZANINE)
    furniture(c, objects)
    for (px, py, pz) in (mission_pads or {}).values():
        h = PAD_SIDE_M / 2
        c.surface((px - h, py - h, pz + 0.003), (PAD_SIDE_M, 0, 0), (0, PAD_SIDE_M, 0), PAD, step=0.01, noise=0)
        # A light arrow towards the pad's +x (the rocket on a real pad), so its heading shows.
        c.surface((px - 0.06, py - 0.012, pz + 0.004), (0.12, 0, 0), (0, 0.024, 0), PAD_MARK, step=0.01, noise=0)
    return c.splats(device)


def surface_height(objects: list[dict], x: float, y: float) -> float:
    """Height of the furniture top at (x, y), 0 on the floor (for placing drones and pads)."""
    best = 0.0
    for o in objects:
        try:
            ox, oy, w, d, rot = (float(o[k]) for k in ("x", "y", "w", "d", "rotation"))
        except (KeyError, TypeError, ValueError):
            continue
        a = math.radians(rot)
        u = (x - ox) * math.cos(a) + (y - oy) * math.sin(a)
        v = -(x - ox) * math.sin(a) + (y - oy) * math.cos(a)
        if abs(u) <= w / 2 and abs(v) <= d / 2:
            best = max(best, object_height(o))
    return best


def start_spots(config: dict, env: Optional[dict] = None) -> dict[str, tuple[float, float, float]]:
    """Where each drone stands before its first takeoff, (x, y, heading) in metres and degrees:
    its spot on the Room panel, else TELLO_START / RMTT_START from sim.env (cm), as the voice
    server does (server.ts startOf)."""
    env = sim_env() if env is None else env
    out = {}
    for name, prefix, default in (("tello", "TELLO", "0,0,0"), ("rmtt", "RMTT", "0,-150,0")):
        placed = (config.get("drones") or {}).get(name)
        if placed and all(isinstance(placed.get(k), (int, float)) for k in ("x", "y")):
            out[name] = (float(placed["x"]), float(placed["y"]), float(placed.get("heading", 0.0)))
            continue
        try:
            x, y, heading = (float(v) for v in env.get(f"{prefix}_START", default).split(","))
        except ValueError:
            x, y, heading = (float(v) for v in default.split(","))
        out[name] = (x / 100, y / 100, heading)
    return out


def default_pads(starts: dict, objects: list[dict]) -> dict[str, tuple[float, float, float]]:
    """Pad 1 under Black's start, pad 2 two metres ahead of it (Masoud's pad hop, pad-nav.json)."""
    x, y, heading = starts["tello"]
    a = math.radians(heading)
    x2, y2 = x + 2.0 * math.cos(a), y + 2.0 * math.sin(a)
    return {"1": (x, y, surface_height(objects, x, y)), "2": (x2, y2, surface_height(objects, x2, y2))}


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Render a few views of the venue built from the floor plan.")
    p.add_argument("-o", "--out", default=str(SIM / "renders" / "venue"))
    a = p.parse_args(argv)
    from .camera import Pose
    from .drone import camera_pose
    from .render import Renderer, save_rgb

    config = room_config()
    starts = start_spots(config)
    objects = config.get("objects", [])
    splats = build(load_plan(), objects, default_pads(starts, objects))
    renderer = Renderer()
    out = Path(a.out)
    for name, (x, y, heading) in starts.items():
        z = surface_height(objects, x, y) + 0.8
        for turn in (0, 90, 180, 270):
            view = renderer.render(splats, camera_pose(Pose(x, y, z, heading + turn)))
            save_rgb(out / f"{name}-{turn:03d}.png", view.image)
    save_rgb(out / "top.png", Renderer().render(splats, Pose(0.0, 0.0, 22.0, 90.0, -90.0), near_plane=18.0).image)
    print(f"{len(splats):,} Gaussians -> {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

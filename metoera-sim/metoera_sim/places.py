"""Named places in the scan (tv, sofa, chair...), found by the same YOLO the drones use live.

    python -m metoera_sim.places scenes/practice          # into scene.json, then room.json
    python -m metoera_sim.places synthetic -o room.json    # the check's room, with its posters

The room is rendered from viewpoints all over it: a 0.75 m grid over the free space, at 0.6,
1.0 and 1.4 m, facing 8 directions. YOLO looks at every view (from 25 % confidence) and each
box is placed in 3D from the depth at its middle. Boxes of the same label within 40 cm are one
object. An object is kept only if it was seen from at least 3 viewpoints, and in at least 30 %
of the views that could see it: a shelf taken for a fridge once, at 22 %, does not survive.

People (and animals) are not places: they move. The people guard handles them live.

The places go into scene.json, where the viewer shows them for you to confirm, rename or
delete (top view, see viewer.py). Running this again keeps what you confirmed, renamed or
deleted, and replaces the rest.
"""

from __future__ import annotations

import argparse
import math
import os
import sys
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Optional

import numpy as np

from .camera import Intrinsics, Pose, project, unproject
from .drone import Obstacles, camera_pose

SIM_ROOT = Path(__file__).resolve().parent.parent
os.environ.setdefault("YOLO_CONFIG_DIR", str(SIM_ROOT / ".ultralytics"))  # keep Ultralytics' settings here

MIN_CONF = 0.25
MIN_VIEWPOINTS = 3
MIN_SUPPORT = 0.3
CLUSTER_M = 0.4
GRID_M = 0.75
HEIGHTS = (0.6, 1.0, 1.4)
HEADINGS = 8
MAX_RANGE_M = 6.0
NOT_PLACES = {"person", "dog", "cat", "bird", "horse", "sheep", "cow"}  # they move
DEPTH_STEP = 8  # visibility checks use the depth at 1/8 resolution


@dataclass
class Sighting:
    label: str
    confidence: float
    point: np.ndarray
    size: np.ndarray  # width, height in metres (depth along the view: unknown)
    viewpoint: int  # which spot
    view: int  # which rendered view (spot and heading)


@dataclass
class Cluster:
    label: str
    sightings: list[Sighting] = field(default_factory=list)

    @property
    def centre(self) -> np.ndarray:
        return np.median(np.stack([s.point for s in self.sightings]), axis=0)


def viewpoints(obstacles: Obstacles, grid: float = GRID_M, heights=HEIGHTS) -> list[Pose]:
    """Free spots inside the room: the drone (with its margin) touches nothing within 25 cm,
    and there is floor under it (a phone scan has no floor outside the walls)."""
    pts = obstacles.points.cpu().numpy()
    lo, hi = np.percentile(pts[:, :2], 1, axis=0), np.percentile(pts[:, :2], 99, axis=0)
    out = []
    for z in heights:
        for x in np.arange(lo[0] + grid / 2, hi[0], grid):
            for y in np.arange(lo[1] + grid / 2, hi[1], grid):
                pose = Pose(float(x), float(y), z, 0.0)
                if any(obstacles.check_move(pose, d, 0.25) for d in ("forward", "back", "left", "right")):
                    continue  # too close to something
                if obstacles.check_move(pose, "down", z + 0.3) is not None:
                    out.append(pose)
    return out


def load_yolo(weights: str = "yolo11n.pt"):
    from ultralytics import YOLO
    from ultralytics.utils import SETTINGS

    if SETTINGS.get("sync"):
        SETTINGS.update({"sync": False})  # no anonymous usage analytics
    path = Path(weights)
    if not path.is_absolute() and path.parent == Path("."):
        path = SIM_ROOT / "weights" / path.name
        path.parent.mkdir(parents=True, exist_ok=True)
    return YOLO(str(path))


def find_places(splats, obstacles: Obstacles, renderer, model=None, log=print) -> list[dict]:
    model = model or load_yolo()
    k: Intrinsics = renderer.k
    spots = viewpoints(obstacles)
    log(f"{len(spots)} viewpoints x {HEADINGS} headings")
    sightings: list[Sighting] = []
    views: list[tuple[Pose, np.ndarray]] = []  # camera pose, coarse depth: for the visibility check
    for i, spot in enumerate(spots):
        for h in range(HEADINGS):
            cam = camera_pose(replace(spot, yaw=h * 360 / HEADINGS))
            view = renderer.render(splats, cam, depth=True)
            depth = np.where(view.alpha > 0.5, view.depth, np.inf)
            views.append((cam, depth[DEPTH_STEP // 2::DEPTH_STEP, DEPTH_STEP // 2::DEPTH_STEP].copy()))
            result = model.predict(np.ascontiguousarray(view.image[:, :, ::-1]), conf=MIN_CONF, verbose=False)[0]
            for (x1, y1, x2, y2), cls, conf in zip(result.boxes.xyxy.tolist(), result.boxes.cls.tolist(), result.boxes.conf.tolist()):
                label = result.names[int(cls)]
                if label in NOT_PLACES:
                    continue
                cx, cy, w, hh = (x1 + x2) / 2, (y1 + y2) / 2, x2 - x1, y2 - y1
                middle = depth[int(cy - hh * 0.15):int(cy + hh * 0.15) + 1, int(cx - w * 0.15):int(cx + w * 0.15) + 1]
                middle = middle[np.isfinite(middle)]
                if middle.size == 0:
                    continue
                d = float(np.median(middle))
                if d > MAX_RANGE_M:
                    continue
                sightings.append(Sighting(label, float(conf), unproject(cam, k, cx, cy, d),
                                          np.array([w / k.fx * d, hh / k.fy * d]), i, len(views) - 1))
    log(f"{len(sightings)} sightings")

    clusters: list[Cluster] = []
    for s in sorted(sightings, key=lambda s: -s.confidence):
        near = [c for c in clusters if c.label == s.label and np.linalg.norm(c.centre - s.point) <= CLUSTER_M]
        if near:
            near[0].sightings.append(s)
        else:
            clusters.append(Cluster(s.label, [s]))

    places = []
    for c in clusters:
        seen_from = {s.viewpoint for s in c.sightings}
        if len(seen_from) < MIN_VIEWPOINTS:
            continue
        centre = c.centre
        could_see = sum(_visible(cam, k, depth, centre) for cam, depth in views)
        support = min(1.0, len({s.view for s in c.sightings}) / max(1, could_see))
        if support < MIN_SUPPORT:
            continue
        places.append({
            "label": c.label,
            "position": [round(float(v), 3) for v in centre],
            "size": [round(float(v), 2) for v in np.median(np.stack([s.size for s in c.sightings]), axis=0)],
            "confidence": round(float(np.mean([s.confidence for s in c.sightings])), 2),
            "views": len({s.view for s in c.sightings}),
            "viewpoints": len(seen_from),
            "support": round(support, 2),
            "confirmed": False,
        })
    return name_places(sorted(places, key=lambda p: -p["confidence"]))


def _visible(cam: Pose, k: Intrinsics, depth: np.ndarray, point: np.ndarray) -> bool:
    """Would this view show `point`: in the picture, in range, and not hidden behind something."""
    u, v, d = project(cam, k, point)
    if not (d > 0.2 and d < MAX_RANGE_M and 0 <= u < k.width and 0 <= v < k.height):
        return False
    seen = depth[min(depth.shape[0] - 1, int(v) // DEPTH_STEP), min(depth.shape[1] - 1, int(u) // DEPTH_STEP)]
    return bool(seen >= d - 0.3)


def name_places(places: list[dict]) -> list[dict]:
    """"tv" when there is one; "chair 1", "chair 2"... when there are several (most confident first)."""
    by_label: dict[str, list[dict]] = {}
    for p in places:
        by_label.setdefault(p["label"], []).append(p)
    for label, group in by_label.items():
        for i, p in enumerate(group):
            p.setdefault("name", label if len(group) == 1 else f"{label} {i + 1}")
    return places


def merge(old: list[dict], new: list[dict]) -> list[dict]:
    """Keep what the person decided (confirmed, renamed or deleted); replace the rest."""
    kept = [p for p in old if p.get("confirmed") or p.get("deleted") or p.get("renamed")]

    def taken(p: dict) -> bool:
        return any(q["label"] == p["label"] and math.dist(q["position"], p["position"]) <= CLUSTER_M for q in kept)

    fresh = [{k: v for k, v in p.items() if k != "name"} for p in new if not taken(p)]
    names = {p["name"] for p in kept}
    for p in name_places(fresh):
        base, n = p["name"], 2
        while p["name"] in names:  # never reuse a name the person kept
            p["name"] = f"{base} ({n})"
            n += 1
        names.add(p["name"])
    return kept + fresh


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Find named places in a scan with YOLO.")
    p.add_argument("scene", help='scene folder (aligned with the viewer), or "synthetic"')
    p.add_argument("-o", "--out", default=None, help="room.json to write (default: in the scene folder)")
    a = p.parse_args(argv)

    from .render import Renderer
    from .room import SYNTHETIC_PADS, export_scene, room_dict, write_room

    renderer = Renderer()
    if a.scene == "synthetic":
        from .check import synthetic_room

        splats = synthetic_room(posters=True)
        obstacles = Obstacles(splats)
        places = find_places(splats, obstacles, renderer)
        out = None
        if a.out:
            out = write_room(a.out, room_dict(obstacles, SYNTHETIC_PADS, places))
    else:
        from .scene import load_scene

        scene = load_scene(a.scene)
        if "origin" not in scene.meta.get("aligned", []):
            print(f"warning: {a.scene} is not aligned yet: the places would be in the wrong frame")
        places = find_places(scene.splats, Obstacles(scene.splats), renderer)
        scene.meta["places"] = merge(scene.meta.get("places", []), places)
        scene.save()
        out = export_scene(scene, Path(a.out) if a.out else None)
        places = [p for p in scene.meta["places"] if not p.get("deleted")]
    for pl in places:
        x, y, z = pl["position"]
        print(f"  {pl['name']:14} at ({x:+.2f}, {y:+.2f}, {z:+.2f}) m, {pl['confidence']:.0%}, "
              f"{pl.get('views', '?')} views from {pl.get('viewpoints', '?')} spots{'' if pl.get('confirmed') else '  (to confirm in the viewer)'}")
    if out:
        print(f"-> {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

"""The room map: what the voice server needs from a scan to guard and guide real flights.

    python -m metoera_sim.room scenes/practice            # writes scenes/practice/room.json
    python -m metoera_sim.room synthetic -o room.json      # the install check's room

room.json is small (a few hundred kB) and needs no GPU, so any laptop that flies the drones
can use it (METOERA_ROOM=<path> for metoera-voice). It holds:

- voxels: the solid part of the scan in 5 cm cubes, sparse. Each occupied voxel has the
  number of solid Gaussian centres in it (capped at 255) and where they sit on average
  (`means`, 0..255 across the voxel on each axis), so the voice server applies the same
  "at least min_count points in the way" rule as drone.py, to within a few millimetres;
- mission_pads: {pad number: [x, y, z]}, marked in the viewer (key m);
- places: named things YOLO found in the scan (places.py), as confirmed or edited in the viewer;
- the drone's size and the margin.

The voxel index is (ix * ny + iy) * nz + iz, from `origin` (the corner of voxel 0, 0, 0).
"""

from __future__ import annotations

import argparse
import base64
import json
import sys
from pathlib import Path
from typing import Optional

import numpy as np

from .drone import HEIGHT_M, LENGTH_M, MARGIN_M, WIDTH_M, Obstacles

VOXEL_M = 0.05
SYNTHETIC_PADS = {"1": [0.0, 0.0, 0.0], "2": [2.0, -1.0, 0.0]}  # the green and magenta pads


def voxelize(points: np.ndarray, voxel: float = VOXEL_M) -> dict:
    """Sparse voxels of an [N, 3] point array: origin, dims, indices (uint32), counts (uint8),
    and where the points sit inside each voxel (their mean, 0..255 per axis across the voxel).
    The mean keeps a wall exactly where it is: a voxel's centre can be 2.5 cm off."""
    if len(points) == 0:
        return {"origin": [0.0, 0.0, 0.0], "dims": [1, 1, 1], "index": np.zeros(0, np.uint32),
                "count": np.zeros(0, np.uint8), "mean": np.zeros((0, 3), np.uint8)}
    origin = np.floor(points.min(axis=0) / voxel) * voxel
    ijk = np.clip(np.floor((points - origin) / voxel).astype(np.int64), 0, None)
    dims = ijk.max(axis=0) + 1
    flat = (ijk[:, 0] * dims[1] + ijk[:, 1]) * dims[2] + ijk[:, 2]
    index, inverse, count = np.unique(flat, return_inverse=True, return_counts=True)
    if index.max() >= 2**32:
        raise ValueError("room too large for 5 cm voxels; use a bigger --voxel")
    sums = np.zeros((len(index), 3))
    np.add.at(sums, inverse, points)
    corner = origin + np.stack([index // (dims[1] * dims[2]), (index // dims[2]) % dims[1], index % dims[2]], axis=1) * voxel
    mean = np.clip(np.round((sums / count[:, None] - corner) / voxel * 255), 0, 255).astype(np.uint8)
    return {"origin": origin.tolist(), "dims": dims.tolist(), "index": index.astype(np.uint32),
            "count": np.minimum(count, 255).astype(np.uint8), "mean": mean}


def room_dict(obstacles: Obstacles, mission_pads: dict, places: list, voxel: float = VOXEL_M) -> dict:
    v = voxelize(obstacles.points.cpu().numpy().astype(np.float64), voxel)
    return {
        "version": 1,
        "voxel": voxel,
        "origin": v["origin"],
        "dims": v["dims"],
        "voxels": base64.b64encode(v["index"].astype("<u4").tobytes()).decode(),
        "counts": base64.b64encode(v["count"].tobytes()).decode(),
        "means": base64.b64encode(v["mean"].tobytes()).decode(),
        "min_count": obstacles.min_count,
        "margin": obstacles.margin,
        "drone": {"length": LENGTH_M, "width": WIDTH_M, "height": HEIGHT_M},
        "mission_pads": {str(k): [float(c) for c in xyz] for k, xyz in mission_pads.items()},
        "places": places,
    }


def write_room(path: str | Path, room: dict) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(room, indent=1))
    return path


def export_scene(scene, out: Optional[Path] = None, margin: float = MARGIN_M, voxel: float = VOXEL_M) -> Path:
    """room.json for an aligned Scene (scene.py), next to its scan unless `out` is given."""
    meta = scene.meta
    room = room_dict(Obstacles(scene.splats, margin=margin), meta.get("mission_pads", {}),
                     [p for p in meta.get("places", []) if not p.get("deleted")], voxel)
    return write_room(out or scene.folder / "room.json", room)


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Export the room map (room.json) the voice server uses.")
    p.add_argument("scene", help='scene folder (aligned with the viewer), or "synthetic"')
    p.add_argument("-o", "--out", default=None, help="where to write (default: room.json in the scene folder)")
    p.add_argument("--margin", type=float, default=MARGIN_M)
    p.add_argument("--voxel", type=float, default=VOXEL_M)
    p.add_argument("--posters", action="store_true", help="synthetic room: add the YOLO test posters")
    a = p.parse_args(argv)

    if a.scene == "synthetic":
        from .check import synthetic_room

        splats = synthetic_room(posters=a.posters)
        places = []
        if a.out is None:
            p.error("synthetic: give -o")
        path = write_room(a.out, room_dict(Obstacles(splats, margin=a.margin), SYNTHETIC_PADS, places, a.voxel))
    else:
        from .scene import load_scene

        scene = load_scene(a.scene)
        if "origin" not in scene.meta.get("aligned", []):
            print(f"warning: {a.scene} is not aligned yet: the map would not match the real room")
        path = export_scene(scene, Path(a.out) if a.out else None, a.margin, a.voxel)
    room = json.loads(Path(path).read_text())
    print(f"{path}: {len(base64.b64decode(room['counts'])):,} solid voxels of {room['voxel'] * 100:.0f} cm, "
          f"{len(room['mission_pads'])} mission pads, {len(room['places'])} places, {Path(path).stat().st_size / 1024:.0f} kB")
    return 0


if __name__ == "__main__":
    sys.exit(main())

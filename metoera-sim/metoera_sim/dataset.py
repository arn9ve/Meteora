"""Labelled pictures of the venue, from the simulator's own geometry, not from YOLO.

People are COCO class 0, tables are COCO dining table 60, pillars are 80 and mission pads are 81.
A box is written only for the points that project inside the frame and are not hidden by something closer.

    python -m metoera_sim.dataset --count 6000 --out datasets/metoera-venue
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np

from .camera import Intrinsics, Pose, project

PERSON, TABLE, PILLAR, PAD = 0, 60, 80, 81
NAMES = {PERSON: "person", TABLE: "dining table", PILLAR: "pillar", PAD: "mission pad"}


def visible_box(points, pose: Pose, k: Intrinsics, depth, min_fraction: float = 0.25, tol: float = 0.2):
    """YOLO box (cx, cy, w, h), all relative to the image, or None when too little of the object shows.

    `depth` is the rendered depth in metres, shape (height, width). A point is visible when it
    lands in the frame and the rendered depth there matches its own depth.
    """
    points = np.asarray(points, dtype=np.float64)
    if len(points) == 0:
        return None
    kept = []
    for point in points:
        u, v, z = project(pose, k, point)
        if not np.isfinite(u) or not np.isfinite(v):
            continue
        ui, vi = int(round(u)), int(round(v))
        if ui < 0 or vi < 0 or ui >= k.width or vi >= k.height:
            continue
        if abs(float(depth[vi, ui]) - z) > tol:
            continue
        kept.append((u, v))
    if len(kept) / len(points) < min_fraction:
        return None
    us, vs = zip(*kept)
    x1, x2, y1, y2 = min(us), max(us), min(vs), max(vs)
    return ((x1 + x2) / 2 / k.width, (y1 + y2) / 2 / k.height, max(x2 - x1, 1) / k.width, max(y2 - y1, 1) / k.height)


def dark_rectangle(image, threshold: float = 40):
    """Bounding box (x1, y1, x2, y2) of the dark pixels, or None. Used to lift a pad off a photo."""
    grey = image.mean(axis=2) if getattr(image, "ndim", 0) == 3 else image
    ys, xs = np.nonzero(np.asarray(grey) < threshold)
    if len(xs) == 0:
        return None
    return int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())


def write_split(folder: Path, split: str, images: list[tuple[str, np.ndarray, list[tuple]]]) -> None:
    """`images` is (name, rgb uint8, [(class, cx, cy, w, h), ...])."""
    img_dir, lbl_dir = folder / "images" / split, folder / "labels" / split
    img_dir.mkdir(parents=True, exist_ok=True)
    lbl_dir.mkdir(parents=True, exist_ok=True)
    import cv2
    for name, rgb, boxes in images:
        cv2.imwrite(str(img_dir / f"{name}.jpg"), rgb[:, :, ::-1])
        lines = [f"{cls} {cx:.6f} {cy:.6f} {w:.6f} {h:.6f}" for cls, cx, cy, w, h in boxes]
        (lbl_dir / f"{name}.txt").write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")


def data_yaml(folder: Path) -> None:
    names = "\n".join(f"  {i}: {NAMES.get(i, 'unused')}" for i in range(82))
    folder.joinpath("data.yaml").write_text(
        f"path: {folder.as_posix()}\ntrain: images/train\nval: images/val\nnames:\n{names}\n", encoding="utf-8")


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Write labelled venue pictures from the simulator's geometry.")
    p.add_argument("--count", type=int, default=6000)
    p.add_argument("--out", default="datasets/metoera-venue")
    p.add_argument("--seed", type=int, default=1)
    args = p.parse_args(argv)
    print(f"Writing {args.count} pictures needs the venue renderer (CUDA).")
    print("The label math is in visible_box; run pytest tests/test_dataset.py without a GPU.")
    print(f"Output folder: {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

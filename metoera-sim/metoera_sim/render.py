"""Render the scene from a drone pose with gsplat.

    python -m metoera_sim.render scenes/practice --x 0 --y 0 --z 0.8 --yaw 0 -o renders/view.jpg

--x --y --z place the drone's body; the picture is taken from its camera, at the nose.
"""

from __future__ import annotations

import argparse
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import numpy as np
import torch

from .camera import Intrinsics, Pose, view_matrix
from .scene import Splats

BACKGROUND = (0.08, 0.08, 0.08)  # what you see where the scan has nothing


@dataclass
class View:
    image: Optional[np.ndarray]  # HxWx3 uint8, RGB (None when only YUV was asked for)
    depth: Optional[np.ndarray]  # HxW metres along the view axis (0 where nothing was hit)
    alpha: np.ndarray  # HxW coverage 0..1
    ms: float  # render time
    yuv: Optional[np.ndarray] = None  # planar YUV 4:2:0 [H*3/2, W], for the video encoder


class Renderer:
    def __init__(self, intrinsics: Optional[Intrinsics] = None, device: str = "cuda") -> None:
        from gsplat import rasterization  # imported here: the first import may compile CUDA code

        self._rasterize = rasterization
        self.k = intrinsics or Intrinsics.tello()
        self.device = device
        self._ks = torch.tensor(self.k.matrix(), dtype=torch.float32, device=device)[None]
        # RGB only: with depth, gsplat adds the depth channel's background (0) itself.
        self._bg = torch.tensor(BACKGROUND, dtype=torch.float32, device=device)[None]

    @torch.no_grad()
    def render(self, splats: Splats, pose: Pose, depth: bool = False, near_plane: float = 0.05, yuv420p: bool = False) -> View:
        """The view from the camera at `pose`. Nothing closer than `near_plane` metres is drawn
        (the viewer's top view uses it to cut away the ceiling). `yuv420p` gives the picture as
        YUV for the video encoder instead of RGB, converted on the GPU."""
        t0 = time.perf_counter()
        viewmat = torch.tensor(view_matrix(pose), dtype=torch.float32, device=self.device)[None]
        colors, alphas, _ = self._rasterize(
            splats.means, splats.quats, splats.scales, splats.opacities, splats.sh0,
            viewmat, self._ks, self.k.width, self.k.height,
            sh_degree=0, near_plane=near_plane, far_plane=100.0,
            # gsplat 1.5.3's packed mode rejects a per-camera background; one camera, so unpacked costs nothing.
            packed=False,
            render_mode="RGB+ED" if depth else "RGB", backgrounds=self._bg,
        )
        out = colors[0]
        yuv = rgb = None
        if yuv420p:
            from .video import rgb_to_yuv420p

            yuv = rgb_to_yuv420p(out[..., :3].clamp(0, 1))
        else:
            rgb = (out[..., :3].clamp(0, 1) * 255).to(torch.uint8).cpu().numpy()
        d = out[..., 3].cpu().numpy() if depth else None
        a = alphas[0, ..., 0].cpu().numpy()
        torch.cuda.synchronize()
        return View(rgb, d, a, (time.perf_counter() - t0) * 1000, yuv)


def save_rgb(path: str | Path, rgb: np.ndarray) -> None:
    import cv2

    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(path), cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR))


def main(argv=None) -> int:
    from .drone import camera_pose
    from .scene import load_scene

    p = argparse.ArgumentParser(description="Render one view of a splat scene from a drone pose.")
    p.add_argument("scene", help="scene folder (scene.ply [+ scene.json]) or a .ply file")
    p.add_argument("--x", type=float, default=0.0)
    p.add_argument("--y", type=float, default=0.0)
    p.add_argument("--z", type=float, default=0.8)
    p.add_argument("--yaw", type=float, default=0.0, help="degrees, counterclockwise from +x")
    p.add_argument("--pitch", type=float, default=0.0, help="camera tilt, negative looks down")
    p.add_argument("--max-gaussians", type=int, default=None)
    p.add_argument("-o", "--out", default="renders/view.jpg")
    a = p.parse_args(argv)

    scene = load_scene(a.scene, max_gaussians=a.max_gaussians)
    renderer = Renderer()
    pose = camera_pose(Pose(a.x, a.y, a.z, a.yaw, a.pitch))
    renderer.render(scene.splats, pose)  # warm-up
    view = renderer.render(scene.splats, pose)
    save_rgb(a.out, view.image)
    print(f"{len(scene.splats):,} Gaussians, {view.ms:.1f} ms -> {a.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

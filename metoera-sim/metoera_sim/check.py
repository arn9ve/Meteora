"""Install check: GPU, PyTorch CUDA, gsplat, and a render of a small synthetic room.

    python -m metoera_sim.check

The synthetic room has a checkered floor, a red box 1.8 m ahead of the takeoff spot, a blue
box to the left and a wall at 4 m. The check renders it from the hover position, confirms the
depth under the centre pixel lands on the red box, times 50 renders, and saves the images.
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

import numpy as np

OUT = Path(__file__).resolve().parent.parent / "renders"


def synthetic_room(device: str = "cuda"):
    import torch

    from .scene import SH_C0, Splats

    pts, cols = [], []
    step = 0.04
    # floor, 1 m checkers
    for x in np.arange(-1.0, 4.0, step):
        for y in np.arange(-2.0, 2.0, step):
            pts.append((x, y, 0.0))
            cols.append((0.75, 0.75, 0.75) if (int(np.floor(x)) + int(np.floor(y))) % 2 else (0.35, 0.35, 0.35))
    # wall at x = 4 m
    for y in np.arange(-2.0, 2.0, step):
        for z in np.arange(0.0, 2.5, step):
            pts.append((4.0, y, z))
            cols.append((0.9, 0.85, 0.6))

    def box(cx, cy, cz, side, colour):
        h = side / 2
        g = np.arange(-h, h + 1e-9, step / 2)
        for a in g:
            for b in g:
                for p in ((cx - h, cy + a, cz + b), (cx + h, cy + a, cz + b), (cx + a, cy - h, cz + b),
                          (cx + a, cy + h, cz + b), (cx + a, cy + b, cz - h), (cx + a, cy + b, cz + h)):
                    pts.append(p)
                    cols.append(colour)

    box(2.0, 0.0, 0.8, 0.4, (0.85, 0.1, 0.1))  # red, straight ahead: front face at x = 1.8
    box(1.5, 1.2, 0.3, 0.6, (0.1, 0.25, 0.85))  # blue, ahead-left

    # Two "mission pads" lying on the floor, 20 cm squares: green at the takeoff spot (0, 0),
    # magenta at (2, -1), so sqrt(5) = 2.236 m apart. For practising the viewer's alignment.
    for (px, py), colour in (((0.0, 0.0), (0.1, 0.8, 0.2)), ((2.0, -1.0), (0.85, 0.1, 0.75))):
        for a in np.arange(-0.1, 0.1 + 1e-9, 0.02):
            for b in np.arange(-0.1, 0.1 + 1e-9, 0.02):
                pts.append((px + a, py + b, 0.003))
                cols.append(colour)

    n = len(pts)
    t = lambda a: torch.tensor(np.asarray(a, dtype=np.float32), device=device)  # noqa: E731
    rgb = np.asarray(cols, dtype=np.float32)
    return Splats(
        means=t(pts),
        quats=t(np.tile([1.0, 0, 0, 0], (n, 1))),
        scales=t(np.full((n, 3), step * 0.6)),
        opacities=t(np.full(n, 0.95)),
        sh0=t((rgb - 0.5) / SH_C0)[:, None, :],
    )


def main() -> int:
    ok = True

    def line(name: str, good: bool, detail: str) -> None:
        nonlocal ok
        ok &= good
        print(f"[{'ok' if good else 'FAIL'}] {name}: {detail}")

    import torch

    line("PyTorch", True, torch.__version__)
    cuda = torch.cuda.is_available()
    line("CUDA in PyTorch", cuda, torch.cuda.get_device_name(0) if cuda else "not available: install the cu124 build of torch")
    if not cuda:
        return 1
    try:
        import gsplat

        line("gsplat", True, gsplat.__version__)
    except Exception as e:  # noqa: BLE001
        line("gsplat", False, f"{type(e).__name__}: {e}")
        return 1

    from .camera import Intrinsics, Pose, unproject
    from .drone import CAMERA_FORWARD_M, camera_pose
    from .render import Renderer, save_rgb
    from .scene import rot_x, transform

    room = synthetic_room()
    k = Intrinsics.tello()
    line("Tello camera", True, f"{k.width}x{k.height}, focal {k.fx:.0f} px, horizontal FOV {k.horizontal_fov_deg:.1f} deg")
    try:
        renderer = Renderer(k)
        hover = Pose(0.0, 0.0, 0.8, 0.0)  # the drone's body; its camera is at the nose
        eye = camera_pose(hover)
        view = renderer.render(room, eye, depth=True)  # first call may compile CUDA kernels
    except Exception as e:  # noqa: BLE001
        line("render", False, f"{type(e).__name__}: {e}")
        return 1
    save_rgb(OUT / "check.png", view.image)
    save_rgb(OUT / "check_top.png", renderer.render(room, Pose(1.5, 0.0, 3.5, 0.0, -90.0)).image)
    save_rgb(OUT / "check_left.png", renderer.render(room, camera_pose(hover.moved(turn=45))).image)
    line("render", True, f"{len(room):,} Gaussians -> {OUT / 'check.png'} (+ check_top.png, check_left.png)")

    # Depth under the centre pixel must land on the red box's front face, 1.8 m ahead of the
    # body centre (so a little less from the camera at the nose).
    d = float(view.depth[k.height // 2, k.width // 2])
    want = 1.8 - CAMERA_FORWARD_M
    hit = unproject(eye, k, k.width / 2, k.height / 2, d)
    line("depth picking", abs(d - want) < 0.05, f"centre pixel at {d:.3f} m -> world point {np.round(hit, 3).tolist()} (expected x = 1.8)")
    r, g, b = view.image[k.height // 2, k.width // 2]
    line("colour", r > 150 and g < 80 and b < 80, f"centre pixel RGB {r},{g},{b} (the red box)")

    # A phone scan is usually y-up: rotating it by +90 degrees about x must put it z-up.
    phone = transform(room, rot_x(-90))  # z-up room -> y-up "phone" frame
    back = transform(phone, rot_x(90))
    err = float((back.means - room.means).abs().max())
    line("alignment math", err < 1e-4, f"y-up -> z-up round trip, max error {err:.2e} m")

    # A practice scene for the viewer: the same room saved the way a phone scan comes out
    # (y up, a little tilted, turned, the wrong size and off-centre).
    from .scene import rot_z, save_ply, scale, translate

    demo = OUT.parent / "scenes" / "demo"
    crooked = translate((0.4, 1.2, -0.9)) @ scale(0.85) @ rot_x(-93) @ rot_z(25)
    save_ply(transform(room, crooked), demo / "scene.ply")
    (demo / "scene.json").unlink(missing_ok=True)
    line("practice scene", True, f"{demo / 'scene.ply'} (pads 2.236 m apart: try the viewer with --pad-distance 2.236)")

    torch.cuda.reset_peak_memory_stats()
    t0 = time.perf_counter()
    for i in range(50):
        renderer.render(room, camera_pose(hover.moved(turn=i * 7)))
    fps = 50 / (time.perf_counter() - t0)
    line("speed", fps >= 30, f"{fps:.0f} renders/s at {k.width}x{k.height}, peak GPU memory {torch.cuda.max_memory_allocated() / 2**20:.0f} MB")
    print("all good" if ok else "some checks failed")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())

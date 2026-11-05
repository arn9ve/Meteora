"""Load a Gaussian splat (.ply, the standard 3DGS layout that Scaniverse exports) onto the GPU
and place it in the world frame with the alignment saved in scene.json.

Only the base colour (spherical-harmonics degree 0) is kept: it saves memory, and the
higher bands could not simply be reused once the scene is rotated.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import numpy as np
import torch

SH_C0 = 0.28209479177387814  # degree-0 spherical-harmonics constant


@dataclass
class Splats:
    """Gaussians ready for gsplat: actual scales, normalised wxyz quaternions, opacities in 0..1,
    and colours as degree-0 SH coefficients [N, 1, 3]."""

    means: torch.Tensor
    quats: torch.Tensor
    scales: torch.Tensor
    opacities: torch.Tensor
    sh0: torch.Tensor

    def __len__(self) -> int:
        return int(self.means.shape[0])


def _sigmoid(x: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-x))


def load_ply(path: str | Path, device: str = "cuda", max_gaussians: Optional[int] = None) -> Splats:
    """Read a 3DGS .ply. Accepts the INRIA layout (f_dc_*, opacity as logit, scale_* as log,
    rot_* as wxyz) and, as a fallback, plain red/green/blue colours."""
    from plyfile import PlyData

    ply = PlyData.read(str(path))
    v = ply["vertex"].data
    names = set(v.dtype.names)
    need = {"x", "y", "z", "opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"}
    missing = need - names
    if missing:
        raise ValueError(f"{path}: not a Gaussian splat .ply (missing {', '.join(sorted(missing))}). "
                         "Export the scan as a splat PLY, not a mesh or point cloud.")
    means = np.stack([v["x"], v["y"], v["z"]], axis=1).astype(np.float32)
    scales = np.exp(np.stack([v["scale_0"], v["scale_1"], v["scale_2"]], axis=1)).astype(np.float32)
    quats = np.stack([v["rot_0"], v["rot_1"], v["rot_2"], v["rot_3"]], axis=1).astype(np.float32)
    opacities = _sigmoid(np.asarray(v["opacity"], dtype=np.float32))
    if {"f_dc_0", "f_dc_1", "f_dc_2"} <= names:
        sh0 = np.stack([v["f_dc_0"], v["f_dc_1"], v["f_dc_2"]], axis=1).astype(np.float32)
    elif {"red", "green", "blue"} <= names:
        rgb = np.stack([v["red"], v["green"], v["blue"]], axis=1).astype(np.float32) / 255.0
        sh0 = (rgb - 0.5) / SH_C0
    else:
        raise ValueError(f"{path}: no colour (expected f_dc_0..2 or red/green/blue)")

    keep = np.isfinite(means).all(axis=1) & np.isfinite(scales).all(axis=1) & (np.linalg.norm(quats, axis=1) > 0)
    if max_gaussians and keep.sum() > max_gaussians:
        # Thin a huge scan: drop the most transparent Gaussians first.
        order = np.argsort(-np.where(keep, opacities, -1.0))
        keep = np.zeros_like(keep)
        keep[order[:max_gaussians]] = True
    quats = quats / np.linalg.norm(quats, axis=1, keepdims=True).clip(min=1e-12)
    t = lambda a: torch.from_numpy(np.ascontiguousarray(a[keep])).to(device)  # noqa: E731
    return Splats(t(means), t(quats), t(scales), t(opacities), t(sh0)[:, None, :])


def save_ply(splats: Splats, path: str | Path) -> Path:
    """Write Gaussians in the standard 3DGS .ply layout (what load_ply reads back)."""
    from plyfile import PlyData, PlyElement

    names = ["x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity",
             "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"]
    op = splats.opacities.cpu().numpy().clip(1e-6, 1 - 1e-6)
    cols = np.concatenate([
        splats.means.cpu().numpy(), splats.sh0[:, 0].cpu().numpy(), np.log(op / (1 - op))[:, None],
        np.log(splats.scales.cpu().numpy()), splats.quats.cpu().numpy()], axis=1).astype(np.float32)
    arr = np.empty(len(cols), dtype=[(n, "f4") for n in names])
    for i, n in enumerate(names):
        arr[n] = cols[:, i]
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    PlyData([PlyElement.describe(arr, "vertex")]).write(str(path))
    return path


# ---- similarity transforms (scale, rotation, translation) as 4x4 matrices -----------------

def rot_x(deg: float) -> np.ndarray:
    c, s = math.cos(math.radians(deg)), math.sin(math.radians(deg))
    return np.array([[1, 0, 0, 0], [0, c, -s, 0], [0, s, c, 0], [0, 0, 0, 1]], dtype=np.float64)


def rot_y(deg: float) -> np.ndarray:
    c, s = math.cos(math.radians(deg)), math.sin(math.radians(deg))
    return np.array([[c, 0, s, 0], [0, 1, 0, 0], [-s, 0, c, 0], [0, 0, 0, 1]], dtype=np.float64)


def rot_z(deg: float) -> np.ndarray:
    c, s = math.cos(math.radians(deg)), math.sin(math.radians(deg))
    return np.array([[c, -s, 0, 0], [s, c, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]], dtype=np.float64)


def translate(v) -> np.ndarray:
    m = np.eye(4)
    m[:3, 3] = v
    return m


def scale(s: float) -> np.ndarray:
    m = np.eye(4)
    m[:3, :3] *= s
    return m


def rotation_between(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """4x4 rotation taking unit vector a onto unit vector b."""
    a = a / np.linalg.norm(a)
    b = b / np.linalg.norm(b)
    v = np.cross(a, b)
    c = float(np.dot(a, b))
    if np.linalg.norm(v) < 1e-9:
        if c > 0:
            return np.eye(4)
        # opposite: turn 180 degrees about any axis perpendicular to a
        axis = np.cross(a, [1.0, 0, 0]) if abs(a[0]) < 0.9 else np.cross(a, [0, 1.0, 0])
        axis /= np.linalg.norm(axis)
        r = 2 * np.outer(axis, axis) - np.eye(3)
    else:
        k = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
        r = np.eye(3) + k + k @ k * (1.0 / (1.0 + c))
    m = np.eye(4)
    m[:3, :3] = r
    return m


def split_similarity(m: np.ndarray) -> tuple[float, np.ndarray, np.ndarray]:
    """(scale, 3x3 rotation, translation) of a similarity transform."""
    a = m[:3, :3]
    s = float(np.cbrt(np.linalg.det(a)))
    return s, a / s, m[:3, 3].copy()


def _quat_from_matrix(r: np.ndarray) -> np.ndarray:
    """wxyz quaternion of a 3x3 rotation matrix."""
    w = math.sqrt(max(0.0, 1 + r[0, 0] + r[1, 1] + r[2, 2])) / 2
    x = math.sqrt(max(0.0, 1 + r[0, 0] - r[1, 1] - r[2, 2])) / 2
    y = math.sqrt(max(0.0, 1 - r[0, 0] + r[1, 1] - r[2, 2])) / 2
    z = math.sqrt(max(0.0, 1 - r[0, 0] - r[1, 1] + r[2, 2])) / 2
    x = math.copysign(x, r[2, 1] - r[1, 2])
    y = math.copysign(y, r[0, 2] - r[2, 0])
    z = math.copysign(z, r[1, 0] - r[0, 1])
    q = np.array([w, x, y, z])
    return q / np.linalg.norm(q)


def _quat_mul(q: torch.Tensor, p: torch.Tensor) -> torch.Tensor:
    """Hamilton product of wxyz quaternions; q is [4], p is [N, 4]."""
    w1, x1, y1, z1 = q
    w2, x2, y2, z2 = p.unbind(-1)
    return torch.stack([
        w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2,
        w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2,
        w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2,
        w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2,
    ], dim=-1)


def transform(raw: Splats, world_from_scene: np.ndarray) -> Splats:
    """The Gaussians moved into the world frame: positions, orientations and sizes."""
    s, r, t = split_similarity(world_from_scene)
    dev = raw.means.device
    r_t = torch.tensor(r, dtype=torch.float32, device=dev)
    t_t = torch.tensor(t, dtype=torch.float32, device=dev)
    q = torch.tensor(_quat_from_matrix(r), dtype=torch.float32, device=dev)
    return Splats(
        means=(raw.means @ r_t.T) * s + t_t,
        quats=_quat_mul(q, raw.quats),
        scales=raw.scales * s,
        opacities=raw.opacities,
        sh0=raw.sh0,
    )


# ---- a scene folder: scene.ply + scene.json -------------------------------------------------

@dataclass
class Scene:
    folder: Path
    raw: Splats  # as exported by the phone app
    world_from_scene: np.ndarray  # 4x4 similarity
    meta: dict
    splats: Splats  # in the world frame

    @property
    def json_path(self) -> Path:
        return self.folder / "scene.json"

    def set_alignment(self, world_from_scene: np.ndarray) -> None:
        self.world_from_scene = world_from_scene
        self.splats = transform(self.raw, world_from_scene)

    def save(self) -> Path:
        meta = dict(self.meta)
        meta.update(version=1, world_from_scene=self.world_from_scene.tolist())
        self.json_path.write_text(json.dumps(meta, indent=2))
        return self.json_path


def find_ply(folder: Path) -> Path:
    plys = sorted(folder.glob("*.ply"))
    if not plys:
        raise FileNotFoundError(f"no .ply in {folder}: export the scan as PLY and copy it there")
    preferred = [p for p in plys if p.name == "scene.ply"]
    return preferred[0] if preferred else plys[0]


def load_scene(folder: str | Path, device: str = "cuda", max_gaussians: Optional[int] = None) -> Scene:
    folder = Path(folder)
    if folder.suffix.lower() == ".ply":
        ply, folder = folder, folder.parent
    else:
        ply = find_ply(folder)
    raw = load_ply(ply, device, max_gaussians)
    meta: dict = {"ply": ply.name}
    m = np.eye(4)
    jp = folder / "scene.json"
    if jp.exists():
        meta = json.loads(jp.read_text())
        m = np.array(meta.get("world_from_scene", np.eye(4).tolist()), dtype=np.float64)
    return Scene(folder, raw, m, meta, transform(raw, m))

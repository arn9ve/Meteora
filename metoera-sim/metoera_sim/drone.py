"""The Tello's body: its size, where its camera sits, and what it would hit in the scan.

The drone is a box: Ryze's 98 x 92.5 x 41 mm (Tello EDU, TLW004) plus a margin on every side,
5 cm by default. The margin covers the propeller guards, which Ryze's size does not seem to
include, and the error in the scan. The RoboMaster TT is the same airframe; its expansion
board makes it taller, which the margin covers too.

A scan is frozen in time. People who walk are simulated in the venue (people.py): a move into
one is refused like a move into a wall; one walking into a hovering drone is only logged.

The check uses the centres of the Gaussians that are solid enough (opacity >= 0.3, as the
viewer's floor pick). A handful of them must be in the way (`min_count`) before a move
counts as blocked, so one stray Gaussian floating in the air does not stop the drone.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, replace
from typing import Optional

import torch

from .camera import Pose

# Ryze's spec for the Tello EDU: 98 x 92.5 x 41 mm, 87 g with propellers and battery.
LENGTH_M = 0.098  # along the heading
WIDTH_M = 0.0925
HEIGHT_M = 0.041
MARGIN_M = 0.05  # added on every side; the user asked for 2-5 cm with the guards on
CAMERA_FORWARD_M = 0.045  # the lens is at the nose, just behind the front edge
CAMERA_UP_M = 0.0
LANDED_Z = HEIGHT_M / 2  # body centre of a drone standing on the floor
HOVER_Z = 0.8  # the Tello hovers at about 80 cm after takeoff

DIRECTIONS = {  # SDK move -> (axis in the drone's frame: 0 forward, 1 left, 2 up; sign)
    "forward": (0, 1), "back": (0, -1), "left": (1, 1), "right": (1, -1), "up": (2, 1), "down": (2, -1),
}
WHERE = {"forward": "ahead", "back": "behind", "left": "to the left", "right": "to the right",
         "up": "above", "down": "below", "go": "on the way"}


def half_extents(margin: float = MARGIN_M) -> tuple[float, float, float]:
    """Half the keep-out box: forward, left, up."""
    return LENGTH_M / 2 + margin, WIDTH_M / 2 + margin, HEIGHT_M / 2 + margin


def camera_pose(body: Pose) -> Pose:
    """Where the camera of a drone whose body is at `body` sits (same heading and tilt)."""
    c, s = math.cos(math.radians(body.yaw)), math.sin(math.radians(body.yaw))
    return replace(body, x=body.x + CAMERA_FORWARD_M * c, y=body.y + CAMERA_FORWARD_M * s, z=body.z + CAMERA_UP_M)


@dataclass(frozen=True)
class Blocked:
    """Why a move or turn cannot happen."""

    direction: str  # an SDK direction, "go" (a straight line in any direction) or "turn"
    gap_cm: Optional[int] = None  # moves: from the drone's body to the obstacle
    free_cm: Optional[int] = None  # moves: how far it may go, keeping the margin
    free_deg: Optional[int] = None  # turns: how far it could turn
    what: str = "obstacle"  # or "person" (people.py)

    @property
    def message(self) -> str:
        if self.direction == "turn":
            return f"no room to turn: {self.what} after {self.free_deg} degrees"
        return f"{self.what} {self.gap_cm} cm {WHERE[self.direction]}: at most {self.free_cm} cm"


def _sweep(p: torch.Tensor, d: tuple[float, float, float], h: tuple[float, float, float]) -> tuple[torch.Tensor, torch.Tensor]:
    """For a box of half extents `h` sliding from the origin along the unit vector `d`: the
    distance at which each point [N, 3] enters it and the distance at which it leaves (inf when it
    never does). A point already inside enters at a negative distance."""
    inf = torch.full((len(p),), math.inf, device=p.device, dtype=p.dtype)
    lo, hi = -inf, inf.clone()
    for i in range(3):
        if abs(d[i]) < 1e-9:
            lo = torch.where(p[:, i].abs() > h[i], inf, lo)
        else:
            a, b = (p[:, i] - h[i]) / d[i], (p[:, i] + h[i]) / d[i]
            lo, hi = torch.maximum(lo, torch.minimum(a, b)), torch.minimum(hi, torch.maximum(a, b))
    return torch.where(lo <= hi, lo, inf), hi


class Obstacles:
    """The solid part of a scan, for checking the drone's moves. Works on any torch device."""

    def __init__(self, splats, margin: float = MARGIN_M, min_opacity: float = 0.3, min_count: int = 5) -> None:
        self.points = splats.means[splats.opacities >= min_opacity].to(torch.float32)
        self.margin = margin
        self.min_count = min_count

    @classmethod
    def of_points(cls, points: torch.Tensor, margin: float = MARGIN_M, min_count: int = 5) -> "Obstacles":
        """Solid points [N, 3] given directly (the people's cylinders)."""
        self = cls.__new__(cls)
        self.points, self.margin, self.min_count = points.to(torch.float32), margin, min_count
        return self

    def _local(self, body: Pose) -> torch.Tensor:
        """Every point in the drone's frame: [N, 3] forward, left, up from the body centre."""
        c, s = math.cos(math.radians(body.yaw)), math.sin(math.radians(body.yaw))
        d = self.points - self.points.new_tensor([body.x, body.y, body.z])
        return torch.stack([d[:, 0] * c + d[:, 1] * s, -d[:, 0] * s + d[:, 1] * c, d[:, 2]], dim=1)

    def check_move(self, body: Pose, direction: str, distance_m: float) -> Optional[Blocked]:
        """Blocked if the keep-out box, slid `distance_m` in `direction`, would run into the scan.
        Only what lies ahead of the body's centre counts: a drone already too close to a wall may
        still back away from it, but not go further in (it is then blocked at 0 cm)."""
        axis, sign = DIRECTIONS[direction]
        h = half_extents(self.margin)
        p = self._local(body)
        along = p[:, axis] * sign  # ahead of the body's centre
        across = along > 0
        for other in {0, 1, 2} - {axis}:
            across &= p[:, other].abs() <= h[other]
        ahead = along[across]
        if int((ahead - h[axis] <= distance_m).sum()) < self.min_count:
            return None
        nearest = float(torch.kthvalue(ahead, self.min_count).values)
        body_half = (LENGTH_M / 2, WIDTH_M / 2, HEIGHT_M / 2)[axis]
        return Blocked(direction, gap_cm=max(0, round((nearest - body_half) * 100)),
                       free_cm=max(0, math.floor((nearest - h[axis]) * 100)))

    def check_go(self, body: Pose, forward: float, left: float, up: float) -> Optional[Blocked]:
        """Like check_move for the Tello's `go x y z`: the keep-out box slides, without turning,
        `forward`/`left`/`up` metres in the drone's frame. Only what lies ahead of the body's
        centre along the line counts, as for the plain moves; a point already inside the box
        blocks at 0."""
        length = math.sqrt(forward * forward + left * left + up * up)
        if length < 1e-9:
            return None
        d = (forward / length, left / length, up / length)
        p = self._local(body)
        ahead = p @ p.new_tensor(d) > 0
        entry, leave = _sweep(p, d, half_extents(self.margin))
        t = entry[ahead & (leave >= 0) & torch.isfinite(entry)]
        if len(t) < self.min_count:
            return None
        nearest = float(torch.kthvalue(t, self.min_count).values)
        if nearest > length:
            return None
        free = max(0, math.floor(nearest * 100))
        return Blocked("go", gap_cm=free + round(self.margin * 100), free_cm=free)

    def check_turn(self, body: Pose, degrees: float, step_deg: float = 3.0) -> Optional[Blocked]:
        """Blocked if the box would sweep into the scan while turning `degrees` (counterclockwise
        positive) on the spot."""
        hf, hl, hu = half_extents(self.margin)
        p = self._local(body)
        near = (p[:, 0].hypot(p[:, 1]) <= math.hypot(hf, hl)) & (p[:, 2].abs() <= hu)
        inside_now = (p[:, 0].abs() <= hf) & (p[:, 1].abs() <= hl)
        q = p[near & ~inside_now]
        if len(q) < self.min_count:
            return None
        steps = max(1, math.ceil(abs(degrees) / step_deg))
        for i in range(1, steps + 1):
            a = math.radians(degrees * i / steps)
            c, s = math.cos(a), math.sin(a)
            f = q[:, 0] * c + q[:, 1] * s  # the points as seen by the turned drone
            l = -q[:, 0] * s + q[:, 1] * c
            if int(((f.abs() <= hf) & (l.abs() <= hl)).sum()) >= self.min_count:
                return Blocked("turn", free_deg=int(abs(degrees) * (i - 1) / steps))
        return None

    def clearance(self, body: Pose) -> float:
        """Metres from the drone's body (no margin) to the scan around and above it: the
        `min_count`-th nearest solid point, so one stray Gaussian does not count. What lies below
        the body (the floor it takes off from) is left out. For the flight log."""
        p = self._local(body)
        p = p[p[:, 2] > -HEIGHT_M / 2]
        half = p.new_tensor([LENGTH_M / 2, WIDTH_M / 2, HEIGHT_M / 2])
        d = (p.abs() - half).clamp(min=0).norm(dim=1)
        if len(d) < self.min_count:
            return math.inf
        return float(torch.kthvalue(d, self.min_count).values)

    def ground_below(self, body: Pose) -> float:
        """Height of what is under the drone's body (a table, or the floor at 0)."""
        p = self._local(body)
        under = (p[:, 0].abs() <= LENGTH_M / 2) & (p[:, 1].abs() <= WIDTH_M / 2) & (p[:, 2] < -HEIGHT_M / 4)
        z = p[under, 2]
        if len(z) < self.min_count:
            return 0.0
        return body.z + float(torch.topk(z, self.min_count).values[-1])

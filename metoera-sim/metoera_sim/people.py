"""People in the venue: standing or walking along paths, seen by the drones and the phones.

venue/people.json lists them:

    {"name": "man in a dark coat and red shirt",
     "photo": {"image": "bus.jpg", "box": [223, 408, 344, 860]},   # a person in Ultralytics' samples
     "path": [[10.8, 4.5], [10.8, -3.0]],   # metres, in the venue's frame; one point = standing
     "speed": 0.7, "wait": 4, "loop": true, "start_after": 15}

- What they look like: the photo of a real person, cut out of its background (GrabCut in the
  box), standing on the floor 1.7 m tall and always turned to face the camera that looks at it
  (a billboard). YOLO and Grok vision see a person; their clothes are the photo's.
- How they move: from the first point, after `start_after` seconds, at `speed` m/s, waiting
  `wait` s at every point; with `loop` back to the first point and round again, otherwise they
  stay at the last one. Time counts from the simulator's start.
- What the drones can hit: a 0.25 m-radius cylinder, as tall as the person, where they are at
  the moment of the check. A move into a person is refused like a move into a wall (the flight
  log's would_hit says "person"). A person who walks into a hovering drone is only logged
  (`near_person`): people moving into a blind spot are an accepted risk.
"""

from __future__ import annotations

import importlib.util
import json
import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import numpy as np
import torch

from .drone import Blocked, Obstacles

SIM = Path(__file__).resolve().parent.parent
PEOPLE = SIM / "venue" / "people.json"
HEIGHT_M = 1.7
RADIUS_M = 0.25
STEP_M = 0.012  # between the Gaussians of a photo


@dataclass
class Walker:
    name: str
    photo: dict
    path: list
    speed: float = 0.8
    wait: float = 2.0
    loop: bool = True
    start_after: float = 0.0
    height: float = HEIGHT_M
    _legs: list = field(default_factory=list, repr=False)

    def __post_init__(self) -> None:
        pts = [tuple(map(float, p)) for p in self.path]
        if self.loop and len(pts) > 1:
            pts = pts + [pts[0]]
        self._legs = list(zip(pts[:-1], pts[1:]))
        self.path = [list(p) for p in pts]

    def position(self, t: float) -> tuple[float, float]:
        """Where they stand `t` seconds after the simulator started."""
        start = tuple(self.path[0])
        if not self._legs or t <= self.start_after:
            return start
        t -= self.start_after
        cycle = sum(math.dist(a, b) / self.speed + self.wait for a, b in self._legs)
        if self.loop:
            t %= cycle
        for a, b in self._legs:
            walk = math.dist(a, b) / self.speed
            if t < walk:
                u = t / walk
                return a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u
            t -= walk
            if t < self.wait:
                return b
            t -= self.wait
        return tuple(self.path[-1])


def load_people(path: Path = PEOPLE) -> list[Walker]:
    if not Path(path).exists():
        return []
    return [Walker(**p) for p in json.loads(Path(path).read_text(encoding="utf-8"))]


def cutout(image: str, box, height: float = HEIGHT_M, step: float = STEP_M) -> tuple[np.ndarray, np.ndarray]:
    """The person in `box` of one of Ultralytics' sample photos, cut from its background:
    (points [N, 2] as (across from their middle, up from their feet) in metres, RGB 0..1)."""
    import cv2

    spec = importlib.util.find_spec("ultralytics")  # found, not imported: importing writes its settings
    if spec is None or not spec.submodule_search_locations:
        raise RuntimeError("the people need ultralytics in this venv (see README)")
    img = cv2.imread(str(Path(spec.submodule_search_locations[0]) / "assets" / image))
    x0, y0, x1, y1 = (int(v) for v in box)
    mask = np.zeros(img.shape[:2], np.uint8)
    cv2.grabCut(img, mask, (x0, y0, x1 - x0, y1 - y0), np.zeros((1, 65)), np.zeros((1, 65)), 5, cv2.GC_INIT_WITH_RECT)
    keep = ((mask == cv2.GC_FGD) | (mask == cv2.GC_PR_FGD)).astype(np.uint8)[y0:y1, x0:x1]
    n, labels, stats, _ = cv2.connectedComponentsWithStats(keep)
    if n > 1:  # the person only: the biggest piece, not bits of the background
        keep = (labels == 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))).astype(np.uint8)
    rgb = img[y0:y1, x0:x1, ::-1]
    metres_per_px = height / (y1 - y0)
    nu, nv = max(1, round((x1 - x0) * metres_per_px / step)), max(1, round(height / step))
    small = cv2.resize(rgb, (nu, nv), interpolation=cv2.INTER_AREA).astype(np.float32) / 255
    alpha = cv2.resize(keep * 255, (nu, nv), interpolation=cv2.INTER_AREA) > 127
    v, u = np.nonzero(alpha)
    pts = np.stack([(u + 0.5) * step - nu * step / 2, height - (v + 0.5) * step], axis=1)
    return pts.astype(np.float32), small[v, u]


def _cylinder(height: float) -> np.ndarray:
    """Points on a person's cylinder, around (0, 0), for the obstacle checks."""
    a = np.linspace(0, 2 * math.pi, 16, endpoint=False)
    z = np.arange(0.05, height + 1e-6, 0.1)
    ring = np.stack([np.cos(a) * RADIUS_M, np.sin(a) * RADIUS_M], axis=1)
    return np.array([(x, y, h) for h in z for x, y in ring], dtype=np.float32)


class Crowd:
    """Everyone in people.json, ready to be drawn and checked against."""

    def __init__(self, walkers: list[Walker], device: str = "cuda") -> None:
        self.walkers = walkers
        self.device = device
        uv, rgb, owner = [], [], []
        for i, w in enumerate(walkers):
            p, c = cutout(w.photo["image"], w.photo["box"], w.height)
            uv.append(p)
            rgb.append(c)
            owner.append(np.full(len(p), i))
        self.count = int(sum(len(p) for p in uv))
        t = lambda a: torch.tensor(np.asarray(a), device=device)  # noqa: E731
        self._uv = t(np.concatenate(uv)) if uv else torch.zeros((0, 2), device=device)
        self.rgb = t(np.concatenate(rgb)) if rgb else torch.zeros((0, 3), device=device)
        self._owner = t(np.concatenate(owner)).long() if owner else torch.zeros(0, device=device).long()
        self._cylinders = [_cylinder(w.height) for w in walkers]

    def positions(self, t: float) -> list[tuple[float, float]]:
        return [w.position(t) for w in self.walkers]

    def means(self, t: float, eye: tuple[float, float]) -> torch.Tensor:
        """Every person's Gaussians at time t, each photo turned to face `eye` (x, y)."""
        if not self.walkers:
            return torch.zeros((0, 3), device=self.device)
        at = torch.tensor(self.positions(t), dtype=torch.float32, device=self.device)  # [P, 2]
        d = torch.tensor(eye, dtype=torch.float32, device=self.device)[None] - at
        d = d / d.norm(dim=1, keepdim=True).clamp(min=1e-6)
        right = torch.stack([-d[:, 1], d[:, 0]], dim=1)  # the camera's right, seen from there
        o = self._owner
        xy = at[o] + self._uv[:, :1] * right[o]
        return torch.cat([xy, self._uv[:, 1:]], dim=1)

    def obstacles(self, t: float, margin: float) -> Optional[Obstacles]:
        if not self.walkers:
            return None
        pts = np.concatenate([c + np.array([x, y, 0], dtype=np.float32) for c, (x, y) in zip(self._cylinders, self.positions(t))])
        return Obstacles.of_points(torch.tensor(pts), margin=margin, min_count=1)


class WithPeople:
    """What a drone can hit: the venue (static) and the people where they are now. The same
    checks as Obstacles; a person nearer than the walls gives a Blocked that says "person"."""

    def __init__(self, static: Obstacles, crowd: Optional[Crowd], clock) -> None:
        self.static = static
        self.crowd = crowd
        self.clock = clock  # seconds since the simulator started
        self.margin = static.margin

    def _people(self) -> Optional[Obstacles]:
        return self.crowd.obstacles(self.clock(), self.margin) if self.crowd else None

    def _nearer(self, wall: Optional[Blocked], person: Optional[Blocked]) -> Optional[Blocked]:
        if person is None:
            return wall
        person = Blocked(person.direction, person.gap_cm, person.free_cm, person.free_deg, what="person")
        if wall is None:
            return person
        key = (lambda b: b.free_deg) if wall.direction == "turn" else (lambda b: b.free_cm)
        return person if key(person) < key(wall) else wall

    def check_move(self, body, direction, distance_m):
        people = self._people()
        return self._nearer(self.static.check_move(body, direction, distance_m), people and people.check_move(body, direction, distance_m))

    def check_go(self, body, forward, left, up):
        people = self._people()
        return self._nearer(self.static.check_go(body, forward, left, up), people and people.check_go(body, forward, left, up))

    def check_turn(self, body, degrees, step_deg: float = 3.0):
        people = self._people()
        return self._nearer(self.static.check_turn(body, degrees, step_deg), people and people.check_turn(body, degrees, step_deg))

    def ground_below(self, body):
        return self.static.ground_below(body)

    def clearance(self, body):
        return self.static.clearance(body)

    def person_clearance(self, body) -> float:
        """Metres from the drone's body to the nearest person (inf when there is nobody)."""
        if not self.crowd or not self.crowd.walkers:
            return math.inf
        best = math.inf
        for x, y in self.crowd.positions(self.clock()):
            horizontal = max(0.0, math.hypot(body.x - x, body.y - y) - RADIUS_M - 0.07)  # 7 cm: half the drone's diagonal
            above = max(0.0, body.z - HEIGHT_M)
            best = min(best, math.hypot(horizontal, above))
        return best


class Composer:
    """The venue's Gaussians with the people's added at the end, in one set of tensors for gsplat.
    Only the people's positions change between frames, written in place."""

    def __init__(self, static, crowd: Optional[Crowd]) -> None:
        from .scene import SH_C0, Splats

        self.crowd = crowd
        self.static_count = len(static)
        n = crowd.count if crowd else 0
        if n == 0:
            self.splats = static
            return
        dev = static.means.device
        self.splats = Splats(
            means=torch.cat([static.means, torch.zeros((n, 3), device=dev)]),
            quats=torch.cat([static.quats, torch.tensor([[1.0, 0, 0, 0]], device=dev).repeat(n, 1)]),
            scales=torch.cat([static.scales, torch.full((n, 3), STEP_M * 0.6, device=dev)]),
            opacities=torch.cat([static.opacities, torch.full((n,), 0.99, device=dev)]),
            sh0=torch.cat([static.sh0, ((crowd.rgb.to(dev) - 0.5) / SH_C0)[:, None, :]]),
        )

    def for_eye(self, t: float, eye: tuple[float, float]):
        """The splats with every person facing `eye`. Render before calling it again."""
        if self.crowd and self.crowd.count:
            self.splats.means[self.static_count:] = self.crowd.means(t, eye).to(self.splats.means.device)
        return self.splats

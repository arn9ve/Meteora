"""The simulated Tello's camera: its pose in the world and its intrinsics.

World frame: metres, z up, x forward at takeoff, yaw counterclockwise from +x (see __init__.py).
Camera frame (what gsplat expects, OpenCV style): x right, y down, z forward.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, replace

import numpy as np

WIDTH, HEIGHT = 960, 720  # the Tello's video stream
# DJI quotes 82.6 degrees for the Tello camera, taken here as the diagonal of the 960x720
# picture (focal length ~683 px). Not yet checked against a real frame: calibrate it with
# a real Tello image before relying on distances seen in the simulator.
DIAGONAL_FOV_DEG = 82.6


@dataclass(frozen=True)
class Pose:
    """A position and heading. For a drone it is the centre of its body (drone.camera_pose
    gives where its camera is); the renderer takes the pose of the camera itself."""

    x: float = 0.0
    y: float = 0.0
    z: float = 0.8  # the Tello hovers at about 80 cm after takeoff
    yaw: float = 0.0  # degrees, counterclockwise from +x
    pitch: float = 0.0  # camera tilt in degrees, negative looks down

    def moved(self, forward: float = 0.0, left: float = 0.0, up: float = 0.0, turn: float = 0.0) -> "Pose":
        """Like the Tello's moves: forward/back and left/right relative to its heading."""
        c, s = math.cos(math.radians(self.yaw)), math.sin(math.radians(self.yaw))
        return replace(self, x=self.x + forward * c - left * s, y=self.y + forward * s + left * c,
                       z=self.z + up, yaw=(self.yaw + turn + 180) % 360 - 180)

    @property
    def position(self) -> np.ndarray:
        return np.array([self.x, self.y, self.z], dtype=np.float64)


@dataclass(frozen=True)
class Intrinsics:
    width: int = WIDTH
    height: int = HEIGHT
    fx: float = 0.0
    fy: float = 0.0
    cx: float = 0.0
    cy: float = 0.0

    @staticmethod
    def tello(width: int = WIDTH, height: int = HEIGHT, diagonal_fov_deg: float = DIAGONAL_FOV_DEG) -> "Intrinsics":
        f = math.hypot(width, height) / 2 / math.tan(math.radians(diagonal_fov_deg) / 2)
        return Intrinsics(width, height, f, f, width / 2, height / 2)

    def matrix(self) -> np.ndarray:
        return np.array([[self.fx, 0, self.cx], [0, self.fy, self.cy], [0, 0, 1]], dtype=np.float64)

    @property
    def horizontal_fov_deg(self) -> float:
        return math.degrees(2 * math.atan(self.width / 2 / self.fx))


def camera_axes(pose: Pose) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """(right, down, forward) unit vectors of the camera in the world frame."""
    yaw, pitch = math.radians(pose.yaw), math.radians(pose.pitch)
    forward = np.array([math.cos(pitch) * math.cos(yaw), math.cos(pitch) * math.sin(yaw), math.sin(pitch)])
    right = np.array([math.sin(yaw), -math.cos(yaw), 0.0])
    down = np.cross(forward, right)
    return right, down, forward


def view_matrix(pose: Pose) -> np.ndarray:
    """4x4 camera-from-world transform."""
    r, d, f = camera_axes(pose)
    rot = np.stack([r, d, f])
    m = np.eye(4)
    m[:3, :3] = rot
    m[:3, 3] = -rot @ pose.position
    return m


def project(pose: Pose, k: Intrinsics, point) -> tuple[float, float, float]:
    """Pixel (u, v) where the world point appears, and its depth along the view axis."""
    r, d, f = camera_axes(pose)
    rel = np.asarray(point, dtype=np.float64) - pose.position
    depth = float(rel @ f)
    if depth <= 1e-6:
        return float("nan"), float("nan"), depth
    return k.cx + k.fx * float(rel @ r) / depth, k.cy + k.fy * float(rel @ d) / depth, depth


def unproject(pose: Pose, k: Intrinsics, u: float, v: float, depth: float) -> np.ndarray:
    """World point seen at pixel (u, v) at camera depth `depth` (metres along the view axis)."""
    r, d, f = camera_axes(pose)
    xc = (u - k.cx) / k.fx * depth
    yc = (v - k.cy) / k.fy * depth
    return pose.position + xc * r + yc * d + depth * f

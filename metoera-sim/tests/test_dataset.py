"""Labels come from the geometry, and the new detection head starts as a copy of COCO."""

import numpy as np

from metoera_sim.camera import Intrinsics, Pose
from metoera_sim.dataset import dark_rectangle, visible_box
from metoera_sim.train_yolo import graft_classes, passes_gate


def test_a_box_seen_whole_is_labelled_and_one_out_of_frame_is_not():
    k = Intrinsics.tello(width=100, height=100)
    pose = Pose(0, 0, 0, yaw=0)
    # A square 2 m ahead, facing the camera: it fills the middle of the picture.
    points = np.array([[2, y, z] for y in (-0.2, 0.2) for z in (-0.2, 0.2)])
    depth = np.full((100, 100), 2.0)
    box = visible_box(points, pose, k, depth)
    assert box is not None and abs(box[0] - 0.5) < 0.15 and abs(box[1] - 0.5) < 0.15
    assert visible_box(points + np.array([0, 50, 0]), pose, k, depth) is None


def test_a_box_half_hidden_behind_something_closer_keeps_only_the_visible_half():
    k = Intrinsics.tello(width=100, height=100)
    pose = Pose(0, 0, 0, yaw=0)
    points = np.array([[2.0, y, 0.0] for y in np.linspace(-0.4, 0.4, 20)])
    depth = np.full((100, 100), 2.0)
    whole = visible_box(points, pose, k, depth, min_fraction=0.25)
    # The right half of the picture is a wall 0.5 m away, so those points are hidden.
    depth[:, 50:] = 0.5
    hidden = visible_box(points, pose, k, depth, min_fraction=0.25)
    assert whole is not None and hidden is not None
    assert hidden[2] < whole[2]


def test_a_dark_pad_is_cut_out_of_a_photo():
    image = np.full((40, 60, 3), 200, dtype=np.uint8)
    image[10:25, 15:35] = 10
    assert dark_rectangle(image) == (15, 10, 34, 24)


def test_the_new_head_keeps_the_coco_rows_and_only_the_new_rows_are_fresh():
    old = {"cls.weight": np.arange(80 * 4, dtype=np.float32).reshape(80, 4), "box.weight": np.ones((3, 3))}
    fresh = np.full((82, 4), 7.0, dtype=np.float32)
    new = {"cls.weight": fresh, "box.weight": np.zeros((3, 3))}
    grafted = graft_classes(old, new)
    assert np.array_equal(grafted["cls.weight"][:80], old["cls.weight"])
    assert np.all(grafted["cls.weight"][80:] == 7)
    assert np.array_equal(grafted["box.weight"], old["box.weight"])


def test_the_coco_gate_rejects_a_model_that_forgets_people():
    old = {"all": 40.0, "person": 50.0}
    assert passes_gate(old, {"all": 39.0, "person": 49.2})
    assert not passes_gate(old, {"all": 39.5, "person": 48.0})
    assert not passes_gate(old, {"all": 37.0, "person": 50.0})

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import pytest  # noqa: E402

from metoera_vision.detect import RawBox  # noqa: E402


class StubDetector:
    """Returns fixed pixel boxes; records which frames it was asked to process."""

    name = "stub"
    device = "cpu"

    def __init__(self, boxes=None, delay=0.0):
        self.boxes = boxes if boxes is not None else [
            RawBox(96, 72, 288, 432, 0.91, "person"),
            RawBox(700, 500, 900, 700, 0.55, "bottle"),
            RawBox(0, 0, 50, 50, 0.40, "person"),
        ]
        self.delay = delay
        self.seen = []

    def detect(self, image):
        import time
        self.seen.append(int(image[0, 0, 0]))  # frames are tagged via pixel value
        if self.delay:
            time.sleep(self.delay)
        return list(self.boxes)


@pytest.fixture
def stub():
    return StubDetector()

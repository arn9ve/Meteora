"""metoera-vision: object detection on the Tello EDU video stream."""

import os
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent

# Keep Ultralytics' settings file inside this project (it otherwise writes to the
# user's global config dir). Must run before `ultralytics` is imported anywhere.
# Analytics sync is switched off in detect.YoloDetector right after import.
os.environ.setdefault("YOLO_CONFIG_DIR", str(PROJECT_ROOT / ".ultralytics"))

# Hugging Face (depth model): cache weights inside the project and never send telemetry.
os.environ.setdefault("HF_HOME", str(PROJECT_ROOT / ".hf-cache"))
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
os.environ.setdefault("DO_NOT_TRACK", "1")

__version__ = "0.1.0"

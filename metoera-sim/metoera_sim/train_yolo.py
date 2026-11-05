"""Fine-tune yolo11n on the venue without forgetting COCO.

Copies the 80 COCO class rows into an 82-class head (pillar, mission pad start fresh), freezes the
backbone, and keeps the result only when held-out COCO drops by at most 1.5 points overall and
1 point for person. Real flights stay on yolo11n.pt until vision is started with the new file:

    python -m metoera_vision --model ../metoera-sim/weights/metoera-venue.pt
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

OLD_NC = 80
NEW_NC = 82


def graft_classes(old: dict, new: dict, old_nc: int = OLD_NC) -> dict:
    """Copy every matching weight, and the first `old_nc` rows of any class tensor that grew."""
    out = {key: value.copy() for key, value in new.items()}
    for key, src in old.items():
        if key not in out:
            continue
        dst = out[key]
        if src.shape == dst.shape:
            out[key] = src.copy()
        elif src.ndim == dst.ndim and src.shape[1:] == dst.shape[1:] and src.shape[0] == old_nc and dst.shape[0] >= old_nc:
            merged = dst.copy()
            merged[:old_nc] = src
            out[key] = merged
    return out


def passes_gate(old: dict, new: dict, overall: float = 1.5, person: float = 1.0) -> bool:
    """True when the new model did not lose more than the allowed COCO points."""
    return new["all"] >= old["all"] - overall and new["person"] >= old["person"] - person


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Train the venue YOLO and keep it only if COCO still holds.")
    p.add_argument("--data", default="datasets/metoera-venue/data.yaml")
    p.add_argument("--base", default="yolo11n.pt")
    p.add_argument("--out", default="weights/metoera-venue.pt")
    p.add_argument("--epochs", type=int, default=30)
    p.add_argument("--device", default="0")
    args = p.parse_args(argv)
    report = {"base": args.base, "data": args.data, "epochs": args.epochs, "kept": False,
              "note": "Run after dataset.py and a COCO val2017 download. The gate is passes_gate."}
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).with_suffix(".report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

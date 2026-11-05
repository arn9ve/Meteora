#!/usr/bin/env python3
"""
Offline / Mac demo: identify which of the 6 space pads is in a camera frame.

Uses ORB feature matching against resized references in pads/refs/.
Color-circle counts are a weak secondary cue (HSV is lighting-sensitive).

How this will feed Tello moves (live path, later):
  1. Drone/phone frame → identify pad id + rough yaw from rocket/astronaut asymmetry.
  2. Compare id to mission targetPad (e.g. pad-02).
  3. If wrong pad or off-center: issue small meteora-voice move/rotate corrections.
  4. If pad-02 centered and oriented: land (still ARM / human gated upstream).

Usage:
  python tools/pad_recognize.py path/to/frame.jpg
  python tools/pad-recognize.py --self-test
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
REF_DIR = ROOT / "pads" / "refs"


def load_refs():
    orb = cv2.ORB_create(1200)
    refs = {}
    for path in sorted(REF_DIR.glob("pad-*.jpg")):
        img = cv2.imread(str(path))
        if img is None:
            continue
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        kp, des = orb.detectAndCompute(gray, None)
        refs[path.stem] = {"path": path, "img": img, "kp": kp, "des": des}
    return orb, refs


def match_pad(orb, refs, bgr):
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    # Normalize scale toward ref size
    side = 512
    gray = cv2.resize(gray, (side, side))
    kp, des = orb.detectAndCompute(gray, None)
    if des is None:
        return None, {}

    bf = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=True)
    scores = {}
    for pad_id, ref in refs.items():
        if ref["des"] is None:
            scores[pad_id] = 0
            continue
        matches = bf.match(des, ref["des"])
        good = [m for m in matches if m.distance < 55]
        scores[pad_id] = len(good)

    ranked = sorted(scores.items(), key=lambda x: -x[1])
    best_id, best_score = ranked[0]
    second = ranked[1][1] if len(ranked) > 1 else 0
    margin = best_score - second
    ok = best_score >= 40 and margin >= 8
    return (best_id if ok else None), {
        "scores": scores,
        "best": best_id,
        "best_score": best_score,
        "margin": margin,
        "accepted": ok,
    }


def self_test(orb, refs):
    rows = []
    for pad_id, ref in refs.items():
        # Slight blur + brightness to simulate non-identical frame
        noisy = ref["img"].copy()
        noisy = cv2.GaussianBlur(noisy, (3, 3), 0)
        noisy = cv2.convertScaleAbs(noisy, alpha=1.05, beta=5)
        pred, detail = match_pad(orb, refs, noisy)
        rows.append(
            {
                "true": pad_id,
                "pred": pred,
                "ok": pred == pad_id,
                "best_score": detail["best_score"],
                "margin": detail["margin"],
            }
        )
    return rows


def main():
    parser = argparse.ArgumentParser(description="Recognize Meteora space pads")
    parser.add_argument("image", nargs="?", help="Camera frame or photo to classify")
    parser.add_argument("--self-test", action="store_true", help="Match each ref against itself (sanity)")
    args = parser.parse_args()

    if not REF_DIR.is_dir():
        print(f"Missing refs at {REF_DIR}", file=sys.stderr)
        sys.exit(2)

    orb, refs = load_refs()
    if len(refs) < 6:
        print(f"Expected 6 refs, found {len(refs)} in {REF_DIR}", file=sys.stderr)
        sys.exit(2)

    if args.self_test:
        rows = self_test(orb, refs)
        print(json.dumps({"self_test": rows}, indent=2))
        failed = [r for r in rows if not r["ok"]]
        sys.exit(1 if failed else 0)

    if not args.image:
        parser.error("image path required (or use --self-test)")

    img = cv2.imread(args.image)
    if img is None:
        print(f"Could not read {args.image}", file=sys.stderr)
        sys.exit(2)

    pred, detail = match_pad(orb, refs, img)
    print(
        json.dumps(
            {
                "pad": pred,
                "detail": detail,
                "tello_hint": (
                    f"If mission target is pad-02 and seen={pred}: "
                    + (
                        "centered approach / land when CV stable"
                        if pred == "pad-02"
                        else "translate/rotate using pad constellation until pad-02"
                    )
                ),
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()

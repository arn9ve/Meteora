#!/usr/bin/env python3
"""
Live Tello video window (STA or AP).

  python live_video.py
  python live_video.py --ip 192.168.5.137

Keys:  q / Esc = quit
"""

from __future__ import annotations

import argparse
import os
import time

from dotenv import load_dotenv
from djitellopy import Tello

load_dotenv()


def main() -> None:
    import cv2

    p = argparse.ArgumentParser()
    p.add_argument(
        "--ip",
        default=os.getenv("TELLO_IP", "192.168.5.137"),
        help="Drone IP (STA LAN IP or 192.168.10.1 in AP mode)",
    )
    args = p.parse_args()

    tello = Tello(args.ip)
    tello.connect()
    print(f"Connected @ {args.ip} — battery {tello.get_battery()}%")
    tello.streamon()
    time.sleep(1.5)
    reader = tello.get_frame_read()

    print("Live feed — press q or Esc to quit")
    try:
        while True:
            frame = reader.frame
            if frame is None:
                time.sleep(0.05)
                continue
            # djitellopy often returns RGB; OpenCV wants BGR for correct colors
            bgr = cv2.cvtColor(frame, cv2.COLOR_RGB2BGR)
            bat = tello.get_battery()
            cv2.putText(
                bgr,
                f"METEORA  {args.ip}  bat {bat}%",
                (12, 32),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.8,
                (0, 255, 0),
                2,
                cv2.LINE_AA,
            )
            cv2.imshow("METEORA live", bgr)
            key = cv2.waitKey(1) & 0xFF
            if key in (ord("q"), 27):
                break
    finally:
        try:
            tello.streamoff()
        except Exception:
            pass
        tello.end()
        cv2.destroyAllWindows()


if __name__ == "__main__":
    main()

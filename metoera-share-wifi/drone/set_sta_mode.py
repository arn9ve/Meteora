#!/usr/bin/env python3
"""
Switch Tello EDU into Station (STA) mode so it joins a Wi-Fi network
that has internet (needed so the Mac can reach both the drone and Grok).

How to use (on your Mac):
  1. Connect Mac Wi-Fi to the drone AP: TELLO-XXXXXX
  2. Activate venv, then: python set_sta_mode.py
  3. Wait for the drone to reboot (~30–60s)
  4. Reconnect Mac to the same network as the drone (e.g. hackathon)
  5. Run: python find_tello.py
"""

from __future__ import annotations

import os
import sys

from dotenv import load_dotenv
from djitellopy import Tello

load_dotenv()

SSID = os.getenv("STA_SSID", "hackathon")
PASSWORD = os.getenv("STA_PASSWORD", "hackathon")


def main() -> None:
    print(f"Connecting to Tello (default AP IP 192.168.10.1)...")
    print(f"Will send: ap {SSID} <password>")
    tello = Tello()
    try:
        tello.connect()
        battery = tello.get_battery()
        print(f"Connected. Battery: {battery}%")

        print("Sending AP (STA) command — drone will reboot...")
        # SDK: ap ssid pass  → join that Wi-Fi as a client
        reply = tello.send_command_with_return(f"ap {SSID} {PASSWORD}")
        print(f"Reply: {reply}")
        print(
            "\nDone. Reconnect your Mac to the shared Wi-Fi, then run:\n"
            "  python find_tello.py\n"
            "and set TELLO_IP in .env to the address found."
        )
    except Exception as exc:  # noqa: BLE001 — hackathon script, surface anything
        print(f"Failed: {exc}", file=sys.stderr)
        sys.exit(1)
    finally:
        try:
            tello.end()
        except Exception:  # noqa: BLE001
            pass


if __name__ == "__main__":
    main()

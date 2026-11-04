#!/usr/bin/env python3
"""
Join one aircraft to a Wi-Fi network.

The Edu and the Talent use the same SDK command: ap <ssid> <password>.
On the Talent, put the expansion-board switch in router mode first.
This script does not read the SSID or password from .env.

1. Join the aircraft access point, TELLO-... or RMTT-...
2. python set_sta_mode.py
   It asks for the SSID and password. --ssid, --password, and --yes skip the prompts.
3. Wait about 30–60 seconds for the reboot.
4. Join that same Wi-Fi on this computer.
5. python find_tello.py
"""

from __future__ import annotations

import argparse
import getpass
import sys


def require_credentials(ssid, password):
    """Return the SSID and password, or raise ValueError."""
    return _field(ssid, "SSID"), _field(password, "password")


def _field(value, name):
    if value is None:
        raise ValueError(f"{name} is required.")
    text = str(value).strip()
    if text == "":
        raise ValueError(f"{name} is required.")
    if " " in text:
        raise ValueError(f"{name} cannot contain a space.")
    return text


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="Join one aircraft to a Wi-Fi network.")
    parser.add_argument("--ssid", help="Wi-Fi name. Asked for when omitted.")
    parser.add_argument("--password", help="Wi-Fi password. Asked for when omitted.")
    parser.add_argument("--yes", action="store_true", help="Send ap without the confirmation prompt.")
    return parser.parse_args(argv)


def confirmed(ssid, yes, input_fn=input):
    print(f"SSID: {ssid}")
    print(
        "The aircraft will reboot and leave its own access point "
        "until the power button is held for 5 seconds."
    )
    print("On the Talent, the expansion-board switch has to be in router mode.")
    if yes:
        return True
    answer = input_fn("Type y to send ap: ")
    return answer.strip().lower() == "y"


def main(argv=None) -> None:
    args = parse_args(argv)
    ssid = args.ssid if args.ssid is not None else input("Wi-Fi SSID: ")
    password = args.password if args.password is not None else getpass.getpass("Wi-Fi password: ")
    try:
        ssid, password = require_credentials(ssid, password)
    except ValueError as exc:
        print(exc, file=sys.stderr)
        sys.exit(1)
    if not confirmed(ssid, args.yes):
        print("Stopped. No command was sent.")
        return

    from djitellopy import Tello

    print("Connecting to the aircraft at 192.168.10.1...")
    tello = Tello()
    try:
        tello.connect()
        battery = tello.get_battery()
        print(f"Connected. Battery: {battery}%")
        print("Sending ap. The aircraft will reboot...")
        reply = tello.send_command_with_return(f"ap {ssid} {password}")
        print(f"Reply: {reply}")
        print(
            "\nDone. Join this computer to that Wi-Fi, then run:\n"
            "  python find_tello.py\n"
            "and set TELLO_IP in .env to the address found."
        )
    except Exception as exc:  # noqa: BLE001 — show the SDK failure and stop
        print(f"Failed: {exc}", file=sys.stderr)
        sys.exit(1)
    finally:
        try:
            tello.end()
        except Exception:  # noqa: BLE001
            pass


if __name__ == "__main__":
    main()

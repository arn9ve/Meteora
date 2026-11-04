#!/usr/bin/env python3
"""
Find a Tello/RoboMaster TT on the local LAN after STA mode.

Tries:
  1. UDP broadcast probe on port 8889 (command port)
  2. Optional: scan a /24 subnet if LOCAL_SUBNET is set (e.g. 192.168.1.0/24)

Once you have the IP, put it in .env as TELLO_IP=...
"""

from __future__ import annotations

import ipaddress
import os
import socket
import sys
import time

from dotenv import load_dotenv

load_dotenv()

CMD_PORT = 8889
TIMEOUT_S = 1.0


def probe(ip: str) -> bool:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.settimeout(TIMEOUT_S)
    try:
        sock.sendto(b"command", (ip, CMD_PORT))
        data, _ = sock.recvfrom(1024)
        reply = data.decode(errors="ignore").strip().lower()
        return reply in {"ok", "ok\r\n", "ok\n"} or "ok" in reply
    except OSError:
        return False
    finally:
        sock.close()


def broadcast_probe(broadcast: str = "255.255.255.255") -> list[str]:
    """Best-effort: some firmwares answer unicast only; still try broadcast."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    sock.settimeout(TIMEOUT_S)
    found: list[str] = []
    try:
        sock.sendto(b"command", (broadcast, CMD_PORT))
        deadline = time.time() + 2.0
        while time.time() < deadline:
            try:
                data, addr = sock.recvfrom(1024)
                reply = data.decode(errors="ignore").strip().lower()
                if "ok" in reply:
                    found.append(addr[0])
            except socket.timeout:
                break
    except OSError as exc:
        print(f"Broadcast probe skipped: {exc}")
    finally:
        sock.close()
    return sorted(set(found))


def scan_subnet(cidr: str) -> list[str]:
    net = ipaddress.ip_network(cidr, strict=False)
    print(f"Scanning {cidr} (this can take a minute)...")
    hits: list[str] = []
    for host in net.hosts():
        ip = str(host)
        if probe(ip):
            print(f"  hit: {ip}")
            hits.append(ip)
    return hits


def main() -> None:
    print("Probing for Tello on LAN...")
    found = broadcast_probe()
    if found:
        print("Broadcast replies from:", ", ".join(found))
    else:
        print("No broadcast replies (common). Trying known / default next.")

    # Always try classic AP IP + optional .env IP
    candidates = ["192.168.10.1"]
    env_ip = os.getenv("TELLO_IP")
    if env_ip and env_ip not in candidates:
        candidates.append(env_ip)

    for ip in candidates:
        print(f"Probing {ip}...")
        if probe(ip):
            print(f"FOUND: {ip}")
            print(f"Set in .env → TELLO_IP={ip}")
            return

    subnet = os.getenv("LOCAL_SUBNET")
    if subnet:
        hits = scan_subnet(subnet)
        if hits:
            print("FOUND:", ", ".join(hits))
            print(f"Set in .env → TELLO_IP={hits[0]}")
            return
        print("No drones found on subnet.")
        sys.exit(1)

    print(
        "\nNo Tello found yet.\n"
        "Tips:\n"
        "  • Confirm Mac is on the same Wi-Fi the drone joined (STA).\n"
        "  • Check router DHCP client list for a new device.\n"
        "  • Or set LOCAL_SUBNET=192.168.x.0/24 in .env and re-run."
    )
    sys.exit(1)


if __name__ == "__main__":
    main()

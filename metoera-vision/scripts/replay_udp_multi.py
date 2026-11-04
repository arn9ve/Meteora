#!/usr/bin/env python3
"""Simulate several Tellos streaming to ONE port at the same time.

Each sender is a separate UDP socket bound to its own local source address, so
the receiver can tell them apart by sender address. Every sender replays a raw
H.264 file (Annex-B, like the Tello's) in 1460-byte datagrams, one access unit
per frame period, looping.

    .venv/bin/python scripts/replay_udp_multi.py \\
        --from 127.0.0.1:50001 --from 127.0.0.1:50002 --to 127.0.0.1:11111

then run the service with
    .venv/bin/python -m metoera_vision --drones tello=127.0.0.1:50001,rmtt=127.0.0.1:50002

Only sends to the --to address you give (default 127.0.0.1:11111). Never talks to a drone.
"""

from __future__ import annotations

import argparse
import socket
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CHUNK = 1460


def access_units(path: Path) -> list[bytes]:
    import av

    ctx = av.CodecContext.create("h264", "r")
    data = path.read_bytes()
    aus = [bytes(p) for i in range(0, len(data), 65536) for p in ctx.parse(data[i:i + 65536])]
    aus += [bytes(p) for p in ctx.parse(b"")]  # flush the last unit
    return [a for a in aus if a]


def addr(s: str) -> tuple[str, int]:
    host, port = s.rsplit(":", 1)
    return host, int(port)


def sender(src: tuple[str, int], dst: tuple[str, int], aus: list[bytes], fps: float, duration: float,
           offset: int, stop: threading.Event, counts: dict) -> None:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(src)
    period = 1.0 / fps
    end = time.monotonic() + duration if duration > 0 else float("inf")
    nxt = time.monotonic()
    i = offset % len(aus)
    key = f"{src[0]}:{src[1]}"
    while not stop.is_set() and time.monotonic() < end:
        au = aus[i]
        for j in range(0, len(au), CHUNK):
            sock.sendto(au[j:j + CHUNK], dst)
            counts[key] = counts.get(key, 0) + 1
        i = (i + 1) % len(aus)
        nxt += period
        d = nxt - time.monotonic()
        if d > 0:
            time.sleep(d)
        else:
            nxt = time.monotonic()
    sock.close()


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--file", default=str(ROOT / "samples" / "sample.h264"), help="raw H.264 (Annex-B) file")
    p.add_argument("--from", dest="sources", action="append", required=True,
                   help="local source address HOST:PORT for one simulated drone (repeat)")
    p.add_argument("--to", default="127.0.0.1:11111", help="receiver address")
    p.add_argument("--fps", type=float, default=30.0)
    p.add_argument("--duration", type=float, default=0, help="seconds (0 = until Ctrl-C)")
    a = p.parse_args(argv)

    aus = access_units(Path(a.file))
    if not aus:
        print(f"no H.264 access units in {a.file}", file=sys.stderr)
        return 1
    dst = addr(a.to)
    stop = threading.Event()
    counts: dict = {}
    # Offset the senders in the clip so the two "drones" show different frames.
    threads = [threading.Thread(target=sender, daemon=True,
                                args=(addr(s), dst, aus, a.fps, a.duration, k * len(aus) // 2, stop, counts))
               for k, s in enumerate(a.sources)]
    print(f"replaying {len(aus)} access units from {a.file} to {a.to} from {', '.join(a.sources)}", flush=True)
    for t in threads:
        t.start()
    try:
        while any(t.is_alive() for t in threads):
            time.sleep(0.2)
    except KeyboardInterrupt:
        stop.set()
    for t in threads:
        t.join(timeout=2)
    print("datagrams sent:", counts, flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())

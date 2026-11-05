#!/usr/bin/env bash
# Simulates the Tello video feed: streams a sample clip as a raw H.264 elementary
# stream over UDP in 1460-byte datagrams to 127.0.0.1:11111 (looping, real-time).
# Usage: scripts/replay_udp.sh [file] [port]
set -euo pipefail
cd "$(dirname "$0")/.."
FILE="${1:-samples/sample.mp4}"
PORT="${2:-11111}"
exec ffmpeg -hide_banner -loglevel warning -re -stream_loop -1 -i "$FILE" \
  -an -c:v libx264 -preset ultrafast -tune zerolatency -g 30 -pix_fmt yuv420p -s 960x720 \
  -f h264 "udp://127.0.0.1:${PORT}?pkt_size=1460"

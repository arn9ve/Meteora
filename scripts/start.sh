#!/usr/bin/env bash
# Start Meteora from one terminal: the camera service (meteora-vision), the phone detectors
# (meteora-redzone) and the main app (meteora-voice). Ctrl+C stops everything; drones that are
# flying land first. Logs of the first two go to logs/.
set -u
cd "$(dirname "$0")/.."

ENV_FILE=meteora-voice/.env.tello
if [ ! -f meteora-voice/.env ]; then echo "Missing meteora-voice/.env: copy meteora-voice/.env.example and add XAI_API_KEY."; exit 1; fi
if [ ! -f "$ENV_FILE" ]; then echo "Missing $ENV_FILE: copy meteora-voice/.env.tello.example and add each drone's IP and serial."; exit 1; fi
value() { grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'"; }
TELLO_IP=$(value TELLO_IP); RMTT_IP=$(value RMTT_IP)
DRONES=""
[ -n "$TELLO_IP" ] && DRONES="tello=$TELLO_IP"
[ -n "$RMTT_IP" ] && DRONES="${DRONES:+$DRONES,}rmtt=$RMTT_IP"

mkdir -p logs
PIDS=()
if [ -x meteora-vision/.venv/bin/python ] && [ -n "$DRONES" ]; then
  (cd meteora-vision && exec .venv/bin/python -m meteora_vision --drones "$DRONES") > logs/vision.log 2>&1 &
  PIDS+=($!); echo "Camera service started (logs/vision.log)."
else
  echo "Camera service not started: create meteora-vision/.venv first (docs/SETUP.md). Voice and phones still work."
fi
(cd meteora-redzone && exec node server.mjs) > logs/redzone.log 2>&1 &
PIDS+=($!); echo "Phone detectors started (logs/redzone.log)."

stop_others() { kill -TERM "${PIDS[@]}" 2>/dev/null; wait "${PIDS[@]}" 2>/dev/null; }
trap stop_others EXIT
echo "Main app:"
cd meteora-voice && node server.ts

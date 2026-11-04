# Tello EDU: connection notes and tools

Status on 4 November 2026: our Tello EDU (`TELLO-62A591`) is on the `hackathon` network at `192.168.5.137`. It answers the SDK over the LAN (SDK 30), its serial matches, and it completed a supervised test flight: takeoff, 5 s hover, land. Grok Voice flies it: a voice test flight worked, and the full command set is in the README.

## The one thing to know: the Tello replies to local port 8889

The drone sends every command reply to **UDP port 8889 on the computer**, whatever port the command came from. A client that sends from a random port gets no answer and looks like a dead link.

We confirmed this with a packet capture on the drone's own access point:

- `command` was sent from four local ports: 8889, 9000 and two ephemeral ports.
- All four `ok` replies went to local port 8889. Nothing arrived on the other ports.
- The Python comparison client saw the same: no reply when bound to 9000, `ok` when bound to 8889.
- Telemetry (UDP 8890) only started after our first `command`, so the drone was receiving the commands from every port. Only the reply path was the issue.

Rule for every client: **bind the command socket to local port 8889**. Only one process per computer can bind it, so the metoera-voice server opens 8889 (and 8890) once and flies every drone through it. Stop the scripts in `tools/` before starting the server.

> `metoera-link/tello-link.mjs` binds its command socket to port `0` (random) in `#open()`. On this drone that means replies never reach it. It should bind 8889. Not changed here; flagging it for the owner.

We tested one Tello EDU on SDK 30. A RoboMaster TT may behave differently; run `tools/diagnose-tello.mjs` on it before relying on this.

## Other problems we hit

| Symptom | Cause | Fix |
| --- | --- | --- |
| No SDK reply even from port 8889, but telemetry already flowing before we sent anything | The drone was still in an SDK session from an earlier client | Power-cycle the drone, then run the client first |
| "Serial does not match" | The serial copied from the label was missing one character (`C`), and `0` looks like `O` | Read it from the drone with `sn?`. `connect-tello.mjs` now saves what the drone reports in `.tello-station-result.json` on a mismatch |
| `sn?` returned `ok` | A late `ok` from a retried `command` was read as the answer | Each query now only accepts a reply of its own shape (number for `battery?`, alphanumeric for `sn?`) |
| `EHOSTUNREACH` from a script while ping works | macOS Local Network privacy blocks that app (seen with the Claude desktop app) | Run the scripts from Terminal, or allow the app in System Settings → Privacy & Security → Local Network |
| ARP lookup of `192.168.10.1` empty while ping works | Not investigated | Ignore it. The serial check (`sn?`) is the identity check |

## Tools (`metoera-voice/tools`)

All scripts run from macOS Terminal with Node 24. None of them flies the drone except `test-flight.mjs`.

| Script | Network | What it does |
| --- | --- | --- |
| `diagnose-tello.mjs` | Drone AP (`192.168.10.x`) | Listens on telemetry and four command ports at once, sends `command` from each, and reports which local port the replies reach. Writes `.tello-diagnostics.json` |
| `capture-tello.command` | Drone AP | Runs the diagnostic under `tcpdump` (asks for the Mac password) and counts UDP flows by port. Logs summaries only, never payloads |
| `check-tello-python.py` | Drone AP | Same `command` check from a plain Python client, for comparison |
| `connect-tello.mjs` | Drone AP | Confirms the serial with `sn?`, then sends `ap <ssid> <password>` to join the shared network. Reads `.env.tello` |
| `check-tello-lan.mjs [ip]` | Shared network | Read-only: `command`, `battery?`, `sdk?`, `sn?`. Default IP `192.168.5.137` |
| `test-flight.mjs [ip]` | Shared network | Supervised flight: checks serial and battery (≥ 30%), asks you to type `FLY`, takes off, hovers 5 s, lands. Any key lands immediately, `x` stops the motors (the drone drops) |

`.env.tello` (local, git-ignored) holds the setup values. Copy `.env.tello.example` and fill it in. `connect-tello.mjs` only accepts `hackathon` as the SSID; change that check if you use another network.

## Two drones (Tello EDU + RoboMaster TT)

Both drones reply to the computer's UDP 8889 and send telemetry to 8890, so two clients that each bind those ports cannot run together (EADDRINUSE). `src/udp-port.ts` opens each port once per process and routes every datagram by the drone's IP (and, for replies, its port 8889). Set `TELLO_IP`/`TELLO_SETUP_SERIAL` (droneId `tello`) and `RMTT_IP`/`RMTT_SETUP_SERIAL` (droneId `rmtt`) in `.env.tello`. `/api/command` picks the drone by `droneId`, `/api/emergency` lands or cuts every configured drone, and `/api/drones` lists both. Every voice tool names its drone (`black` = `tello`, `red` = `rmtt`).

RoboMaster TT notes (SDK 3.0): `hardware?` answers `RMTT` with the expansion board fitted, `TELLO` without it. With the board fitted, Wi-Fi comes from the board's ESP32 (`RMTT-xxxxxx`); send `ap <ssid> <password>` in direct mode, then move the board switch to router mode. Not yet tried on our RMTT: whether its replies come from port 8889 (the code requires it) and whether they go to local 8889 like the EDU. `tools/diagnose-tello.mjs` checks this, but its MAC check is for our EDU.

## Full procedure

1. Charge the drone. Reset its Wi-Fi if needed: power on, hold the power button 5 s until the light flashes yellow.
2. Join the Mac to `TELLO-XXXXXX`, then run `node tools/check-tello-lan.mjs 192.168.10.1`. If it gets no reply, power-cycle the drone and run `tools/capture-tello.command`.
3. Run `node tools/connect-tello.mjs`. On a serial mismatch, compare `receivedSerial` in `.tello-station-result.json` with the label and fix `.env.tello`.
4. When it prints "Done", the drone reboots onto the shared network. Join the Mac to the same network.
5. Find the drone's IP: ping the subnet, then look for its MAC in `arp -an` (ours starts with `60:60:1f`), or use `metoera-share-wifi/drone/find_tello.py`.
6. Run `node tools/check-tello-lan.mjs <ip>`, then `node tools/test-flight.mjs <ip>` with someone watching the drone.

## Before a flight

- At least 2 m clear around and above the drone, people away, propeller guards on if available.
- Flat surface, textured floor and good light: the Tello holds position with its downward camera and drifts over shiny or plain floors.
- If the computer loses the link mid-flight, the Tello lands by itself after about 15 s without commands.

## Next

- Voice commands beyond the test flight (move, rotate, flip, speed, stop) are tested against a fake drone only; try them on the real drone one at a time.
- Camera: `scan` (360° count) and `look` use `metoera-vision` (YOLO). Not yet tried with the real drone video.

# Metoera Voice

Fly a real Tello EDU with your voice through Grok. Every command moves the physical drone; there is no simulator any more.

The `tools` folder holds the scripts we used to put our Tello on the shared network, diagnose its UDP link and run a supervised test flight. Read [TELLO.md](TELLO.md) first: the Tello sends every reply to local UDP port 8889, and a client on any other port gets no answer.

## Getting started

You need Node.js 24.12 or later, an xAI API key, a microphone, and the Tello on the same Wi-Fi as the computer.

1. Copy `.env.example` to `.env` and add your key after `XAI_API_KEY=`. Copy `.env.tello.example` to `.env.tello` and set `TELLO_IP` and `TELLO_SETUP_SERIAL`. Both files are git-ignored.
2. Close the scripts in `tools/`: the server needs UDP 8889 and 8890.
3. From macOS Terminal (it needs Local Network access), run `npm install`, then `npm start`. It should print `Tello at <ip>`.
4. Open http://localhost:18787, click "Tap to speak" and allow the microphone.
5. Stop the server with Ctrl+C. If the drone is flying, it lands first.

The xAI key stays on the server; the browser gets a temporary token.

## Voice commands

Grok calls one tool per action, in the order you say them, and waits for each result. If you leave out a value it asks instead of guessing.

| Say | Tool | Tello SDK |
| --- | --- | --- |
| "Take off" | `takeoff` | `takeoff` (needs ≥ 20% battery) |
| "Land" | `land` | `land` |
| "Stop" / "wait" / "hold" | `stop` | `stop`: hover now, interrupting a running move |
| "Move forward half a meter" | `move` | `forward 50` (also back, left, right, up, down; 20 to 100 cm by default) |
| "Turn right 90 degrees" | `rotate` | `cw 90` / `ccw 90` |
| "Flip left" | `flip` | `flip l` (needs ≥ 50% battery) |
| "Set speed to 30" | `speed` | `speed 30` (10 to 100 cm/s) |
| "What's the battery?" | `status` | `battery?` plus telemetry |
| "Fly" | `test_flight` | takeoff, hover 5 s, land |

A sequence such as "take off, go up 50 centimeters, turn left 180, land" runs step by step. If a step fails, the rest is skipped and Grok says why; `stop` and `land` still go through.

## How the server talks to the drone (`src/tello.ts`)

- On the first command it sends `command` and checks `sn?` against `TELLO_SETUP_SERIAL`. A mismatch refuses every action.
- One request is in flight at a time, and each request only accepts a reply of its own shape, so a late `ok` is never read as the answer to something else.
- `stop` skips the queue so it reaches the drone during a move; queued commands wait for it.
- While connected it sends `battery?` every 5 s, so the Tello does not land itself after 15 s of silence.
- `TELLO_MAX_MOVE_CM` in `.env.tello` raises the move limit (default 100, SDK maximum 500).
- `GET /api/drones` returns `{drone}` with battery, height, heading, flight state and last error. `POST /api/command` takes `{droneId: "tello", action, ...}` and only accepts requests from the page's own origin.

Safety: these limits are enforced on the server, but what Grok decides to call is not. There is no voice emergency motor stop. Keep someone next to the drone; Ctrl+C on the server lands it.

## Verification

`npm run typecheck` and `npm test` (voice UI states, and the Tello adapter against a fake drone: command mapping, serial check, battery limits, move limit, late replies, keepalive, stop interrupting a move). A live session needs the real drone, a key and the microphone, and is not covered by the tests.

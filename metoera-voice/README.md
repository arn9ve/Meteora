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

## Two drones: Black and Red

| Name | Model | `.env.tello` | droneId |
| --- | --- | --- | --- |
| Drone 1 · Black | Tello EDU | `TELLO_IP`, `TELLO_SETUP_SERIAL` | `tello` |
| Drone 2 · Red | RoboMaster TT | `RMTT_IP`, `RMTT_SETUP_SERIAL` | `rmtt` |

Set only the IP of a drone you have; the other one stays off the page. Use the serial the drone reports with `sn?` (`tools/check-tello-lan.mjs` prints it), not the label on the box: our RoboMaster's box says `42YF…`, the drone says `0TQZ…`.

Every drone tool takes `drone: black | red`. Grok asks which one when you don't say. "Both" runs the command on Black, then Red. `land` and `stop` with no drone go to both; so does `emergency`. Switch off and Cut motors act on both drones.

Both drones reply to the computer's UDP port 8889, so the server opens 8889 and 8890 once and routes each datagram by sender IP (`src/udp-port.ts`). The two drones need different IPs.

To check, join or fly a second drone with the tools, pass its serial on the command line; `.env.tello` is not changed:

```bash
TELLO_EXPECT_SERIAL=<serial> node tools/check-tello-lan.mjs <ip>
TELLO_EXPECT_SERIAL=<serial> node tools/connect-tello.mjs
TELLO_EXPECT_SERIAL=<serial> node tools/test-flight.mjs <ip>
```

## Phone

On start the server also listens with HTTPS on the local network (port 18788) and prints a link like `https://192.168.5.16:18788/?key=…`. Open it on a phone on the same Wi-Fi.

- The key in the link is required for every request, so other people on the shared Wi-Fi cannot fly the drones. Do not share it. It is kept in `.phone/key.txt` (git-ignored); delete the folder to get a new one.
- The certificate is self-signed (also in `.phone/`): accept the browser warning once. HTTPS is needed because phones only allow the microphone on secure pages. Android Chrome works with this; iOS Safari may refuse the microphone with a self-signed certificate.
- `PHONE_ACCESS=off` disables it; `PHONE_PORT` changes the port.

## Cameras (YOLO on both drones)

Both drones stream video to UDP 11111 on this computer once the server has sent `streamon`. Start the vision service with both drones so it separates the two streams by sender IP:

```bash
cd ../metoera-vision && .venv/bin/python -m metoera_vision --drones tello=192.168.5.137,rmtt=192.168.5.68
```

The Drones panel shows each drone's live video with YOLO boxes (`/video/tello`, `/video/rmtt`, passed through from the vision service). `scan` and `look` read the detections of the drone they are called for.

## Voice commands

Grok calls one tool per action, in the order you say them, and waits for each result. If you leave out a value it asks instead of guessing.

| Say | Tool | Tello SDK |
| --- | --- | --- |
| "Black, take off" | `takeoff` | `takeoff` (needs ≥ 20% battery) |
| "Land" | `land` | `land` |
| "Stop" / "wait" / "hold" | `stop` | `stop`: hover now, interrupting a running move |
| "Move forward half a meter" | `move` | `forward 50` (also back, left, right, up, down; 20 to 100 cm by default) |
| "Turn right 90 degrees" | `rotate` | `cw 90` / `ccw 90` |
| "Flip left" | `flip` | `flip l` (needs ≥ 50% battery) |
| "Set speed to 30" | `speed` | `speed 30` (10 to 100 cm/s) |
| "What's the battery?" | `status` | `battery?` plus telemetry |
| "Fly" | `test_flight` | takeoff, hover 5 s, land |
| "Do a 360 and count the people" | `scan` | `cw 90` four times, counting people from the camera at each stop |
| "What do you see?" | `look` | none: reads the latest camera detections |
| "Emergency" / "cut the motors" | `emergency` | `emergency`: motors stop at once, the drone drops |
| "Stop listening" / "mute" | `mute` | none: turns the microphone off in the page |

A sequence such as "take off, go up 50 centimeters, turn left 180, land" runs step by step. If a step fails, the rest is skipped and Grok says why; `stop` and `land` still go through.

## Emergency controls

Always on screen, even without a voice session:

- **Switch off · land**: cancels every queued command, interrupts the one running, sends `land` (up to 3 tries) and ends the voice session.
- **Cut motors**: sends `emergency` three times; the motors stop and the drone drops. The button needs a second tap within 2 s so a stray click cannot drop the drone. Saying "emergency" acts at once.
- **Microphone button** (centre, during a session): turns the microphone off. No audio reaches Grok, what it already heard is cleared, its reply is cancelled, and any tool call that still arrives is ignored except `stop`, `land` and `emergency`. Tap again to turn it back on. Saying "stop listening" does the same; turning it back on needs the button.

Both drone buttons call `POST /api/emergency` with `{kind: "land" | "motors"}`, which skips the command queue.

## Camera: counting and looking

`scan` and `look` need the object-detection service [`../metoera-vision`](../metoera-vision) running on the same computer:

1. After it verifies each drone's serial, the server sends `streamon`, so every drone streams H.264 video to this computer on UDP 11111.
2. Start the vision service from macOS Terminal (setup in its README) with the same drones as `.env.tello`: `.venv/bin/python -m metoera_vision --drones tello=<TELLO_IP>,rmtt=<RMTT_IP>`. It separates the streams by sender, runs YOLO on each and serves results per drone on http://127.0.0.1:18790 (`/stream?drone=tello` shows that drone's annotated video).
3. Say "take off Black, do a 360 and count the people at the table".

`scan` turns clockwise in four 90-degree steps (the Tello camera sees about 82 degrees across). At each stop it waits for a detection made after the drone settled, counts that object class with confidence at least 0.5, and turns again; after the fourth turn it faces where it started. Grok gets the count per view and the total. The total is approximate: someone at the edge between two views can be missed or counted twice, and people outside the camera's vertical view (too close, too low) are not seen. `VISION_URL` changes the service address.

## How the server talks to the drone (`src/tello.ts`)

- On the first command it sends `command` and checks `sn?` against `TELLO_SETUP_SERIAL`. A mismatch refuses every action.
- One request is in flight at a time, and each request only accepts a reply of its own shape, so a late `ok` is never read as the answer to something else.
- `stop` skips the queue so it reaches the drone during a move; queued commands wait for it.
- While connected it sends `battery?` every 5 s, so the Tello does not land itself after 15 s of silence.
- `TELLO_MAX_MOVE_CM` in `.env.tello` raises the move limit (default 100, SDK maximum 500).
- `GET /api/drones` returns `{drones: [...]}`, one entry per configured drone with battery, height, heading, flight state and last error. `POST /api/command` takes `{droneId: "tello" | "rmtt", action, ...}` and only accepts requests from the page's own origin. `POST /api/emergency` answers `{ok, error?, drones: {id: result}}`.

Safety: these limits are enforced on the server, but what Grok decides to call is not. Keep someone next to the drone. Ctrl+C on the server lands it.

## Verification

`npm run typecheck` and `npm test` (voice UI states, and the Tello adapter against a fake drone: command mapping, serial check, battery limits, move limit, late replies, keepalive, stop interrupting a move, scan and look with a fake camera). The scan was also run end to end against the real YOLO service on a sample image. A live session needs the real drone, a key and the microphone, and is not covered by the tests.

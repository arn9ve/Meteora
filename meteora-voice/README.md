# Meteora Voice

Fly the Tello EDU (Drone 1 · Black) and the RoboMaster TT (Drone 2 · Red) with your voice through Grok. Every command moves a physical drone; there is no simulator. Several people can fly at once, each from their own page: **the person who takes off a drone flies it until it has landed**, and nobody else can command it, not even land it (see [Several people](#several-people-who-flies-which-drone) and [Several laptops](#several-laptops-which-laptop-holds-which-drone)).

The `tools` folder holds the scripts we used to put our Tello on the shared network, diagnose its UDP link and run a supervised test flight. Read [TELLO.md](TELLO.md) first: the Tello sends every reply to local UDP port 8889, and a client on any other port gets no answer.

## Getting started

You need Node.js 24.12 or later, an xAI API key, a microphone, and the drones on the same Wi-Fi as the computer.

1. Copy `.env.example` to `.env` and add your key after `XAI_API_KEY=`. Copy `.env.tello.example` to `.env.tello` and set the IP and serial of each drone (`TELLO_IP`/`TELLO_SETUP_SERIAL`, `RMTT_IP`/`RMTT_SETUP_SERIAL`). Both files are git-ignored.
2. Close the scripts in `tools/`: the server needs UDP 8889, 8890 and 18789.
3. From macOS Terminal (it needs Local Network access), run `npm install`, then `npm start`. It prints each drone's address and the name the other laptops see for this one.
4. Open http://localhost:18787 and type your name (the lock goes by it). Click "Tap to speak" and allow the microphone.
5. Stop the server with Ctrl+C. A drone it flies lands first, whoever its pilot is, and the other laptops can take it over.

The xAI key stays on the server; the browser gets a temporary token.

## Two drones: Black and Red

| Name | Model | `.env.tello` | droneId |
| --- | --- | --- | --- |
| Drone 1 · Black | Tello EDU | `TELLO_IP`, `TELLO_SETUP_SERIAL` | `tello` |
| Drone 2 · Red | RoboMaster TT | `RMTT_IP`, `RMTT_SETUP_SERIAL` | `rmtt` |

Set only the IP of a drone you have; the other one stays off the page. Use the serial the drone reports with `sn?` (`tools/check-tello-lan.mjs` prints it), not the label on the box: on our RoboMaster the two are different.

Every drone tool takes `drone: black | red`. Grok asks which one when you don't say. "Both" runs the command on Black, then Red. `land` and `stop` with no drone go to every drone you may command on this laptop (the ones you fly and the free ones); so does `emergency`. The **Emergency land** button acts on the same drones.

Both drones reply to the computer's UDP port 8889, so the server opens 8889 and 8890 once and routes each datagram by sender IP (`src/udp-port.ts`). The two drones need different IPs.

To check, join or fly a second drone with the tools, pass its serial on the command line; `.env.tello` is not changed:

```bash
TELLO_EXPECT_SERIAL=<serial> node tools/check-tello-lan.mjs <ip>
TELLO_EXPECT_SERIAL=<serial> node tools/connect-tello.mjs
TELLO_EXPECT_SERIAL=<serial> node tools/test-flight.mjs <ip>
```

## Several people: who flies which drone

Everyone who opens the page (on this laptop or through the phone link) types a name first. The name is what the lock goes by.

- **Taking a drone.** The person whose takeoff (or test flight) is accepted becomes the drone's **pilot**. A second takeoff arriving at the same moment is refused.
- **While it flies.** Only the pilot can command it. Everyone else gets "Black is flown by Amir. Only Amir can command it until it lands." for move, rotate, flip, speed, scan, **land, stop and emergency** too. Their **Emergency land** button skips it. Status, look and photo still work for everyone. The card says "flown by Amir", greyed, and Grok is told it may not command it.
- **Free again.** Once the drone is on the ground and nothing is running on it (after a land, an emergency, a failed takeoff, or a landing on low battery that telemetry reports), anyone can take off with it.
- **The pilot is gone.** When no page using the pilot's name has been heard from for 15 s (page closed, phone asleep or locked, name changed), the server lands the drone by itself, trying again every 5 s. Nobody else gets control. The pages poll every 1.5 s, so **keep the pilot's screen on**.
- **Names.** Compared without case or extra spaces: a laptop page and a phone with the same name are the same pilot. Changing your name mid-flight gives up control (the dialog warns you). The name is not a password: anyone who types "Amir" is Amir, so pick distinct names.

The person standing next to a drone is the only backstop if its pilot does something wrong: nobody else on the link can land it.

## Several laptops: which laptop holds which drone

Every teammate may run this server on their own laptop and list both drones in `.env.tello`. Only one laptop talks to a drone at a time (it **holds** it); the others never send it a packet. The Tello SDK has no owner: one `command` from a second laptop could take the drone's telemetry and video away from the laptop flying it.

- **At start.** A laptop listens 2 s for the others, then claims every listed drone that no laptop holds: it announces the claim and waits 1.5 s. If two laptops claim the same drone at once, the one with the lower id wins.
- **A flying drone stays where it is.** While a drone flies, has a pilot or runs a command, it is **locked** to its laptop. Every other laptop shows "Flown by Amir · Barry's laptop", greyed, with the battery and flight state that laptop announces and no video. It sends it nothing: no command, not land, and not **Emergency land** either.
- **A landed drone moves on takeoff.** A landed, idle drone held by another laptop shows "On the ground · on Barry's laptop · say take off to fly it here". Saying "take off" on your laptop asks Barry's laptop for it. Barry's laptop stops the video and lets go, your laptop shakes hands with the drone (`command`, `sn?`, `streamon`), and the takeoff runs, in about 2 s in all. You are then its pilot. If the drone took off on Barry's laptop meanwhile, you get "Black is flown by … on Barry's laptop" and nothing moves. Status on such a drone is answered from Barry's announcements; other commands are refused until it is here.
- **Stopping a server.** Ctrl+C lands what is flying, stops the video and says goodbye, so another laptop takes the drone over about 2 s later. If a laptop goes silent instead (crash, Wi-Fi), the others wait 3.5 s; if its drone was locked they wait 20 s more ("stopped answering · it lands by itself"), because the Tello lands by itself about 15 s after its last command. Nobody else can land it before that, so keep someone next to every drone.
- **How they find each other.** Each server announces its drones once a second, and at once when a lock changes, on UDP **18789**, as a broadcast to every network the laptop is on. The Drones panel lists **Laptops on this network**. If your teammate is missing there, the Wi-Fi blocks broadcasts: set `METEORA_PEERS` to the other laptop's IP on both laptops.

| Setting (`.env` or `.env.tello`) | Default | |
| --- | --- | --- |
| `METEORA_CLIENT_NAME` | the computer's name | the laptop name the others show ("Barry's laptop") |
| `METEORA_PEERS` | none | `ip[:port],...` of laptops to reach directly when broadcasts don't pass |
| `METEORA_CLAIMS_PORT` | `18789` | must be the same on every laptop |

There is no authentication between laptops: anyone on the Wi-Fi could announce a claim. Everyone must run the same version: an older server ignores the claims and the handover requests.

## Phone

On start the server also listens with HTTPS on the local network (port 18788) and prints a link like `https://192.168.5.16:18788/?key=…`. Open it on a phone on the same Wi-Fi.

- The key in the link is required for every request, so other people on the shared Wi-Fi cannot fly the drones. Do not share it. It is kept in `.phone/key.txt` (git-ignored); delete the folder to get a new one.
- The first time on each phone, open the certificate page the server prints (`http://<mac-ip>:18786/`) and follow it: download `meteora-ca.cer`, install it, and on iPhone turn it on in Settings → General → About → Certificate Trust Settings. It is a local root made once on this Mac (`.phone/`, git-ignored), valid 90 days and limited to private LAN addresses, so it cannot vouch for any internet site. After that Safari and Chrome open the page without warnings and allow the microphone.
- `PHONE_ACCESS=off` disables it; `PHONE_PORT` changes the port.

## Cameras (YOLO on both drones)

Both drones stream video to UDP 11111 on this computer once the server has sent `streamon`. Start the vision service with both drones so it separates the two streams by sender IP:

```bash
cd ../meteora-vision && .venv/bin/python -m meteora_vision --drones tello=192.168.5.137,rmtt=192.168.5.68
```

The Drones panel shows each drone's live video with YOLO boxes (`/video/tello`, `/video/rmtt`, passed through from the vision service). `scan` and `look` read the detections of the drone they are called for. Before each leg of a mission, the server also asks the vision service for metric depth (`/depth?drone=<id>`); without it the leg is flown in full.

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
| "Go to table 3" / "go to Zone 1" / "go home" | `go_to` | a planned route of moves and turns (see [Room, routes and missions](#room-routes-and-missions)) |
| "Where are you exactly?" | `localize` | none: one photo, Grok vision finds pillars and tables of the plan |
| "Can you fly to table 3?" | `preflight` | none: says what is ready, what is missing and how long it takes |
| "Run the calibration test" | `calibrate` | a fixed pattern of moves from a table, then back and land |
| "Describe what you see" / "find the person in green" | `describe` / `find` | none / turns until Grok vision finds it |
| "Come closer to the person" | `approach` | short moves toward the object, stops about 1 m away |
| "Explore the room" | `explore` | turns on the spot with photos, Grok vision lists what it sees |
| "Take a photo" | `photo` | none: saves the latest frame in `photos/` |

A sequence such as "take off, go up 50 centimeters, turn left 180, land" runs step by step. If a step fails, the rest is skipped and Grok says why; `stop` and `land` still go through.

## Room, routes and missions

The room plan (`room/capannone-gragnani.json`, or `ROOM_PLAN`) has the walls and pillars of the venue. The page adds the tables, red zones, phones and where each drone starts; these are saved in `.room.json`.

- `go_to` with a table, a zone or `home` becomes a route (`src/room.ts`): A* on a 20 cm grid, 50 cm from walls and tables, 80 cm from pillars, shortened to straight legs.
- In the air, `go_to` runs a mission (`src/mission.ts`): a survey on the first flight after takeoff, then legs of at most 2 m, each one checked with the camera's depth first. The fixed rules choose each step; Grok is asked only when something is off (`DECISION_MODE=0` turns that off).
- A person seen by a phone in a red zone sends the nearest drone into the zone, where it looks left, ahead and right and Grok reports. The page does this when **auto-send** is on (the default).
- If the Wi-Fi drops in flight, the drone backs up along its own path, flies home and lands when the link returns, or lands after 12 s.

The full sequence, the coordinate frames and the safety layers are in [../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md).

## Emergency controls

Always on screen, even without a voice session. They act on the drones this laptop holds that you fly or that nobody flies; a drone someone else flies is skipped and the button says so.

- **Emergency land**: cancels every queued command, interrupts the one running, sends `land` (up to 3 tries) and ends the voice session.
- **Cutting the motors** has no button. Say "emergency" or "cut the motors": the server sends `emergency` three times, the motors stop and the drone drops.
- **Microphone button** (centre, during a session): turns the microphone off. No audio reaches Grok, what it already heard is cleared, its reply is cancelled, and any tool call that still arrives is ignored except `stop`, `land` and `emergency`. Tap again to turn it back on. Saying "stop listening" does the same; turning it back on needs the button.

**Emergency land** calls `POST /api/emergency` with `{kind: "land"}`; the spoken emergency uses `{kind: "motors"}`. Both skip the command queue.

## Camera: counting and looking

`scan` and `look` need the object-detection service [`../meteora-vision`](../meteora-vision) running on the same computer:

1. After it verifies each drone's serial, the server sends `streamon`, so every drone streams H.264 video to this computer on UDP 11111.
2. Start the vision service from macOS Terminal (setup in its README) with the same drones as `.env.tello`: `.venv/bin/python -m meteora_vision --drones tello=<TELLO_IP>,rmtt=<RMTT_IP>`. It separates the streams by sender, runs YOLO on each and serves results per drone on http://127.0.0.1:18790 (`/stream?drone=tello` shows that drone's annotated video).
3. Say "take off Black, do a 360 and count the people at the table".

`scan` turns clockwise in four 90-degree steps (the Tello camera sees about 82 degrees across). At each stop it waits for a detection made after the drone settled, counts that object class with confidence at least 0.5, and turns again; after the fourth turn it faces where it started. Grok gets the count per view and the total. The total is approximate: someone at the edge between two views can be missed or counted twice, and people outside the camera's vertical view (too close, too low) are not seen. `VISION_URL` changes the service address.

## How the server talks to the drone (`src/tello.ts`)

- Before any packet it asks the ownership check (`src/claims.ts`): a drone another laptop holds, or one whose claim has not been confirmed yet, gets nothing. While a drone is handed over, only its `streamoff` still leaves.
- On the first command it sends `command` and checks `sn?` against the drone's `…_SETUP_SERIAL`. A mismatch refuses every action.
- One request is in flight at a time, and each request only accepts a reply of its own shape, so a late `ok` is never read as the answer to something else.
- `stop` skips the queue so it reaches the drone during a move; queued commands wait for it.
- While connected it sends `battery?` every 5 s, so the Tello does not land itself after 15 s of silence.
- `TELLO_MAX_MOVE_CM` in `.env.tello` raises the move limit (default 100, SDK maximum 500).
- `GET /api/drones` returns `{drones: [...], me, clients, claimsError, pilot: {name, online}}`: one entry per drone with battery, height, heading, flight state, last error, `pilot` (`{name, me}` or null, for a drone this laptop holds) and `owner` (`mine`, `other` with the laptop's name, its `pilot` and `locked`, `taking`, `yielding`, `lost`, `claiming` or `waiting`), plus the other laptops heard and the names online. `POST /api/pilot {name}` sets this page's name (a cookie identifies the page). `POST /api/command` takes `{droneId: "tello" | "rmtt", action, ...}` and only accepts requests from the page's own origin; it refuses a drone someone else flies or another laptop holds, and a takeoff asks another laptop for a landed drone. `POST /api/emergency` answers `{ok, error?, drones: {id: result}, skipped: {id: reason}}`.

Safety: these limits are enforced on the server, but what Grok decides to call is not. Keep someone next to every drone. Ctrl+C on the server lands the drones it holds.

## Verification

`npm run typecheck` and `npm test`:
- **Page:** voice UI states, the emergency buttons, the cards and the Grok tools for every case (yours, free, flown by someone here, flown on another laptop, takeable), land with no drone named, and the rename warning.
- **Tello adapter against fake drones:** command mapping, serial check, battery limits, move limit, late replies, keepalive, stop interrupting a move, scan and look with a fake camera, two drones on one shared port, no packet at all to a drone another laptop holds, `streamoff` on release, and silence after a handover, then a fresh handshake when it comes back.
- **The pilot lock (`test/pilots.test.mjs`):** takeoff takes it, others are refused even land and emergency, read-only actions stay open, the same name on two pages, a rename, freed on the ground, a failed takeoff, and the 15 s absence.
- **The laptop protocol (`test/claims.test.mjs`):** claiming, the tie-break, silent holders, goodbye, malformed and older announcements, and the handover: a landed drone moves, a locked one never, a stale "locked" is not trusted, two requests at once, a holder that never lets go, and real UDP between two instances.

Run end to end as well: two servers on one computer (`METEORA_PORT`, `METEORA_CLAIMS_PORT`, `METEORA_PEERS`, `TELLO_LOCAL_PORT`, `TELLO_STATE_PORT`), one fake drone, and three people (cookies).
- Amir takes off. Marco's move, land, stop, emergency and Emergency land are refused, and so are takeoff and land from the other laptop.
- Amir lands. The other laptop's takeoff moves the drone over in 2.4 s: the drone saw `streamoff` from the first laptop, nothing more from it, then `command`, `sn?`, `streamon` and `takeoff` from the second.
- That pilot's page went silent, and the server landed the drone after about 16 s.

A live session needs the real drones, a key and the microphone, and is not covered by the tests.

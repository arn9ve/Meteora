# metoera-sim

Simulated Tellos flying in the event venue or in a scan of a real room, for metoera-voice, metoera-vision and metoera-redzone to use instead of real drones and phones.

- **Step 1, the room:** scan a room with a phone, load it on the GPU, fly a virtual drone through it, and align it with the real room (level floor, takeoff pad at the origin, real metres).
- **Step 2, the drones:** simulated Tellos answer the SDK on UDP, send telemetry, and stream their camera as H.264. Each is a box the size of a real Tello plus a margin, so a move into a wall it cannot see is refused.
- **Step 3, the venue:** the Capannone Gragnani, built from the floor plan metoera-voice flies by, with the Room panel's tables, people who walk and red-zone phones. Rehearsals run the voice page itself, with Grok, against it. Everything on the `approach` branch can be tried here: approach, find, describe, explore, localize, calibrate, the decision layer's go_to, pad_hop, dispatch and the red-zone auto-send.

Runs on **Windows with an NVIDIA GPU** (gsplat needs CUDA; it does not run on a Mac). Tested on an RTX 4050 Laptop GPU (6 GB): a 960×720 view renders in about 2 ms, and two drones stream at 30 fps each.

## Setup (once)

From this folder, with [uv](https://docs.astral.sh/uv/):

```bash
uv venv --python 3.10 .venv
uv pip install --python .venv/Scripts/python.exe torch==2.4.1 --index-url https://download.pytorch.org/whl/cu124
uv pip install --python .venv/Scripts/python.exe torchvision==0.19.1 --index-url https://download.pytorch.org/whl/cu124
uv pip install --python .venv/Scripts/python.exe -r requirements.txt
.venv/Scripts/python -m metoera_sim.check
```

About 6 GB on disk. The check confirms CUDA, gsplat and the rendering. It renders a small synthetic room to `renders/check.png`, and writes a practice scene to `scenes/demo/`. That scene is saved crooked on purpose, like a phone scan. Running the check again rewrites `scenes/demo/` and deletes its `scene.json`.

The tests need no GPU: `.venv/Scripts/python -m pytest tests`.

## Scan a room (phone, about 20 minutes)

1. Install **Scaniverse** (free; it processes on the phone).
2. **Prepare the room:**
   - Even light, nobody walking through.
   - Put two mission pads where they will be when flying, and tape-measure the distance between their centres.
3. **Scan in Splat mode:**
   - Walk slowly round the room, holding the phone between 0.5 and 1.8 m high (where the drone flies).
   - Cover every wall, the floor and the pads.
   - 2–4 minutes is enough for one room.
4. **Export as PLY** (not SPZ). Copy it to `scenes/<room>/scene.ply`, for example `scenes/practice/scene.ply`.

Scans stay out of git (`scenes/` is ignored).

## Align it with the real room (the viewer)

```bash
.venv/Scripts/python -m metoera_sim.viewer scenes/practice --pad-distance 2.40
```

`--pad-distance` is your tape measure, in metres. Try it first on `scenes/demo` with `--pad-distance 2.236`: its green pad is the takeoff spot and its magenta pad is the second one.

| Key | |
| --- | --- |
| `w` `s` / `a` `d` / `r` `f` | forward / back, left / right, up / down 20 cm (capitals: 5 cm) |
| `q` `e` | turn left / right 15° (capitals: 5°) |
| `t` | top view on/off: from 1.5 m above the drone, with everything more than 10 cm above it cut away (no ceiling). The drone is drawn to scale: white is its body, yellow the margin kept clear |
| `i` `k` | tilt the camera |
| `g`, then click the floor | levels the floor and puts it at height 0 |
| `o`, then click the takeoff pad | makes it (0, 0, 0). The heading you face becomes +x, the takeoff direction |
| `1` / `2`, then click pad A / pad B | sets the scale from `--pad-distance` |
| `x` `y` `z` | turn the whole scan 90° about that axis, if it starts sideways (`--up` sets the first guess, `y` by default) |
| `m`, then 1–8, then click a mission pad | where that numbered pad lies (lay every pad with its rocket towards +x). The drones use them to find their position |
| `[` `]` | select the previous / next place (top view; see "Places" below) |
| `c` / Backspace / `n` | confirm / delete / rename the selected place (type, then Enter; Esc cancels) |
| `p` | save `scene.json` next to the scan, and the room map `room.json` |
| `h` | help on screen |
| `Esc` | quit |

**Order:**
1. `g` on the floor.
2. Face the way the drone will take off, then `o` on the takeoff pad.
3. `t` for the top view, then `1` and `2` on the pads.
4. `p` to save.

After that, every tool works in the same world frame: metres, z up, the takeoff pad at (0, 0, 0), x the takeoff heading, y to its left. Yaw is counterclockwise, so the Tello's `cw` turns are negative.

A move that would run the drone into the scan shows `blocked: ...` at the top. The viewer moves anyway, since it is a free camera for aligning.

## Places and the room map

```bash
.venv/Scripts/python -m metoera_sim.places scenes/practice
```

YOLO (the same model the drones use) looks at the scan from viewpoints all over the room. The views are taken every 75 cm, at 0.6, 1.0 and 1.4 m high, facing 8 ways. Each object it finds is placed in 3D from the depth.

**What counts as a place:**
- An object must be seen from at least 3 spots, and in at least 30 % of the views that could see it. A shelf taken for a fridge once, at 22 %, doesn't survive.
- People and animals are never places: they move.

**Checking them in the viewer:** in the top view, `[` `]` go through the places, `c` confirms one, Backspace deletes it and `n` renames it ("tv" to "big tv"). Running `places` again keeps what you confirmed, renamed or deleted.

**The room map:** `p` in the viewer, or `python -m metoera_sim.room scenes/practice`, writes `room.json` next to the scan. It holds:
- the solid part of the scan, in 5 cm voxels with where their points sit;
- the mission pads;
- the places.

It's a few hundred kB. metoera-voice loads it (`METOERA_ROOM`) to guard real and simulated flights, track positions and fly `go_to`; see its README.

**The synthetic room** has two posters (Ultralytics' sample photos): people on the far wall, and a bus on a board. That gives YOLO something real to find:

```bash
.venv/Scripts/python -m metoera_sim.places synthetic -o scenes/synthetic/room.json   # finds the bus
```

## Fly in the venue (step 3)

Five terminals, all on this laptop:

```bash
# 1. The drones, people and phones in the venue
.venv/Scripts/python -m metoera_sim.serve venue

# 2. metoera-vision on the simulator's port (its own venv; see its README)
cd ../metoera-vision
.venv/Scripts/python -m metoera_vision --port 18800 --drones tello=127.0.0.1:50001,rmtt=127.0.0.1:50002

# 3. metoera-redzone, which the simulated phones talk to (console: http://127.0.0.1:18801/console)
cd ../metoera-redzone
node --env-file=../metoera-sim/sim.env server.mjs

# 4. metoera-voice (page: http://localhost:18797)
cd ../metoera-voice
node --env-file=../metoera-sim/sim.env server.ts

# 5. A rehearsal, or talk to the page
node --env-file=../metoera-sim/sim.env tools/rehearse.mjs "decolla black e vai al tavolo 1" --then "atterra black"
```

Your own voice server (18787), vision (18790) and red zone (18791) keep running. What the simulator's voice server learns and records goes to `voice-data/` (`METOERA_DATA_DIR`), and the red zone's events to `redzone-data/`. Neither goes next to the real setup's files. This matters most for `.odometry.json`: Black's learned telemetry reading.

**The venue** (`venue.py`) is built from `metoera-voice/room/capannone-gragnani.json`:
- **Walls and structure:** white walls up to the 4.3 m ceiling, the 4 concrete pillars, and the mezzanines' undersides.
- **Furniture:** what the Room panel placed in `voice-data/.room.json`. Tables are a wooden top on legs, 75 cm high unless given.
- **Mission pads:** pad 1 under Black's spot, pad 2 two metres ahead of it (Masoud's pad hop).

The first run copies `venue/room.json` there:
- six tables;
- Black on pad 1, facing pad 2;
- Red on table 3, to take off from a table;
- phone 1 on the right wall over the entrance, and phone 2 on the top wall;
- the red zone "Entrance".

Changes made on the Room panel are followed while it runs: furniture is rebuilt, and a landed drone moved on the plan is carried there.

**People** (`venue/people.json`, or `--people FILE`):
- **Their pictures:** people cut out of Ultralytics' sample photos, 1.7 m tall, always facing the camera that looks at them. YOLO and Grok vision see a person, wearing what the photo shows.
- **The defaults:**
  - a man in a beige coat stands ahead of Black;
  - a man in a dark coat and red shirt walks a loop through the Entrance from 15 s.
- **What the drones can hit:** a person is a 0.25 m-radius cylinder in the drones' checks. A move into one is refused like a move into a wall ("person 70 cm ahead", logged as `would_hit`).
- **People walking into a hovering drone:** only logged (`near_person` under 30 cm). That is an accepted risk.

**Phones:** every phone placed on the Room panel (position, height, tilt, lens) is simulated in its slot. Like the phone page, it:
- renders its view and runs YOLO for people;
- posts the boxes to the red zone, where the voice server puts them on the plan and raises an event when someone enters a red zone drawn there;
- posts an intrusion after about a second inside its own red zone (drawn on the console);
- obeys watch, arm, lens and sensitivity from the console.

They start watching at once: `--phones-idle` waits for the console, and `--no-phones` leaves them out.

**Rehearsals:** `metoera-voice/tools/rehearse.mjs` runs the voice page itself (`public/app.js`) in Node, with a stand-in for the browser. Grok gets the page's own instructions and tools, and its calls go through the page's dispatch, drone queues, nearest-drone dispatch and red-zone auto-send. Only the speech is replaced by text.

Options:
- `--then "<line>"` sends the next line once all is quiet;
- `--wait S` keeps watching, e.g. for the walker to reach the Entrance;
- `--autosend` turns on the page's "send the nearest drone";
- also `--quiet S`, `--pilot NAME` and `--verbose`.

The report lists:
- the commands and results;
- the decision layer's steps;
- would-hits (moves the simulator refused because nothing on the voice server stopped them);
- people within 30 cm;
- the smallest clearances;
- drones left flying.

It exits 1 on a would-hit or a drone left flying, and it refuses to run against 18787.

## Fly in a scan (step 2)

The same drones in an aligned scan, or in the install check's synthetic room. There is no venue, no people and no phones there.

```bash
# 1. The drones, in an aligned scan (or "synthetic" for the check's room)
.venv/Scripts/python -m metoera_sim.serve scenes/practice

# 2. metoera-vision (its own venv; see its README)
cd ../metoera-vision
.venv/Scripts/python -m metoera_vision --port 18800 --drones tello=127.0.0.1:50001,rmtt=127.0.0.1:50002

# 3. metoera-voice, with the simulator's settings
cd ../metoera-voice
node --env-file=../metoera-sim/sim.env server.ts
```

Then open http://localhost:18797 and fly Black (`tello`) and Red (`rmtt`) as usual. The simulator prints every command, reply and blocked move. `--drones tello` runs only one.

**Ports.** [`sim.env`](sim.env) points the voice server at the simulated drones. Every port it uses differs from the real setup, so the real `.env.tello` stays untouched and a voice server for the real drones can run on the same laptop:

| | Real drones | Simulator |
| --- | --- | --- |
| Voice page | 18787 | 18797 |
| Replies, telemetry (on the laptop) | 8889, 8890 | 8879, 8880 (Black), 8881 (Red) |
| Drone commands | 8889 on each drone | 9001 (Black), 9002 (Red) on 127.0.0.1 |
| Announcements between laptops | 18789 | 18799, so teammates never see the simulated drones |
| Video to metoera-vision | 11111 | 11111, from 50001 (Black) and 50002 (Red) |
| metoera-vision | 18790 | 18800 |
| metoera-redzone | 18791, phones 18792 | 18801, 18802 |
| Data (`.room.json`, `.odometry.json`, `flights/`) | metoera-voice/ | metoera-sim/voice-data/ |

The simulated drones listen on 127.0.0.1 only, and their serials are `SIMTELLO0001` and `SIMRMTT00002`. In the venue they start where the Room panel placed them, else at `TELLO_START` / `RMTT_START` from `sim.env`. In a scan, Black starts on the takeoff pad facing +x, and Red on pad B, or 1 m to the left if the scan has no pad B.

`tools/test-flight.mjs` works too. It expects replies on 8889, so start the simulator with `--reply-port 8889 --drones tello`, then from metoera-voice: `TELLO_PORT=9001 TELLO_EXPECT_SERIAL=SIMTELLO0001 node tools/test-flight.mjs 127.0.0.1`.

### The drone's size and its blind spots

The drone is a box: Ryze's 98 × 92.5 × 41 mm for the Tello EDU (TLW004), plus **5 cm on every side** (`--margin`). The margin covers the propeller guards and the error in the scan. Ryze's size does not seem to include the guards.

The camera only looks ahead, but the simulator knows the whole room. Before every move, turn, flip or takeoff it slides the box along the path. If the scan is in the way, the drone stays put and answers, for example:

```
error blocked: obstacle 15 cm to the right: at most 10 cm
```

The voice server shows that as "Drone rejected move: ...". A real Tello would fly into the wall. Land and emergency are never refused.

### How the simulated Tello behaves

- It ignores everything until `command`, then answers `sn?`, `battery?`, `speed?` and the other queries.
- Moves fly at the set speed (`speed`, 100 cm/s to start) and answer `ok` when they arrive. Takeoff climbs to 80 cm, and land comes down onto whatever is underneath, a table or the floor.
- `stop` hovers at once; the move it cancels never answers. Another motion command during a move gets `error busy`.
- With no command for 15 s it lands by itself, like the real one. The voice server's `battery?` keeps it up.
- The battery drains while flying, about 13 minutes from 100 %. Below 5 % it lands by itself.
- Telemetry is in the Tello EDU's format at 10 Hz:
  - `h` is the height above the takeoff spot, and `tof` the distance down to the floor or the table below.
  - `yaw` is clockwise from where the IMU was switched on. By default that is a random heading (seeded), as when a drone is switched on and then put on its spot; `--imu-zero-at-start` makes it the start heading.
  - Ground speed (`vgx vgy vgz`) is sent the way metoera-voice measured the real Tello EDU: compass axes, reversed, 12.2 cm/s per unit. `calibrate` on the voice page finds exactly that.
- `go x y z speed` flies a straight line in the drone's frame, checked like the moves. `go x y z speed mN` flies to a point in pad N's frame while the drone sees that pad; that is how `pad_hop` centres over a pad.
- `--imu-errors P`: a move answers `error No valid imu` with probability P, half the time after moving anyway (as on 5 Nov).
- Video is 960×720 at 30 fps, raw H.264 in 1460-byte datagrams, with a keyframe every second.
- **Drift:** moves come out a little off, as a real Tello's do. A move is off by up to ±3 % of its length and a turn by up to ±2 % of its angle (`--drift`, `--seed`). A hovering drone slides slowly, under 2 cm/s, too slow for its telemetry to show. Telemetry tells the truth.
- **Mission pads** come from the viewer (`m`). The synthetic room has pad 1 at the takeoff spot and pad 2 under Red; the venue has pad 1 under Black and pad 2 two metres ahead.
  - After `mon`, while the drone is 0.3 to 1.2 m above a pad and within 30 cm of it, telemetry carries `mid`, `x y z` from the pad, and `mpry`.
  - The axes and signs follow "rocket towards +x". They still need checking on a real drone.
- **Flight log:** every run writes `runs/<date-time>.jsonl` with:
  - commands and replies;
  - "would_hit", the moves the simulator itself refused, meaning nothing on the voice server stopped them;
  - "near_person", a person within 30 cm of a flying drone;
  - five times a second, each drone's pose and clearance (the distance from its body to the room around and above it, and to the nearest person).

  metoera-voice's `tools/rehearse.mjs` reads it.

## Render one view

```bash
.venv/Scripts/python -m metoera_sim.render scenes/practice --x 1.5 --y 0 --z 0.8 --yaw 90 -o renders/view.jpg
```

`--x --y --z` place the drone's body. The picture is taken from its camera, 4.5 cm ahead, at the nose.

## Code

| File | |
| --- | --- |
| `metoera_sim/scene.py` | Load and save a splat `.ply` (the standard 3DGS layout Scaniverse exports), and the alignment transforms and `scene.json` |
| `metoera_sim/camera.py` | The Tello's camera: 960×720, its field of view, the drone pose and Tello-style moves |
| `metoera_sim/drone.py` | The drone's size, its camera at the nose, and what it would hit in the scan |
| `metoera_sim/render.py` | gsplat rendering of colour, optionally with depth (used to click points) or as YUV for the video |
| `metoera_sim/viewer.py` | Fly-through and alignment |
| `metoera_sim/tello.py` | The simulated Tello's SDK: answers, timings, telemetry (no GPU, no network) |
| `metoera_sim/video.py` | H.264 encoding and 1460-byte datagrams |
| `metoera_sim/serve.py` | The simulated drones on UDP; the venue, people and phones |
| `metoera_sim/venue.py` | The venue from metoera-voice's floor plan and the Room panel's `.room.json` |
| `metoera_sim/people.py` | People who stand and walk: billboard photos, paths, what the drones can hit |
| `metoera_sim/phones.py` | Red-zone phones: render, YOLO, and the phone page's calls to metoera-redzone |
| `venue/room.json`, `venue/people.json` | The venue's first tables, drone spots, phones and zone; who walks where |
| `metoera_sim/places.py` | Named places found by YOLO in renders of the scan |
| `metoera_sim/room.py` | The room map (`room.json`) for metoera-voice |
| `metoera_sim/check.py` | Install check, synthetic room (with the YOLO posters), practice scene |
| `sim.env` | The simulator's settings for metoera-voice, metoera-redzone and rehearsals |
| `tests/` | The obstacle check, the SDK (go, ground speed, drift, mission pads), the venue, people, phones and video. Mostly on the CPU; the tests that render need CUDA |

## Known limits

- **The venue is a drawing, not a scan.** It has walls, pillars, mezzanines and the Room panel's tables, and nothing else in the hall (chairs, bags, cables, lights). A real scan of the venue would replace it.
- **People are flat photos facing the camera,** with no shadows. They walk set paths and do not react to the drones.
- **Phones use YOLO,** not the phone page's COCO-SSD, so what they detect may differ a little.

- **Camera width:** DJI's quoted 82.6° is used as the diagonal field of view (70° horizontally). It is not yet checked against a real Tello frame; calibrate it before trusting distances seen in the simulator.
- **Colour:** only the base colour of each Gaussian is kept, with no view-dependent shine. It saves memory and survives the alignment rotation.
- **A scan is frozen in time:** whatever moved during it is blurry. Only the venue has people who move.
- **The drones neither see nor block each other,** here or in metoera-voice's guards. Each one sees only the scan. A `go_to` can end right above the other drone's pad.
- **The margin is a guess** until a drone with guards on is measured. The RoboMaster TT uses the same box; its expansion board makes it taller, which the margin covers.
- **Timings are estimates:** the default speed, the turn rate (90°/s) and the takeoff and landing times. Check them against a real Tello (`speed?`, and time a takeoff, a `forward 100` and a `cw 90`).
- **What counts as solid:** the centres of Gaussians with opacity of at least 0.3, with at least 5 in the way. A big, sparse Gaussian may let the box through; a cluster of floaters may block it.
- **No physics:** no wind or bumping (drift is only the moves coming out off). Flips take 1.5 s and need 30 cm of room on that side; `rc` is ignored.
- **Places and the room map** (`places.py`, `room.py`, `room.json`) were made for the guided-flight branch's guards. That branch's voice side is parked, so metoera-voice on `approach` does not read `room.json`.
- **Places only cover what YOLO knows** (the 80 COCO classes: tv, couch, chair, bed, potted plant...). A real scan's renders are less sharp than a camera, so check the list in the viewer.

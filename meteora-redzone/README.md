# Meteora Red Zone (detector phones + Mac console)

Up to **three phones** act as person detectors. Each phone runs **TensorFlow.js COCO-SSD** (`mobilenet_v2`) in the browser and reports the people it sees. The **Mac console** shows all three phones (snapshots and status) and can start or stop them, change the lens and set ARM remotely.

`meteora-voice` reads the phones every second. A person seen by a phone triggers the red zone that phone watches on the room plan, and the nearest drone flies into that zone. See the [top-level README](../README.md) and [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md).

- Portrait **and** landscape.
- Back lenses only: **Wide / Normal / Tele** (no selfie camera).
- ARM is **on** by default (`REDZONE_ARM_DEFAULT=0` starts the phones disarmed).
- A separate server from `meteora-voice`: it never talks to the drones.

## Quick start

Requires Node.js 20 or later. No dependencies to install.

```bash
cd meteora-redzone
npm start
```

| Surface | URL |
| --- | --- |
| Mac console | http://127.0.0.1:18791/console |
| Phone 1 | `https://<laptop IP>:18792/?key=…&slot=1` |
| Phone 2 | `…&slot=2` |
| Phone 3 | `…&slot=3` |

The server prints the full phone links. The key is in `.phone/key.txt` (git-ignored); delete the folder to get a new one. The phone certificate is self-signed: accept it on the phone the first time.

The Mac console shows each phone as MJPEG at about 4 fps (small JPEGs) plus its status. The phone itself keeps a continuous live `<video>`.

Detection: COCO-SSD `mobilenet_v2`. The default sensitivity is 35, which means a minimum score of about 0.65. A person must stay in the phone's ROI for about 1 s before the phone raises its own alert. Separately, the phone posts every person box it sees, at most twice a second; that is what `meteora-voice` uses.

## Safety

| Control | Default | Behaviour |
| --- | --- | --- |
| ARM | **ON** (`REDZONE_ARM_DEFAULT`) | An intrusion is logged with "the voice server sends the nearest drone" |
| ARM OFF | set from the console or the phone | An intrusion is logged and alerted on the phone only |
| Phone (re)join | | the phone's ARM goes back to the default |

Note: `meteora-voice` decides on its own whether to send a drone, from the person boxes. The switch that stops it is **auto-send** on the `meteora-voice` page. The ARM state here only changes what `meteora-redzone` logs (and, with `PAD_NAV=1`, whether the old pad mission starts). Some log lines and code comments in `server.mjs` still say "ARM defaults OFF"; the code defaults to on.

## Pad nav (old mission, off by default)

This was the first demo, before the room plan existed: six physical space pads stand for room positions (`pads/refs/`, config `pad-nav.json`). It runs only with `PAD_NAV=1`.

With phone **slot 1** seeing a person for the dwell time and **ARM on**, Black flies `pad-01 (home) → straight ahead to the next mission pad (pad-02, about 2 m) → Grok describes the scene → waits`. It does not land by itself. Voice commands after the wait: **return to home and land**, or **go to the first point and wait**.

- Redzone only **triggers**. `meteora-voice` (a named pilot with the page open) **claims and flies** the mission, so the return commands work.
- The path (move + describe) runs when `pad-nav.json` `missions.cam1.executePath` is true (it is in this repository) or `PAD_NAV_EXECUTE_PATH=1`.
- Offline pad recognition demo: `python tools/pad_recognize.py --self-test` (in a venv with `pip install -r tools/requirements-pad.txt`).

## APIs (summary)

- `GET /api/slots`, `GET /api/stream` (server-sent events), `GET /api/events`, `GET /api/health`, `GET /api/pad-nav` (config + live `state`)
- `POST /api/slots/:id/join | leave | heartbeat | people | preview | intrusion | command`
- `GET /api/slots/:id/preview.jpg`, `GET /api/slots/:id/preview.mjpeg`
- `POST /api/arm`, `POST /api/pad-nav/claim`, `POST /api/pad-nav/phase`, `POST /api/pad-nav/command`

Port 18791 is plain HTTP on all interfaces with no key, so anyone on the local network can open the console. Port 18792 (phones) needs the key.

Optional environment variables (in `.env`, git-ignored): `REDZONE_ARM_DEFAULT`, `PAD_NAV`, `REDZONE_PORT`, `REDZONE_PHONE_PORT`, `METEORA_VOICE_URL`, `REDZONE_WEBHOOK_URL`, `REDZONE_DEBOUNCE_MS` (default 8000), `PAD_NAV_EXECUTE_PATH`, `PAD_NAV_DIRECT=1` (skips the voice page claim; tests only), `PHONE_ACCESS=off`.

## Tests

```bash
npm test
```

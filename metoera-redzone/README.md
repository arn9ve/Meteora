# Metoera Red Zone (multi-phone + Mac console)

Up to **three phones** as red-zone cameras for Track D. Each phone runs **TensorFlow.js COCO-SSD** (`lite_mobilenet_v2`) and alerts only when a **person** enters its ROI. The **Mac console** oversees all three (snapshots + remote Start/Stop/lens/ARM).

- Portrait **and** landscape.
- Back lenses only: **Wide / Normal / Tele** (no selfie).
- **ARM** takeoff default **OFF**.
- Separate from `metoera-voice` (no PR #6 conflict).

## Quick start

```bash
cd ~/Documents/METEORA/Metoera/metoera-redzone
npm start
```

| Surface | URL |
| --- | --- |
| Mac console | http://127.0.0.1:18791/console |
| Phone 1 | `https://<LAN>:18792/?key=…&slot=1` |
| Phone 2 | `…&slot=2` |
| Phone 3 | `…&slot=3` |

Mac oversight uses **MJPEG ~4 fps** (small JPEGs) + status. Phone keeps continuous live `<video>`. Detection: COCO-SSD `mobilenet_v2`, default sensitivity 35 (~0.65 score), **~1 s dwell** in zone before alert.

## Safety

| Control | Default | Behavior |
| --- | --- | --- |
| ARM | **OFF** | Log + phone alert only |
| ARM ON | explicit (console or phone) | Mission / takeoff hook to voice/webhook |
| Restart | — | All slots disarm |

## Pad nav (cam1 → Black)

No LiDAR. Six physical space pads = room positions (`pads/refs/`, config `pad-nav.json`).

**Supervised test (MET-10):** Phone **slot 1** person+dwell with **ARM ON** triggers  
`Black: pad-01 (home) → pad-02 (2.0 m forward) → Grok describe → wait` (no auto-land).  
Voice commands after wait: **return to home and land** or **go to first point and wait**.

- Takeoff still requires ARM.
- Redzone only **triggers**; **metoera-voice** (named pilot, page open) **claims and flies** so return commands work.
- Path (move + describe) stays **off** until `pad-nav.json` `missions.cam1.executePath` is true or `PAD_NAV_EXECUTE_PATH=1` (distance configured: **200 cm**).
- Offline pad ID demo: `python tools/pad_recognize.py --self-test` (venv with opencv-python + numpy).

## Sensors (compass / tilt; not Safari LiDAR)

Slot phones (Masoud): **1 = iPhone 12 Pro Max**, **2 = iPhone 13 Pro Max**, **3 = iPhone 15 Pro** — LiDAR in hardware, **not** readable from Safari like ARKit. Phone page **Enable sensors** → DeviceOrientation / `webkitCompassHeading` on heartbeats; person yaw+distance estimates on `POST …/people`. Persisted in `data/slot-sensors.json`. Mac console shows compass/tilt. Room (`metoera-voice`) can use live tilt + estimate distance. True depth needs a native/AR companion or WebXR depth where supported.

## APIs (summary)

- `GET /api/slots`, `GET /api/stream` (SSE), `GET /api/pad-nav` (config + live `state`)
- `POST /api/pad-nav/claim`, `POST /api/pad-nav/phase`, `POST /api/pad-nav/command`
- `POST /api/slots/:id/join|heartbeat|preview|people|intrusion|command` (heartbeat may include `sensors`; people may include `estimates`)
- `GET /api/slots/:id/preview.jpg`

Optional env: `REDZONE_PORT`, `REDZONE_PHONE_PORT`, `METOERA_VOICE_URL`, `REDZONE_WEBHOOK_URL`, `REDZONE_DEBOUNCE_MS`, `PAD_NAV_EXECUTE_PATH`, `PAD_NAV_DIRECT=1` (skip voice-UI claim; tests only), `PHONE_ACCESS=off`.

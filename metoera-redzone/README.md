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

**First demo:** Phone **slot 1** person+dwell intrusion with **ARM ON** emits mission  
`Black: takeoff home (pad-01 / P1) → go to target (pad-02 / P2)`.

- Takeoff still requires ARM.
- Path moves after takeoff stay **off** until `pad-nav.json` `missions.cam1.executePath` is true (or `PAD_NAV_EXECUTE_PATH=1`) and distances are measured.
- Offline pad ID demo: `python tools/pad_recognize.py --self-test` (venv with opencv-python + numpy).

## APIs (summary)

- `GET /api/slots`, `GET /api/stream` (SSE), `GET /api/pad-nav`
- `POST /api/slots/:id/join|heartbeat|preview|intrusion|command`
- `GET /api/slots/:id/preview.jpg`

Optional env: `REDZONE_PORT`, `REDZONE_PHONE_PORT`, `METOERA_VOICE_URL`, `REDZONE_WEBHOOK_URL`, `REDZONE_DEBOUNCE_MS`, `PAD_NAV_EXECUTE_PATH`, `PHONE_ACCESS=off`.

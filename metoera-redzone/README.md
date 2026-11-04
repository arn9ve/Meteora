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

Mac oversight uses **JPEG snapshots (~1–2s)** + status, not full live video (keeps LAN/CPU usable). Detection stays on-device.

## Safety

| Control | Default | Behavior |
| --- | --- | --- |
| ARM | **OFF** | Log + phone alert only |
| ARM ON | explicit (console or phone) | Takeoff hook to voice/webhook |
| Restart | — | All slots disarm |

## APIs (summary)

- `GET /api/slots`, `GET /api/stream` (SSE)
- `POST /api/slots/:id/join|heartbeat|preview|intrusion|command`
- `GET /api/slots/:id/preview.jpg`

Optional env: `REDZONE_PORT`, `REDZONE_PHONE_PORT`, `METOERA_VOICE_URL`, `REDZONE_WEBHOOK_URL`, `REDZONE_DEBOUNCE_MS`, `PHONE_ACCESS=off`.

# Metoera Red Zone (iPhone camera)

Phone-usable red-zone camera for Track D: point an **iPhone 12** at a restricted area, draw a red ROI, and when motion appears inside it the page **alerts** and posts an event. Optional **drone takeoff** only runs when **ARM** is ON (default **OFF**).

This is a **separate** small service (`metoera-redzone/`). It does not edit `metoera-voice` hot files.

## Quick start (Mac)

```bash
cd ~/Documents/METEORA/Metoera/metoera-redzone
npm start
```

Terminal prints:

- Mac: `http://127.0.0.1:18791/`
- iPhone (same Wi‑Fi): `https://<LAN-IP>:18792/?key=…`

## iPhone 12

1. Mac and iPhone on the same Wi‑Fi.
2. Open the **HTTPS** link from the Mac terminal in Safari.
3. Trust the self-signed cert once (Advanced → Proceed).
4. Allow camera.
5. Drag a **red zone** on the preview → **Start watching**.
6. Leave **ARM** off for dry runs. Flip ARM on only with a human next to the drone.

Full walkthrough: Project doc `docs/iphone-redzone-camera.md`.

## Safety

| Control | Default | Behavior |
| --- | --- | --- |
| ARM switch | **OFF** | Intrusions are logged + phone alert only |
| ARM ON | explicit | Also calls takeoff hook (voice `/api/command` takeoff and/or webhook) |
| Process restart | — | ARM always resets to **OFF** |
| Debounce | 8 s | Continuous motion does not spam the backend |

## Env (optional)

Copy ideas into a local `.env` (git-ignored):

| Var | Default | Meaning |
| --- | --- | --- |
| `REDZONE_PORT` | `18791` | HTTP bind |
| `REDZONE_PHONE_PORT` | `18792` | HTTPS for phone |
| `METOERA_VOICE_URL` | `http://127.0.0.1:18787` | Takeoff target when armed |
| `REDZONE_WEBHOOK_URL` | empty | Extra POST on armed intrusion |
| `REDZONE_DEBOUNCE_MS` | `8000` | Server debounce |
| `PHONE_ACCESS` | on | Set `off` to disable HTTPS |

## Event log

JSONL at `data/events.jsonl` (git-ignored). Also `GET /api/events`.

## APIs

- `GET /api/health` — service info
- `GET /api/state` — `{ armed, … }`
- `POST /api/arm` — `{ armed: true|false }`
- `POST /api/intrusion` — motion / test event
- `GET /api/events?limit=50`

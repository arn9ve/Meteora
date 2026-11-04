# Metoera — share pack: Tello STA Wi‑Fi (internet + control)

For the team: how to put the **Tello EDU** on the same Wi‑Fi as the laptop (`hackathon` / `hackathon`) so you keep **internet (Grok)** and **drone control + video**.

This pack **does not replace** `metoera-link` or `metoera-voice` in the GitHub repo. It only adds Station-mode setup.

## What’s inside

| File | Purpose |
|------|---------|
| `drone/CONNECT_WIFI.md` | Full checklist (with / without Ethernet) |
| `drone/README.md` | Short overview + verified notes |
| `drone/set_sta_mode.py` | Join Edu to `hackathon` (`ap` command) |
| `drone/find_tello.py` | Find drone IP after STA |
| `drone/live_video.py` | Confirm video stream on LAN IP |
| `drone/.env.example` | `STA_SSID` / `TELLO_IP` template |
| `drone/requirements.txt` | Python deps |

## Quick start (Mac)

```bash
cd drone
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env

# 1) Mac Wi-Fi → TELLO-XXXXXX  (internet drops briefly)
python set_sta_mode.py
# 2) Wait 30–60s, Mac Wi-Fi → hackathon
python find_tello.py
# 3) Put TELLO_IP=... into .env
python live_video.py   # optional; press q to quit
```

## Verified at hackathon

- STA reply: `OK,drone will reboot in 3s`
- Found Edu at **`192.168.5.137`** (DHCP — yours may differ)
- Video on STA: frame `(720, 960, 3)` OK

## GitHub note

Preferred: merge branch `cursor/drone-sta-wifi-066d` as a PR into `arn9ve/Metoera` without editing `metoera-voice` / `metoera-link`. Until that lands, share this folder/zip with the team.

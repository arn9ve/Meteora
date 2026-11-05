# Metoera share pack: drones on the shared Wi-Fi (station mode)

How to put the **Tello EDU** and the **RoboMaster TT** on the same Wi-Fi as the laptop (`<venue Wi-Fi>` / `<password>`), so the laptop keeps **internet (Grok)** and still has **drone control and video**.

This folder adds the station-mode (STA) setup next to `metoera-link` and `metoera-voice`.

## What's inside

| File | Purpose |
|------|---------|
| `CHEATSHEET.md` | The steps on one screen |
| `drone/CONNECT_WIFI.md` | Full checklist (with or without Ethernet) |
| `drone/README.md` | Short overview and verified notes |
| `drone/set_sta_mode.py` | Asks for the network name and password, then sends `ap` |
| `drone/find_tello.py` | Finds the drone's IP after it joins the network |
| `drone/live_video.py` | Confirms the video stream on the LAN IP |
| `drone/.env.example` | `TELLO_IP` template |
| `drone/requirements.txt` | Python dependencies |

## Quick start (Mac)

```bash
cd drone
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env

# 1) Wi-Fi → TELLO-XXXXXX or RMTT-XXXXXX (internet drops briefly)
python set_sta_mode.py   # asks for the network name and password
# 2) Wait 30–60 s, then join that same Wi-Fi (<venue Wi-Fi>)
python find_tello.py
# 3) Put TELLO_IP=... into .env
python live_video.py     # optional; press q to quit
```

On the RoboMaster TT, also move the expansion-board switch to router mode.

## Tests

```bash
cd drone
python -m unittest test_set_sta_mode.py
```

## Verified at the venue

- Station-mode reply: `OK,drone will reboot in 3s`
- Found the Tello EDU at `192.168.5.137` (DHCP; yours may differ)
- Video in station mode: frame `(720, 960, 3)` OK

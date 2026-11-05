# Drone Wi-Fi: station mode (internet + control)

`meteora-link` talks to the drone on the drone's **own** access point (`TELLO-XXXXXX` / `RMTT-XXXXXX` at `192.168.10.1`). That link has **no internet**, so Grok API calls fail.

This folder puts the drone into **station (STA) mode**, so it joins the same LAN as the laptop (for example `<venue Wi-Fi>` / `<password>`). Then you keep **internet, SDK control and video**.

It does **not** replace `meteora-link`. Use `meteora-link` for ground checks on the drone's access point; use these scripts for station mode on the shared Wi-Fi.

## Quick path (no Ethernet)

1. Join `TELLO-XXXXXX` (internet drops briefly; that is fine).
2. `python set_sta_mode.py` asks for the network name and password, then the drone reboots onto that network. `--ssid`, `--password` and `--yes` skip the prompts.
3. Join that same Wi-Fi on this computer.
4. `python find_tello.py` → set `TELLO_IP` in `.env`.
5. Optional: `python live_video.py` to confirm video in station mode.

Full checklist: [CONNECT_WIFI.md](CONNECT_WIFI.md).

## Setup

```sh
cd drone
python3 -m venv venv
source venv/bin/activate   # Windows: venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env
```

The script asks for the network name and password. It does not read them from `.env`. `.env` only records `TELLO_IP` (and optionally `LOCAL_SUBNET`) after the drone has joined the network.

```sh
python -m unittest test_set_sta_mode.py
```

## Verified at the venue

After station mode, one session found the Tello EDU at `192.168.5.137` (DHCP; your IP may differ). Battery and `streamon` video (frame `(720, 960, 3)`) worked on that IP.

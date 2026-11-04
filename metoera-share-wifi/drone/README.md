# Drone Wi‑Fi: Station mode (internet + control)

`metoera-link` talks to the aircraft on its **own** AP (`TELLO-…` / `RMTT-…` at `192.168.10.1`). That link has **no internet**, so Grok API calls fail.

This folder puts the Tello EDU into **Station (STA) mode** so it joins the same LAN as the laptop (e.g. `hackathon` / `hackathon`). Then you keep **internet + SDK control + video**.

It does **not** replace `metoera-link`. Use link for AP ground checks; use these scripts for STA / shared Wi‑Fi.

## Quick path (no Ethernet)

1. Join `TELLO-…` (internet drops briefly — OK).
2. `python set_sta_mode.py` asks for the SSID and password, then the aircraft reboots onto that network. This lab is `hackathon` / `hackathon`. `--ssid`, `--password`, and `--yes` skip the prompts.
3. Join that same Wi‑Fi on this computer.
4. `python find_tello.py` → set `TELLO_IP` in `.env`.
5. Optional: `python live_video.py` to confirm video on STA.

Full checklist: [CONNECT_WIFI.md](CONNECT_WIFI.md).

## Setup

```sh
cd drone
python3 -m venv venv
source venv/bin/activate   # Windows: venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env
```

The script asks for the SSID and password. It does not read them from `.env`. `.env.example` only records `TELLO_IP` after the aircraft has joined the network.

```sh
python -m unittest test_set_sta_mode.py
```

## Verified (hackathon LAN)

After STA, one successful session found the Edu at **`192.168.5.137`** (DHCP — your IP may differ). Battery + `streamon` video frame `(720, 960, 3)` worked on that STA IP.

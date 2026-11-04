# Connect Tello + laptop Wi‑Fi at the same time

Goal: Mac and Tello both on **`hackathon` / `hackathon`**, so you keep **internet (Grok)** and **drone control** (and video).

Related: [`metoera-link`](../metoera-link) is the AP-mode ground check / UDP driver (`TELLO-…` at `192.168.10.1`). It does **not** send `ap`. This guide is the STA step that puts the Edu on the shared LAN.

## Important facts

- A **USB cable does not put Tello EDU on Wi‑Fi**. USB is basically **charging** (flight SDK stays on Wi‑Fi).
- You configure STA mode **once** by briefly talking to the drone’s own AP (`TELLO-XXXXXX`), then both join `hackathon`.
- STA does **not** disable video: after `streamon`, frames still come from the LAN IP (confirmed on hackathon Wi‑Fi).

## Best method (keep internet while configuring)

If you have an **Ethernet cable** to the router/switch:

1. Plug Mac into Ethernet → internet stays up.
2. Mac **Wi‑Fi** → join `TELLO-XXXXXX` (drone hotspot).
3. On the Mac, in this folder:

   ```bash
   cd drone
   python3 -m venv venv && source venv/bin/activate
   pip install -r requirements.txt
   cp -n .env.example .env   # STA_SSID/PASSWORD already hackathon
   python set_sta_mode.py
   ```

4. Wait **30–60s** for the drone to reboot onto `hackathon`.
5. Mac Wi‑Fi → join **`hackathon`** (Ethernet can stay connected).
6. Find the drone:

   ```bash
   python find_tello.py
   # if needed:
   # LOCAL_SUBNET=192.168.x.0/24 python find_tello.py
   ```

   Or check the router’s DHCP client list for a new device.
7. Put the IP in `.env`:

   ```env
   TELLO_IP=192.168.x.x
   ```

8. Test:

   ```bash
   python -c "from djitellopy import Tello; t=Tello('YOUR_IP'); t.connect(); print('battery', t.get_battery()); t.end()"
   ```

Now Mac is on `hackathon` (internet + drone). Grok API and Tello work together.

## Method without Ethernet

Same steps, but during step 2–3 the Mac has **no internet** (only `TELLO-…`). That is fine — `set_sta_mode.py` does not need Grok. After step 5 you get internet back.

## If STA fails / drone “disappears”

- SSID/password must match exactly: `hackathon` / `hackathon` (case-sensitive).
- 2.4 GHz Wi‑Fi (Tello does not do 5 GHz).
- Factory-reset Tello to bring back `TELLO-XXXXXX` AP (check your EDU manual: usually power on + hold button ~5s until LEDs change), then retry STA.

## After you’re connected

```bash
python main.py --text          # real drone + Grok
# or
python main.py --text --dry-run
```

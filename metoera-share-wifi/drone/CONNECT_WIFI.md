# Connect the drone and the laptop to the same Wi-Fi

Goal: the Mac and the drone both on **`<venue Wi-Fi>`**, so you keep **internet (Grok)** and **drone control** (and video).

Related: [`metoera-link`](../../metoera-link) is the ground check and UDP driver on the drone's own access point (`TELLO-XXXXXX` at `192.168.10.1`). It does **not** send `ap`. This guide is the station-mode step that puts the drone on the shared LAN.

## Important facts

- A **USB cable does not put the Tello EDU on Wi-Fi**. USB only charges it; the flight SDK works over Wi-Fi.
- You set station mode **once**, by briefly joining the drone's own access point (`TELLO-XXXXXX`). Then both the Mac and the drone join `<venue Wi-Fi>`.
- Station mode does **not** turn off video: after `streamon`, frames still come from the drone's LAN IP (confirmed at the venue).

## Best method (keep internet while configuring)

If you have an **Ethernet cable** to the router or switch:

1. Plug the Mac into Ethernet, so internet stays up.
2. Mac **Wi-Fi** → join `TELLO-XXXXXX` (the drone's hotspot).
3. On the Mac, in this folder:

   ```bash
   cd drone
   python3 -m venv venv && source venv/bin/activate
   pip install -r requirements.txt
   cp -n .env.example .env
   python set_sta_mode.py   # type the network name and password
   ```

4. Wait **30–60 s** for the drone to reboot onto the Wi-Fi you entered.
5. Wi-Fi → join the network you entered (`<venue Wi-Fi>`). Ethernet can stay connected.
6. Find the drone:

   ```bash
   python find_tello.py
   # if needed:
   # LOCAL_SUBNET=192.168.x.0/24 python find_tello.py
   ```

   Or look for a new device in the router's DHCP client list.
7. Put the IP in `.env`:

   ```env
   TELLO_IP=192.168.x.x
   ```

8. Test:

   ```bash
   python -c "from djitellopy import Tello; t=Tello('YOUR_IP'); t.connect(); print('battery', t.get_battery()); t.end()"
   ```

Now the Mac is on `<venue Wi-Fi>` with internet and the drone. Grok and the drone work together.

## Method without Ethernet

The same steps, but during steps 2–3 the Mac has **no internet** (it is only on `TELLO-XXXXXX`). That is fine: `set_sta_mode.py` does not need Grok. After step 5 internet comes back.

## If station mode fails or the drone "disappears"

- The network name and password must match exactly (case-sensitive) and contain no spaces.
- The Wi-Fi must be 2.4 GHz WPA2-Personal (the Tello does not do 5 GHz).
- Reset the drone to bring back its `TELLO-XXXXXX` access point: power on and hold the power button about 5 s, until the light flashes yellow. Then try station mode again.

## After you're connected

Put the drone's IP and serial in `metoera-voice/.env.tello` (`TELLO_IP` / `TELLO_SETUP_SERIAL`, or `RMTT_IP` / `RMTT_SETUP_SERIAL`) and start `metoera-voice` (see its [README](../../metoera-voice/README.md)).

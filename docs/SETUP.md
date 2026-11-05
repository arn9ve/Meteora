# Setup in detail

The short version is in the [README](../README.md#set-up-a-venue). This page has everything: requirements, ports, each service, environment variables and the files that stay on the laptop.

## Requirements

- macOS. Start the servers from the macOS Terminal app, which has Local Network access.
- Node.js 24.12 or later for `meteora-voice` (it runs `server.ts` directly). Node.js 20 is enough for `meteora-redzone` and `meteora-link`.
- Python 3.13 for `meteora-vision`, Python 3 for `meteora-share-wifi`.
- An xAI API key.
- A 2.4 GHz WPA2-Personal Wi-Fi network for the drones, the laptop and the phones. The network name and password must not contain spaces.

## Ports

| Port | Protocol | Service | Who connects |
| --- | --- | --- | --- |
| 8889 / 8890 | UDP | drones | `meteora-voice` sends commands to 8889 and gets telemetry on 8890 |
| 11111 | UDP | `meteora-vision` | the drones send video here |
| 18786 | HTTP | `meteora-voice` | certificate page, opened once per phone |
| 18787 | HTTP | `meteora-voice` | control page, this laptop only |
| 18788 | HTTPS | `meteora-voice` | pilot page on a phone (needs the access key) |
| 18789 | UDP | `meteora-voice` | the other laptops (who holds which drone) |
| 18790 | HTTP | `meteora-vision` | `meteora-voice`, this laptop only |
| 18791 | HTTP | `meteora-redzone` | Mac console and `meteora-voice` |
| 18792 | HTTPS | `meteora-redzone` | detector phones (need the access key) |

## 1. Put the drones on the shared Wi-Fi

Do this once per drone, or again after a reset. The full steps are in [meteora-share-wifi](../meteora-share-wifi).

1. Turn on a drone. On the RoboMaster TT, set the expansion board switch to router mode.
2. Join the laptop to the drone's own access point (`TELLO-XXXXXX` or `RMTT-XXXXXX`). The drone is at `192.168.10.1`.
3. Create the Python environment and send the command:

   ```sh
   cd meteora-share-wifi/drone
   python3 -m venv venv
   source venv/bin/activate
   pip install -r requirements.txt
   cp .env.example .env
   python set_sta_mode.py
   ```

   The script asks for the network name and password, shows them, and sends `ap` after you type `y`. The drone restarts on the shared network. Wait 30 to 60 seconds.
4. Join the laptop to the same Wi-Fi and run `python find_tello.py`. If it finds nothing, set `LOCAL_SUBNET` in `.env` (for example `192.168.5.0/24`) and try again.
5. Write down the IP. Repeat for the other drone, leaving the first one on.

To get the drone's own access point back, turn it on and hold the power button for 5 seconds, until the light flashes yellow.

A VPN that routes `192.168.10.1` blocks the link. If the firewall asks, allow incoming UDP on 8890 and 11111.

Quick link check (nothing takes off):

```sh
node meteora-link/connect.mjs --host <drone IP> --local <laptop IP>
node meteora-link/internet.mjs
```

## 2. meteora-voice

```sh
cd meteora-voice
cp .env.example .env              # then add the xAI key
cp .env.tello.example .env.tello  # then the IP and serial of each drone
npm install
npm start
```

`npm install` only downloads TypeScript and the Node types, for `npm run typecheck`. The server runs without a build.

On start, the server prints:

- `http://localhost:18787`: the control page, on this laptop only.
- `https://<laptop IP>:18788/?key=<key>`: the same page for a phone on the same Wi-Fi. The key is in `meteora-voice/.phone/key.txt`. Do not share it.
- `http://<laptop IP>:18786/`: the certificate page. Open it once on each phone, download `meteora-ca.cer` and install it. On iPhone, also turn it on in Settings → General → About → Certificate Trust Settings.

Close the scripts in `meteora-voice/tools/` first: the server needs UDP 8889, 8890 and 18789. Ctrl+C lands the drones that are flying and hands them over to the other laptops.

Details: [meteora-voice/README.md](../meteora-voice/README.md). Notes on the Tello link: [meteora-voice/TELLO.md](../meteora-voice/TELLO.md).

## 3. meteora-vision

```sh
cd meteora-vision
python3.13 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m meteora_vision --drones tello=<TELLO_IP>,rmtt=<RMTT_IP>
```

Use the same IPs as in `.env.tello`. The service sends nothing to the drones. It only listens for video on UDP 11111 and separates the two streams by sender address. Video arrives after `meteora-voice` has sent `streamon`.

The YOLO weights (`yolo11n.pt`) download on first start. The depth model (Depth Anything V2 Metric Indoor, from Hugging Face) loads in the background at start; `--no-depth` turns it off. Annotated view of one drone: `http://127.0.0.1:18790/stream?drone=tello`.

## 4. meteora-redzone

```sh
cd meteora-redzone
npm start
```

There are no dependencies to install. The server prints the Mac console (`http://127.0.0.1:18791/console`) and one link per phone: `https://<laptop IP>:18792/?key=<key>&slot=1` (also `slot=2` and `slot=3`). The key is in `meteora-redzone/.phone/key.txt`. The certificate is self-signed, so accept it on the phone the first time.

## 5. Environment variables

The values live in `meteora-voice/.env`, `meteora-voice/.env.tello` and `meteora-redzone/.env`. All three are git-ignored. The examples are `.env.example` and `.env.tello.example`. Only the names are listed here; never write values into tracked files.

**meteora-voice, `.env`**

| Variable | Use |
| --- | --- |
| `XAI_API_KEY` | xAI key (required) |
| `DECISION_MODE` | `0` turns off Grok decisions during missions (on by default) |
| `DECISION_MODEL`, `VISION_LLM_MODEL` | Grok models for decisions and for vision |
| `CAMERA_ALWAYS_ON` | `1` keeps the video on all the time. By default it turns on only when needed, to save battery |
| `VISION_URL` | address of `meteora-vision` (default `http://127.0.0.1:18790`) |
| `REDZONE_URL`, `REDZONE_PHONE_PORT` | address of `meteora-redzone`, and the port of its phones |
| `ROOM_PLAN` | another room plan (default `room/capannone-gragnani.json`) |
| `PHONE_ACCESS`, `PHONE_PORT`, `PHONE_CERT_PORT` | `PHONE_ACCESS=off` turns off phone access; the other two change ports 18788 and 18786 |
| `PAD_HOP_MAX_CM` | longest hop between mission pads |

**meteora-voice, `.env.tello`**

| Variable | Use |
| --- | --- |
| `TELLO_IP`, `TELLO_SETUP_SERIAL` | IP and serial of Black (the serial as the drone reports it with `sn?`) |
| `RMTT_IP`, `RMTT_SETUP_SERIAL` | IP and serial of Red |
| `TELLO_SETUP_SSID`, `TELLO_SETUP_PASSWORD` | the shared network, for the setup scripts |
| `TELLO_MAX_MOVE_CM` | longest single move (default 100) |
| `TELLO_START`, `RMTT_START` | start point `x,y,heading` when the drone is not placed on the plan |
| `METEORA_CLIENT_NAME`, `METEORA_PEERS`, `METEORA_CLAIMS_PORT` | several laptops: the name the others see, direct IPs when the Wi-Fi blocks broadcasts, the announcement port |

**meteora-redzone, `.env`**

| Variable | Use |
| --- | --- |
| `REDZONE_ARM_DEFAULT` | `0` starts the phones disarmed (armed by default) |
| `PAD_NAV` | `1` turns the old pad-to-pad mission back on (off by default) |
| `REDZONE_PORT`, `REDZONE_PHONE_PORT` | ports 18791 and 18792 |
| `METEORA_VOICE_URL` | address of `meteora-voice` (default `http://127.0.0.1:18787`) |
| `REDZONE_WEBHOOK_URL`, `REDZONE_DEBOUNCE_MS` | optional webhook, and the shortest time between two alarms of one phone |
| `PAD_NAV_EXECUTE_PATH`, `PAD_NAV_DIRECT` | only for testing the pad mission |
| `PHONE_ACCESS` | `off` turns off phone access |

`meteora-vision` takes the same options on the command line or as `METEORA_VISION_*` variables (port, model, device, fps, depth model). See its README.

## 6. Local files (git-ignored)

These files stay on the laptop and are never committed:

| File | Contents |
| --- | --- |
| `meteora-voice/.env`, `meteora-voice/.env.tello` | xAI key, drone IPs and serials |
| `meteora-voice/.phone/`, `meteora-redzone/.phone/` | phone access key and certificates. Delete the folder to make a new key |
| `meteora-voice/.room.json` | where the drones, phones, tables and red zones are, as set on the page |
| `meteora-voice/.redzone-zones.json` | red zones (ignored for safety; the current zones are in `.room.json`) |
| `meteora-voice/.odometry.json` | telemetry calibration learned in flight |
| `meteora-voice/photos/` | photos taken by voice |
| `meteora-voice/flights/` | flight logs and calibration reports |
| `meteora-redzone/.env`, `meteora-redzone/data/` | redzone settings and its local event log |

## Step by step in the venue

1. **Network.** Drones on the shared Wi-Fi; laptop and phones on the same network. Each drone needs at least 20% battery; takeoff is refused below that.
2. **Start.** Three terminals:
   - `meteora-vision`: `.venv/bin/python -m meteora_vision --drones tello=<TELLO_IP>,rmtt=<RMTT_IP>`
   - `meteora-redzone`: `npm start`
   - `meteora-voice`: `npm start`
3. **Page.** Open `http://localhost:18787`, type your name and start the voice. The pilot of a drone is whoever takes off with it. On the pilot's phone, use the `https://<IP>:18788/?key=<key>` link the server printed.
4. **Detector phones.** The Phones tab lists the `https://<IP>:18792/?key=<key>&slot=N` links. Open them on the phones and put the phones in place. On the plan, mark where each phone stands, where it faces and which zone it watches, or calibrate it with 4 clicks on the plan.
5. **Drones on the plan.** In the Room tab, put each drone on its start point and confirm which way its camera faces. Without this, the drone refuses to fly to a point in the room.
6. **Calibration.** On the first flight in the venue, run the calibration test from a table, then measure where the drone landed and type it in. Run the preflight before a mission.
7. **Red zones.** Draw the zones on the plan. With auto-send on (the default), a person seen in a zone sends the nearest drone, which flies in, looks around and reports.


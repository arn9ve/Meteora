# Metoera

Setup for the Tello Edu and the RoboMaster TT (Tello Talent). These steps put each aircraft on a shared Wi-Fi network, then run the Node link in [metoera-link](metoera-link). The link reads telemetry. The propellers stay stopped.

You need:

- Node.js 20 or newer
- Python 3
- A 2.4 GHz WPA2-Personal network. The SSID and password cannot contain spaces. This lab uses `hackathon` / `hackathon`.

One radio joins only one aircraft access point at a time. A USB cable charges the aircraft and leaves the Wi-Fi setup to the steps below. Disconnect a VPN that routes `192.168.10.1`. Allow inbound UDP `8890` if the firewall asks.

## 1. Join each aircraft to Wi-Fi

Power on one aircraft. On the Talent, set the expansion-board switch to router mode. Join its access point:

- Tello Edu: `TELLO-...`
- RoboMaster TT, with the expansion board on: `RMTT-...`

The aircraft is at `192.168.10.1`. From the repository root, create the Python environment once.

Windows:

```sh
cd metoera-share-wifi/drone
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
copy .env.example .env
python set_sta_mode.py
```

macOS:

```sh
cd metoera-share-wifi/drone
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
python set_sta_mode.py
```

The script asks for the SSID and password, prints the SSID, and sends `ap` after you type `y`. `--ssid`, `--password`, and `--yes` skip those prompts. The aircraft reboots off its own access point. Wait 30–60 seconds.

Join that same Wi-Fi on this computer, then find the aircraft:

```sh
python find_tello.py
```

Write the address it prints into `.env` as `TELLO_IP`, and keep a note of it. Each aircraft gets its own address. If the probe finds nothing, set `LOCAL_SUBNET` in `.env` to the router subnet, such as `192.168.5.0/24`, and run `find_tello.py` again.

Repeat from the access-point step for the other aircraft. Leave the first one powered on so it stays on the shared network.

To bring an aircraft access point back, power the aircraft on and hold the power button for 5 seconds. The light goes out, then flashes yellow. The factory network has no password.

More detail is in [metoera-share-wifi](metoera-share-wifi).

## 2. Run the link

The link has no install step. From the repository root, while this computer is joined to `TELLO-...` or `RMTT-...`:

```sh
node metoera-link/connect.mjs
```

A successful run prints the model, SDK version, serial, battery, and a few state samples. `hardware: TELLO` is the Edu, or a Talent whose expansion board is off. `hardware: RMTT` means the Talent expansion board is on this link.

After the aircraft is on the shared Wi-Fi, stay on that network. Pass the aircraft address from `find_tello.py` and this computer's address on that network:

```sh
node metoera-link/connect.mjs --host 192.168.x.x --local 192.168.x.y
```

`--host` is the aircraft. `--local` is this computer. On the aircraft access point, the local address is `192.168.10.x` and `--local` can be omitted.

Check that this computer can reach the public internet:

```sh
node metoera-link/internet.mjs
```

`internet: yes` means the TLS handshake succeeded. The `aircraft` line in that report is the direct access point at `192.168.10.1`. On the shared network, `connect.mjs --host` is the aircraft check.

From the repository root:

```sh
node --test metoera-link/tello-link.test.mjs metoera-link/internet.test.mjs
```

From `metoera-share-wifi/drone`:

```sh
python -m unittest test_set_sta_mode.py
```

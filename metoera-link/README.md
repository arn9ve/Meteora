# Metoera link

One UDP driver for the Tello Edu (TLW004) and the RoboMaster TT (Tello Talent). Both aircraft speak the Tello text SDK. `connect.mjs` only connects and reads telemetry. It does not take off, and it does not send `ap`.

## Before you run it

Power on one aircraft and join its Wi-Fi:

- Tello Edu: `TELLO-...`
- RoboMaster TT, with the expansion board on: `RMTT-...`

Both use `192.168.10.1`. One radio can join only one of those networks at a time. Disconnect a VPN that routes that address. Allow inbound UDP `8890` if the firewall asks.

## Ground check

Requires Node.js 20 or newer. From the repository root:

```sh
node metoera-link/connect.mjs
```

A successful run prints the model, SDK version, serial, battery, and a few state samples. The propellers stay stopped. Run it once while joined to the Edu, then once while joined to the Talent.

`hardware: TELLO` is the Edu, or a Talent whose expansion board is off. `hardware: RMTT` means the Talent expansion board is on this link. Older Edu firmware that rejects `hardware?` still links and is reported as `tello-edu` with `hardware: unknown`. Flight commands from SDK 2.0 are the shared set, so that firmware can still be flown later.

If the PC is not on an aircraft network, the check tells you to join `TELLO-...` or `RMTT-...` and stops. `--host` and `--local` override the drone address and the local adapter. The defaults are `192.168.10.1` and the local `192.168.10.x` address.

## Internet

The aircraft cannot reach the public internet. The SDK has no DNS, HTTP, or gateway query. `wifi?` returns only the signal-to-noise ratio. Direct mode puts this PC on `TELLO-...` or `RMTT-...`, and that adapter has no route past the aircraft, so the voice app cannot reach the internet through it. One radio can join only one aircraft.

From the repository root:

```sh
node metoera-link/internet.mjs
```

The check prints two independent facts and does not send `ap`:

```text
internet: yes
aircraft: no
```

`internet` is whether this PC can finish a TLS handshake with the public internet. `aircraft` is whether an aircraft answers the same `command` handshake as the ground check. One can succeed while the other fails. This is not a GUI connection API.

Station mode is a separate, sticky change. `ap <ssid> <password>` makes the Edu or the Talent reboot off `192.168.10.1` and take an address from a router. The PC can then stay on that router, keep its own internet connection, and command the aircraft on the LAN. The aircraft itself still does not open an internet connection. The SSID and password cannot contain spaces, and the network has to be 2.4 GHz WPA2-Personal. On the Talent, the expansion-board switch also has to be in router mode. `ap?` only echoes a stored router name and password on that controller. Hold the aircraft power button for 5 seconds to return to the factory access point: the light goes out, then flashes yellow, and the network has no password. This repository does not send `ap`.

## Driver

`TelloLink` in `tello-link.mjs` enters SDK mode with `command`, then reads `sdk?`, `sn?`, `battery?`, and `hardware?`. It does not send `ap`. State arrives on UDP `8890`. The driver sends one command at a time and, while idle, asks for the battery every few seconds so a later flight is not ended by the aircraft's 15 second command timeout. `takeoff`, `land`, `move`, `rotate`, and `emergency` share that command path. The ground check does not call them. Video port `11111` stays closed.

## Tests

From the repository root:

```sh
node --test metoera-link/tello-link.test.mjs metoera-link/internet.test.mjs
```

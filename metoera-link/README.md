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

## Driver

`TelloLink` in `tello-link.mjs` enters SDK mode with `command`, then reads `sdk?`, `sn?`, `battery?`, and `hardware?`. State arrives on UDP `8890`. The driver sends one command at a time and, while idle, asks for the battery every few seconds so a later flight is not ended by the aircraft's 15 second command timeout. `takeoff`, `land`, `move`, `rotate`, and `emergency` share that command path. The ground check does not call them. Video port `11111` stays closed.

## Tests

From the repository root:

```sh
node --test metoera-link/tello-link.test.mjs
```

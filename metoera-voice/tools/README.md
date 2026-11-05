# metoera-voice tools

None of these are needed to run Metoera. They are the helpers used to build the venue plan and to check a drone that does not connect. All of them are safe: only `test-flight.mjs` makes a drone fly, and only with a person watching.

## Floor plan

| Tool | What it does |
| --- | --- |
| `step-to-plan.py` | Cuts the venue's 3D model (STEP file) horizontally and writes the walls as a floor plan (`floorplan.json` and `.svg`). This is how `room/capannone-gragnani.json` was made. |
| `apply-measurements.py` | Corrects that plan with sizes measured in the room (pillars, distances). |

A LiDAR scan from a phone will replace both (see the main README).

## Flight check

| Tool | What it does |
| --- | --- |
| `test-flight.mjs` | Takeoff, hover 5 s, land. Any key lands at once; `x` stops the motors. Run it with the drone in view. |

## Link diagnostics (only when a drone does not answer)

| Tool | What it does |
| --- | --- |
| `check-tello-lan.mjs` | Asks the drone on the venue Wi-Fi for battery, SDK version and serial. No flight commands. |
| `diagnose-tello.mjs`, `diagnose-tello.command` | Runs the read-only checks and saves a report (`.tello-diagnostics.json`). The `.command` file runs it with a double click on macOS. |
| `check-tello-python.py` | The same check from Python, to tell a Node.js problem from a network one. |
| `capture-tello.py`, `capture-tello.command` | Records which addresses and ports the drone uses, without sending anything. |
| `connect-tello.mjs` | Older way to put the Tello on the Wi-Fi from this folder. Prefer `metoera-share-wifi/drone/set_sta_mode.py`. |

Details on the Tello link: [../TELLO.md](../TELLO.md).

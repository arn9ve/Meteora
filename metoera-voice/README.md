# Metoera Voice

A Grok voice interface for two simulated drones (`drone-1`, `drone-2`) and, when configured, one real Tello EDU (`tello`).

The `tools` folder holds the scripts we used to put our Tello EDU on the shared network, diagnose its UDP link and run a supervised test flight. Read [TELLO.md](TELLO.md) first: the Tello sends every reply to local UDP port 8889, and a client on any other port gets no answer.

## Getting started

You need Node.js 24.12 or later, an active xAI API key, internet access, and a microphone. Install dependencies with `npm install` to run the type checker.

1. Copy `.env.example` to `.env` if `.env` does not already exist.
2. Open `.env` and add your key after `XAI_API_KEY=`. Do not share it in chat. The `.env` file is excluded from Git.
3. In the project directory, run `npm install`, then `npm start`.
4. Open http://localhost:18787, click “Tap to speak,” and allow microphone access. Try: “Drone 1, take off, move forward 50 centimeters, and land.”
5. Open “Drones” to see the state of both virtual drones. Stop the server with Ctrl+C.

The key remains on the local server. The browser receives only a temporary token to connect to Grok. If you add a key to `.env` while the server is running without one, it will be read the next time you start voice mode. To replace a key already loaded by the server, restart it.

## Simulation

The server starts Drone 1 and Drone 2 connected and on the ground. Their initial positions are (-1, 0, 0) and (1, 0, 0) meters. +Y is forward when a drone is facing 0°, +X is right, and +Z is up. Horizontal movements are relative to the drone's heading. Commands are instantaneous, and coordinates represent a virtual environment, not measurements from a real drone. Restart the server to reset the simulation.

Grok asks which drone to use when one has not been specified. The `takeoff`, `land`, `move`, and `rotate` commands are validated on the server, sent to the specified drone, and returned to Grok with the result. The UI polls `GET /api/drones`; `POST /api/command` accepts structured commands with `droneId` and `action`. The service listens only on localhost and checks the origin of POST requests.

## Real Tello

Set `TELLO_IP` (for example `TELLO_IP=192.168.5.137`) and `TELLO_SETUP_SERIAL` in `.env.tello` (see `.env.tello.example`), then start the server from macOS Terminal. The server owns UDP 8889 and 8890, so stop the scripts in `tools/` first.

What the server does for `droneId: "tello"` (`src/tello.ts`):

- On the first command it sends `command` and checks `sn?` against `TELLO_SETUP_SERIAL`. A mismatch refuses every action.
- `takeoff` needs at least 20% battery. `move` is capped at 100 cm. `land`, `rotate` as in the simulator.
- While connected it sends `battery?` every 5 s, so the Tello does not land itself after 15 s of silence.
- Ctrl+C on the server lands the Tello before exiting.
- `GET /api/drones` returns the real drone under `real` (battery, height, heading, last error); the Drones panel shows it as "Tello · real".

Grok is told that `tello` is physical: it asks you to confirm the area is clear before the first takeoff and lands at once if you say stop. Those are prompt instructions, not hard guarantees. There is no voice emergency stop: keep someone next to the drone, and stop the server with Ctrl+C to land it.

## Connecting the team's controller

`src/simulator.ts` defines the `snapshot()` and `execute(command)` contract. Connecting the Python controller will require a server adapter that preserves the meaning of these results, forwards commands to the controller, and returns real status and measurements. Agree on the protocol, identifiers, coordinate system, units, timing, and error handling with the team. The real controller must enforce its own checks and must not treat simulated coordinates as measurements. The browser and Grok must not bypass the controller.

## Verification

Run `npm run typecheck` to check TypeScript types and `npm test` to verify drone isolation, command sequences, rotations, invalid commands, and voice UI state transitions. A live Grok session requires a valid key and microphone permission; the simulator tests do not verify it automatically.

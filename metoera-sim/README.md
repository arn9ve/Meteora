# metoera-sim

The room as a Gaussian splat, seen through a simulated Tello's camera. This is step 1 of the simulator: scan a room with a phone, load it on the GPU, fly a virtual drone through it, and align it with the real room (level floor, takeoff pad at the origin, real metres). The simulated Tello that answers the SDK and streams this camera to metoera-vision comes next.

Runs on **Windows with an NVIDIA GPU** (gsplat needs CUDA; it does not run on a Mac). Tested on an RTX 4050 Laptop GPU (6 GB): a 960×720 view renders in about 2 ms.

## Setup (once)

From this folder, with [uv](https://docs.astral.sh/uv/):

```bash
uv venv --python 3.10 .venv
uv pip install --python .venv/Scripts/python.exe torch==2.4.1 --index-url https://download.pytorch.org/whl/cu124
uv pip install --python .venv/Scripts/python.exe -r requirements.txt
.venv/Scripts/python -m metoera_sim.check
```

About 6 GB on disk. The check confirms CUDA, gsplat and the rendering. It renders a small synthetic room to `renders/check.png`, and writes a practice scene to `scenes/demo/`. That scene is saved crooked on purpose, like a phone scan.

## Scan a room (phone, about 20 minutes)

1. Install **Scaniverse** (free; it processes on the phone).
2. **Prepare the room:**
   - Even light, nobody walking through.
   - Put two mission pads where they will be when flying, and tape-measure the distance between their centres.
3. **Scan in Splat mode:**
   - Walk slowly round the room, holding the phone between 0.5 and 1.8 m high (where the drone flies).
   - Cover every wall, the floor and the pads.
   - 2–4 minutes is enough for one room.
4. **Export as PLY** (not SPZ). Copy it to `scenes/<room>/scene.ply`, for example `scenes/practice/scene.ply`.

Scans stay out of git (`scenes/` is ignored).

## Align it with the real room (the viewer)

```bash
.venv/Scripts/python -m metoera_sim.viewer scenes/practice --pad-distance 2.40
```

`--pad-distance` is your tape measure, in metres. Try it first on `scenes/demo` with `--pad-distance 2.236`: its green pad is the takeoff spot and its magenta pad is the second one.

| Key | |
| --- | --- |
| `w` `s` / `a` `d` / `r` `f` | forward / back, left / right, up / down 20 cm (capitals: 5 cm) |
| `q` `e` | turn left / right 15° (capitals: 5°) |
| `t` | top-down view on/off; `i` `k` tilt the camera |
| `g`, then click the floor | levels the floor and puts it at height 0 |
| `o`, then click the takeoff pad | makes it (0, 0, 0). The heading you face becomes +x, the takeoff direction |
| `1` / `2`, then click pad A / pad B | sets the scale from `--pad-distance` |
| `x` `y` `z` | turn the whole scan 90° about that axis, if it starts sideways (`--up` sets the first guess, `y` by default) |
| `p` | save `scene.json` next to the scan |
| `h` | help on screen |
| `Esc` | quit |

**Order:**
1. `g` on the floor.
2. Face the way the drone will take off, then `o` on the takeoff pad.
3. `t` for the top view, then `1` and `2` on the pads.
4. `p` to save.

After that, every tool works in the same world frame: metres, z up, the takeoff pad at (0, 0, 0), x the takeoff heading, y to its left. Yaw is counterclockwise, so the Tello's `cw` turns are negative.

## Render one view

```bash
.venv/Scripts/python -m metoera_sim.render scenes/practice --x 1.5 --y 0 --z 0.8 --yaw 90 -o renders/view.jpg
```

## Code

| File | |
| --- | --- |
| `metoera_sim/scene.py` | Load and save a splat `.ply` (the standard 3DGS layout Scaniverse exports), and the alignment transforms and `scene.json` |
| `metoera_sim/camera.py` | The Tello's camera: 960×720, its field of view, the drone pose and Tello-style moves |
| `metoera_sim/render.py` | gsplat rendering of colour, optionally with depth (used to click points) |
| `metoera_sim/viewer.py` | Fly-through and alignment |
| `metoera_sim/check.py` | Install check, synthetic room, practice scene |

## Known limits

- **Camera width:** DJI's quoted 82.6° is used as the diagonal field of view (70° horizontally). It is not yet checked against a real Tello frame; calibrate it before trusting distances seen in the simulator.
- **Colour:** only the base colour of each Gaussian is kept, with no view-dependent shine. It saves memory and survives the alignment rotation.
- **A scan is frozen in time:** whatever moved during it is blurry, and nothing moves in the simulator.

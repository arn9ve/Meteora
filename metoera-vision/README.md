# metoera-vision

Object detection and metric depth for the Metoera project (voice control of two
drones: a Tello EDU and a RoboMaster TT). It receives each drone's live H.264
video, runs a small YOLO model on the newest frame a few times per second, and
serves the results over a local HTTP API that the voice side (metoera-voice /
Grok) can query: "is there a person?", "where is the bottle?", "how far is the
nearest thing ahead?".

**This service never talks to the drone.** It only binds UDP port 11111 and
receives video. It sends nothing on the Tello command port (8889). The
metoera-voice Node server owns that port and is the one that sends `command` and
`streamon`.

```
Tello EDU / RMTT ──UDP 11111 (raw H.264)──▶ metoera-vision ──HTTP :18790──▶ metoera-voice (Node, :18787)
    ▲                                                                       │
    └──────────────── UDP 8889: command / streamon / takeoff … ─────────────┘
```

## Setup

Requires macOS (Apple Silicon recommended) or Linux, Python 3.13 (tested), and `ffmpeg` on PATH (only for the sample/replay scripts).

```bash
cd metoera-vision
python3.13 -m venv .venv
.venv/bin/pip install -r requirements.txt
scripts/make_sample.sh          # optional: builds samples/sample.mp4 + sample.h264 for testing
```

The weights (`yolo11n.pt`, 5.6 MB) download automatically on first start
into `weights/`, from the official `ultralytics/assets` GitHub release. On Apple
Silicon the model runs on the GPU (`mps`). Elsewhere it falls back to `cpu`, or
`cuda:0` if available.

The depth model (`depth-anything/Depth-Anything-V2-Metric-Indoor-Small-hf`)
downloads from Hugging Face and loads in the background at start
(`metoera_vision/depth.py`). `--no-depth` turns it off, and `--depth-lazy` loads
it on the first `/depth` call instead.

Ultralytics' settings file lives in `./.ultralytics/` rather than your global
config dir. Its anonymous usage analytics (`sync`) is switched off.

## Run

```bash
# Drones (default source udp://0.0.0.0:11111). The drone list is required:
# every drone that got `streamon` sends to this port. Use the same IPs as .env.tello.
# Start metoera-voice first so it sends `command` + `streamon`.
.venv/bin/python -m metoera_vision --drones tello=192.168.5.137,rmtt=192.168.5.68

# A video or image file (loops, paced to real time)
.venv/bin/python -m metoera_vision --source samples/sample.mp4

# Webcam (dev). macOS will ask for camera permission for the terminal.
.venv/bin/python -m metoera_vision --source webcam:0

# Simulate one drone without a drone: replay a clip as raw H.264 in
# 1460-byte UDP datagrams to 127.0.0.1:11111 (run in a second terminal)
.venv/bin/python -m metoera_vision --drones tello=127.0.0.1
scripts/replay_udp.sh samples/sample.mp4
```

Then open http://127.0.0.1:18790/ for a live annotated view.

### Two drones at once (`--drones`)

Our two drones both push video to this Mac's UDP port 11111:

```bash
.venv/bin/python -m metoera_vision --drones tello=192.168.5.137,rmtt=192.168.5.68
```

`tello` is the Tello EDU at 192.168.5.137 and `rmtt` the RoboMaster TT at
192.168.5.68. One UDP socket on `0.0.0.0:11111` (the `--source` udp address)
receives every datagram. Each datagram is routed **by sender address** to that
drone's own H.264 parser/decoder, latest-frame buffer, stats and detection
result, so the two streams never mix. Datagrams from any other sender are
counted (`/health` → `source_stats.unknown_senders`) and dropped.

- Entry format: `id=ip` matches any source port from that IP. `id=ip:port`
  matches IP **and** source port, which lets one machine simulate two drones.
  Ids may use letters, digits, `-` and `_`.
- There is no default drone: `/detections`, `/find`, `/frame.jpg` and `/stream`
  need `?drone=<id>` and answer 400 without it.
- One YOLO model is shared. The detector serves the drones round-robin, always
  on each drone's newest frame, at up to `--detect-fps` **per drone** (5 by
  default, so about 10 inferences/s in total for two). If the model can't keep up,
  each drone gets an equal share.
- A `udp://` source without `--drones` is refused at start: the streams of
  several drones would mix in one decoder. File and webcam sources need no list.

Simulate both drones locally (no drone needed). The script replays
`samples/sample.h264` from two source ports to one receiver port:

```bash
.venv/bin/python -m metoera_vision --drones tello=127.0.0.1:50001,rmtt=127.0.0.1:50002
.venv/bin/python scripts/replay_udp_multi.py --from 127.0.0.1:50001 --from 127.0.0.1:50002 --to 127.0.0.1:11111
```

| Flag | Env var | Default |
|---|---|---|
| `--source` | `METOERA_VISION_SOURCE` | `udp://0.0.0.0:11111` (or a file path, or `webcam:N`) |
| `--drones` | `METOERA_VISION_DRONES` | required with a `udp://` source; `id=ip[:port],...`, e.g. `tello=192.168.5.137,rmtt=192.168.5.68` |
| `--host` / `--port` | `METOERA_VISION_HOST` / `_PORT` | `127.0.0.1` / `18790` |
| `--model` | `METOERA_VISION_MODEL` | `yolo11n.pt` (any Ultralytics detect model, e.g. `yolov8n.pt`, `yolo11s.pt`) |
| `--device` | `METOERA_VISION_DEVICE` | `auto` (mps, then cuda, then cpu) |
| `--detect-fps` | `METOERA_VISION_DETECT_FPS` | `5` |
| `--stream-fps` | `METOERA_VISION_STREAM_FPS` | `15` (MJPEG cap) |
| `--conf` | `METOERA_VISION_CONF` | `0.35` |
| `--imgsz` | `METOERA_VISION_IMGSZ` | `640` |
| `--classes` | `METOERA_VISION_CLASSES` | all 80 COCO classes; e.g. `person,bottle,cup` to keep only those |
| `--cors-origin` | `METOERA_VISION_CORS` | `http://localhost:18787,http://127.0.0.1:18787` (`*` for any) |
| `--no-depth` | | turn off `GET /depth` (it then answers 503) |
| `--depth-model` | `METOERA_VISION_DEPTH_MODEL` | `depth-anything/Depth-Anything-V2-Metric-Indoor-Small-hf` |
| `--depth-device` | `METOERA_VISION_DEPTH_DEVICE` | `auto` (mps, else cpu) |
| `--depth-lazy` | | load the depth model on the first `/depth` call |
| `--no-loop` | | play a file once |

## API

All responses are JSON unless noted, with `Cache-Control: no-store`. CORS is
allowed for the voice UI origin, and `OPTIONS` preflight is supported.

**Drones.** `/detections`, `/find`, `/frame.jpg`, `/stream` and `/depth` take
`?drone=<id>` (for example `/find?label=person&drone=rmtt` or
`/stream?drone=tello`). Without it they return
`400 {"error": "say which drone: add ?drone=<id>", "drones": ["tello", "rmtt"]}`.
Results from `/detections` and `/find` include `"drone": "<id>"`. An unknown id
returns `404 {"error": "unknown drone", "drone": "x", "drones": ["tello", "rmtt"]}`.
That is also what any `?drone=` returns for a file or webcam source. `/` shows
all the drones' streams side by side.

### `GET /health`
```json
{"ok": true, "source": "udp://0.0.0.0:11111", "fps_in": 30.0, "fps_detect": 4.9,
 "last_frame_age_ms": 10, "last_detection_age_ms": 120, "frame_size": [960, 720],
 "model": "yolo11n.pt", "device": "mps", "frames_dropped": 199, "detections_run": 40,
 "source_stats": {"kind": "udp", "packets": 4840, "frames_decoded": 240, "decode_errors": 0, ...},
 "error": null, "uptime_s": 9.1}
```
`ok` is true only when a frame arrived in the last 3 s and nothing is in an
error state. With no video (no `streamon` yet, or the drone is out of range),
`ok` is `false` and `last_frame_age_ms` is `null` or growing.

That shape is for a file or webcam source. With `--drones`, `/health` has one
entry per drone under `drones`, and the top-level `ok` is true only when
**every** drone is ok. No top-level field stands for one drone:
```json
{"ok": true, "source": "udp://0.0.0.0:11111", "model": "yolo11n.pt", "device": "mps", ...,
 "drones": {
   "tello": {"ok": true, "address": "192.168.5.137", "fps_in": 30.2, "fps_detect": 4.6,
             "last_frame_age_ms": 24, "last_detection_age_ms": 257, "frame_size": [960, 720],
             "frames_dropped": 173, "detections_run": 34, "decode_errors": 0, "packets": 723,
             "frames_decoded": 208, "error": null},
   "rmtt": {...}},
 "source_stats": {"kind": "udp-multi", "packets": 1277, "unknown_packets": 20,
                  "unknown_senders": {"192.168.5.99:11111": 20}, ...}}
```
`/health?drone=rmtt` returns just that drone's entry in flat form, plus `drone`,
`model`, `device` and so on.

### `GET /detections`
The latest result. Coordinates are normalized to 0–1 relative to the frame.
`box.x/y` is the top-left corner. Objects are sorted by confidence.
```json
{"timestamp": 1793801957.52, "frame_size": [960, 720], "frame_seq": 81, "inference_ms": 33.8, "age_ms": 234,
 "objects": [
   {"label": "person", "confidence": 0.9219,
    "box": {"x": 0.2118, "y": 0.2197, "w": 0.1928, "h": 0.78},
    "center": {"x": 0.3082, "y": 0.6097}}]}
```
Before the first detection: `{"timestamp": null, "frame_size": null, "objects": [], "status": "no detections yet"}`.
If the stream stops, the last result stays available. Check `age_ms`, because it
can be stale.

### `GET /find?label=person[&min_conf=0.5]`
Returns the best (highest-confidence) match for a COCO label, or `null`. The
label match ignores case. An exact match wins, then a substring match, so
`phone` finds `cell phone`.
```json
{"label": "person", "timestamp": 1793801957.72, "age_ms": 46,
 "match": {"label": "person", "confidence": 0.918, "box": {...}, "center": {"x": 0.31, "y": 0.61},
           "position": "left", "count": 2}}
```
`position` is a coarse 3×3 description (`left`, `center`, `upper right`,
`lower center`, ...) from the camera's point of view, ready to speak aloud.
`count` is how many objects matched. A missing `label` returns 400.

### `GET /frame.jpg`
The latest frame as a JPEG, with the latest boxes and labels drawn on it. Returns 503 until the first frame arrives.

### `GET /stream`
An MJPEG stream (`multipart/x-mixed-replace`) of annotated frames, up to
`--stream-fps`. It works directly in `<img src="http://127.0.0.1:18790/stream?drone=tello">`.

### `GET /depth`
Metric depth (metres) from Depth Anything V2 Metric Indoor, computed on the frame
of the newest YOLO result so boxes and depth match. The answer has the detected
`objects`, each with a `depth_m`, and a row of `columns` across the picture, each
with `x` (0–1), `bearing_deg` (0 straight ahead, positive to the right) and
`depth_m`. Results are cached briefly per drone. It answers 503 when depth is off
or no frame has arrived yet.

metoera-voice uses it before each leg of a mission (the nearest depth within ±12°
of straight ahead) and to estimate distances in `localize`, `find` and `explore`.

### `GET /`
A small debug page with the stream and live JSON.

## How it plugs into metoera-voice

1. Start metoera-vision with the same drones as `.env.tello`
   (`.venv/bin/python -m metoera_vision --drones tello=IP,rmtt=IP`). It starts listening on UDP 11111.
2. metoera-voice connects to each drone on 8889 and sends `command`, then
   `streamon`. Each drone then pushes video to the controlling computer's port
   11111, which is this service. Re-send `streamon` after a drone reboot or
   reconnect. If a stream stops, that drone's `/health` entry turns `ok: false`.
3. Each drone's `scan` and `look` tools read `/detections?drone=<id>` and return a
   short summary to Grok: "Yes, a person on the left (92%)." Reject results with
   a large `age_ms` (more than about 1500 ms) so Grok doesn't answer from stale video.
4. The voice UI shows each drone's video through the voice server's `/video/<id>`,
   which passes `/stream?drone=<id>` through.

Only one process can bind UDP 11111. Don't run another Tello video consumer
(an SDK `cv2.VideoCapture('udp://...')` or another copy of this service) at
the same time. For two drones, run one instance with `--drones`. Don't start two
instances.

## Tests

```bash
.venv/bin/python -m pytest -q                  # all, about 25 s once the weights are cached
.venv/bin/python -m pytest -q -m "not smoke"   # fast unit/API tests with a stubbed model
```
- `tests/test_detect.py`: JSON shape, normalization and clamping, sorting, `/find` matching rules, position text, annotation.
- `tests/test_frames_service.py`: the latest-frame buffer drops the backlog, and
  a slow detector fed 250 fast frames only ever sees recent frames, in order.
  It also runs the HTTP endpoints, CORS and preflight, MJPEG framing and the 400
  on a missing label, all against a stub model.
- `tests/test_multi_drone.py`: `--drones` parsing, routing by sender. Two
  sockets on 127.0.0.1 with different source ports send interleaved synthetic
  H.264 streams of different resolutions plus a stranger's junk, and each drone
  must decode its own size with 0 decode errors. Also covers the per-drone
  endpoints and `/health`, a 404 for an unknown drone on every endpoint, and the
  detection loop: strict round-robin when the model is the bottleneck, about
  `--detect-fps` per drone, an idle drone not slowing the other, and newest
  frame only.
- `tests/test_smoke_real.py`: the real YOLO model on Ultralytics' `bus.jpg`. It
  also runs a **real UDP ingest**: ffmpeg streams raw H.264 in 1460-byte
  datagrams, after some junk datagrams that imitate start-of-stream garbage. The
  test checks for 960×720 decode and a detected `person`. It also checks
  file-source pacing. The two-drone smoke test replays `samples/sample.h264`
  from two source ports to one port at the same time, using the real model,
  and checks both drones reach about 30 fps in, about 5 fps of detection, and
  get detections.

## Implementation notes

- **Decoding.** The Tello sends a bare H.264 Annex-B stream split across
  ~1460-byte UDP datagrams, with no RTP and no container. Each datagram goes
  into libavcodec's H.264 parser through PyAV (`CodecContext.parse`). The parser
  reassembles access units however they were split. Decode errors before the
  first SPS/PPS/IDR, or after packet loss, are counted and skipped, and frames
  are discarded until the first keyframe (with a 4 s grace fallback).
- **Real time.** Decoded frames go into a one-slot buffer that overwrites older
  frames (`frames_dropped` counts the overwritten ones). The detector wakes up at
  `--detect-fps`, takes the newest frame and never works through a queue.
- **HTTP.** Uses the stdlib `ThreadingHTTPServer`, with no web framework. It
  binds to `127.0.0.1` by default.

## Limitations

- **Two-drone routing is tested with simulated senders.** The automated tests
  use two senders on 127.0.0.1. Routing assumes each drone sends its video from
  its own IP. If both drones' traffic reaches the Mac through NAT behind one
  address, use `id=ip:port` entries.
- **The tests use local replays.** They use ffmpeg replays of H.264 over UDP to
  127.0.0.1:11111, a video file and still images. Real Tello streams can show
  more packet loss and smearing (grey or green artifacts) on weak Wi-Fi.
  Detections and depth on corrupted frames may be wrong.
- On macOS, the Python process needs **Local Network** permission to receive
  from the drone's LAN address. Allow it under System Settings → Privacy &
  Security → Local Network for the terminal or app that launches it. The Tello
  pushes video to whichever host sent `streamon`, so run this service on the
  same machine as metoera-voice.
- COCO's 80 classes only (person, bottle, cup, chair, dog, cell phone, ...). No tracking and no IDs across frames.
- Positions are 2-D image positions from the drone's camera. Distance comes only from `/depth`, an estimate from a single frame.
- `yolo11n` is tuned for speed: about 30 ms per frame on Apple Silicon MPS. Use
  `--model yolo11s.pt` for better accuracy at roughly 2–3× the cost.
- The Tello EDU forward camera only. The downward camera (`downvision`) isn't handled specially.

## Licence notes

- **Ultralytics YOLO (library and weights) is AGPL-3.0.** If you distribute this
  service, or offer it to others over a network, the AGPL obligations apply to
  the combined work (source availability). Commercial use without AGPL
  compliance requires an Ultralytics Enterprise licence. Personal or local use
  is fine.
- Hugging Face `transformers`: Apache-2.0. Check the depth model's licence on its Hugging Face page before redistributing it.
- PyAV: BSD-3-Clause; its wheels bundle FFmpeg libraries (FFmpeg is LGPL/GPL depending on build - check before redistributing). OpenCV: Apache-2.0. PyTorch: BSD-style.
- The sample clip is made from `bus.jpg` and `zidane.jpg`, which ship inside the
  Ultralytics package. It is generated locally and git-ignored.

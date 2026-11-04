# metoera-vision

Object detection for the Metoera project (voice control of a DJI/Ryze Tello EDU).
It receives the Tello's live H.264 video, runs a small YOLO model on the newest
frame a few times per second, and serves the results over a local HTTP API that
the voice side (metoera-voice / Grok) can query: "is there a person?", "where is
the bottle?".

**This service never talks to the drone.** It only binds UDP port 11111 and
receives video. It sends nothing on the Tello command port (8889). The
metoera-voice Node server owns that port and is the one that sends `command` and
`streamon`.

```
Tello EDU ──UDP 11111 (raw H.264)──▶ metoera-vision ──HTTP :18790──▶ metoera-voice (Node, :18787)
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

Ultralytics' settings file lives in `./.ultralytics/` rather than your global
config dir. Its anonymous usage analytics (`sync`) is switched off.

## Run

```bash
# Tello (default): listen on udp://0.0.0.0:11111.
# Start metoera-voice first so it sends `command` + `streamon`.
.venv/bin/python -m metoera_vision

# A video or image file (loops, paced to real time)
.venv/bin/python -m metoera_vision --source samples/sample.mp4

# Webcam (dev). macOS will ask for camera permission for the terminal.
.venv/bin/python -m metoera_vision --source webcam:0

# Simulate the Tello without a drone: replay a clip as raw H.264 in
# 1460-byte UDP datagrams to 127.0.0.1:11111 (run in a second terminal)
scripts/replay_udp.sh samples/sample.mp4
```

Then open http://127.0.0.1:18790/ for a live annotated view.

| Flag | Env var | Default |
|---|---|---|
| `--source` | `METOERA_VISION_SOURCE` | `udp://0.0.0.0:11111` (or a file path, or `webcam:N`) |
| `--host` / `--port` | `METOERA_VISION_HOST` / `_PORT` | `127.0.0.1` / `18790` |
| `--model` | `METOERA_VISION_MODEL` | `yolo11n.pt` (any Ultralytics detect model, e.g. `yolov8n.pt`, `yolo11s.pt`) |
| `--device` | `METOERA_VISION_DEVICE` | `auto` (mps, then cuda, then cpu) |
| `--detect-fps` | `METOERA_VISION_DETECT_FPS` | `5` |
| `--stream-fps` | `METOERA_VISION_STREAM_FPS` | `15` (MJPEG cap) |
| `--conf` | `METOERA_VISION_CONF` | `0.35` |
| `--imgsz` | `METOERA_VISION_IMGSZ` | `640` |
| `--classes` | `METOERA_VISION_CLASSES` | all 80 COCO classes; e.g. `person,bottle,cup` to keep only those |
| `--cors-origin` | `METOERA_VISION_CORS` | `http://localhost:18787,http://127.0.0.1:18787` (`*` for any) |
| `--no-loop` | | play a file once |

## API

All responses are JSON unless noted, with `Cache-Control: no-store`. CORS is
allowed for the voice UI origin, and `OPTIONS` preflight is supported.

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
`--stream-fps`. It works directly in `<img src="http://127.0.0.1:18790/stream">`.

### `GET /`
A small debug page with the stream and live JSON.

## How it plugs into metoera-voice

1. Start metoera-vision (`.venv/bin/python -m metoera_vision`). It starts listening on UDP 11111.
2. metoera-voice connects to the Tello on 8889 and sends `command`, then
   `streamon`. The Tello then pushes video to the controlling computer's port
   11111, which is this service. Re-send `streamon` after a Tello reboot or
   reconnect. If the stream stops, `/health.ok` turns `false`.
3. Give Grok one tool, for example `look_for(label)` and/or `describe_scene()`.
   The Node server implements it with `fetch("http://127.0.0.1:18790/find?label=...")`
   or `/detections`, and returns a short summary: "Yes, a person on the left
   (92%)." Reject results with a large `age_ms` (more than about 1500 ms) so
   Grok doesn't answer from stale video.
4. The voice UI on :18787 can show `<img src="http://127.0.0.1:18790/stream">`.
   CORS is already allowed for `fetch` calls from that origin.

Only one process can bind UDP 11111. Don't run another Tello video consumer
(an SDK `cv2.VideoCapture('udp://...')` or another copy of this service) at
the same time.

## Tests

```bash
.venv/bin/python -m pytest -q              # all (16), about 10 s once weights are cached
.venv/bin/python -m pytest -q -m "not smoke"   # fast unit/API tests with a stubbed model (13)
```
- `tests/test_detect.py`: JSON shape, normalization and clamping, sorting, `/find` matching rules, position text, annotation.
- `tests/test_frames_service.py`: the latest-frame buffer drops the backlog, and
  a slow detector fed 250 fast frames only ever sees recent frames, in order.
  It also runs the HTTP endpoints, CORS and preflight, MJPEG framing and the 400
  on a missing label, all against a stub model.
- `tests/test_smoke_real.py`: the real YOLO model on Ultralytics' `bus.jpg`. It
  also runs a **real UDP ingest**: ffmpeg streams raw H.264 in 1460-byte
  datagrams, after some junk datagrams that imitate start-of-stream garbage. The
  test checks for 960×720 decode and a detected `person`. It also checks
  file-source pacing.

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

- **Not yet tested against the real drone.** It was verified only with local
  ffmpeg replays of H.264 over UDP to 127.0.0.1:11111, a video file and still
  images. Real Tello streams can show more packet loss and smearing (grey or
  green artifacts) on weak Wi-Fi. Detections on corrupted frames may be wrong.
- On macOS, the Python process needs **Local Network** permission to receive
  from the drone's LAN address. Allow it under System Settings → Privacy &
  Security → Local Network for the terminal or app that launches it. The Tello
  pushes video to whichever host sent `streamon`, so run this service on the
  same machine as metoera-voice.
- COCO's 80 classes only (person, bottle, cup, chair, dog, cell phone, ...). No tracking and no IDs across frames.
- Positions are 2-D image positions from the drone's camera. There is no distance or depth estimate.
- `yolo11n` is tuned for speed: about 30 ms per frame on Apple Silicon MPS. Use
  `--model yolo11s.pt` for better accuracy at roughly 2–3× the cost.
- The Tello EDU forward camera only. The downward camera (`downvision`) isn't handled specially.

## Licence notes

- **Ultralytics YOLO (library and weights) is AGPL-3.0.** If you distribute this
  service, or offer it to others over a network, the AGPL obligations apply to
  the combined work (source availability). Commercial use without AGPL
  compliance requires an Ultralytics Enterprise licence. Personal or local use
  is fine.
- PyAV: BSD-3-Clause; its wheels bundle FFmpeg libraries (FFmpeg is LGPL/GPL depending on build - check before redistributing). OpenCV: Apache-2.0. PyTorch: BSD-style.
- The sample clip is made from `bus.jpg` and `zidane.jpg`, which ship inside the
  Ultralytics package. It is generated locally and git-ignored.

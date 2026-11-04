#!/usr/bin/env bash
# Builds a local 960x720 test clip from the sample images that ship inside the
# Ultralytics package (bus.jpg, zidane.jpg): a slow pan/zoom so boxes move.
# Output: samples/sample.mp4 (H.264) and samples/sample.h264 (raw Annex-B, like the Tello sends).
set -euo pipefail
cd "$(dirname "$0")/.."
ASSETS="$(.venv/bin/python -c 'import ultralytics,os;print(os.path.join(os.path.dirname(ultralytics.__file__),"assets"))')"
mkdir -p samples
cp "$ASSETS/bus.jpg" "$ASSETS/zidane.jpg" samples/

ffmpeg -y -loglevel error \
  -i samples/bus.jpg \
  -i samples/zidane.jpg \
  -filter_complex "\
[0:v]scale=1440:1080:force_original_aspect_ratio=increase,crop=1440:1080,zoompan=z='1+0.002*on':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=180:s=960x720:fps=30[a];\
[1:v]scale=1440:1080:force_original_aspect_ratio=increase,crop=1440:1080,zoompan=z='1.2':x='on*1.5':y='ih/2-(ih/zoom/2)':d=180:s=960x720:fps=30[b];\
[a][b]concat=n=2:v=1[v]" \
  -map "[v]" -c:v libx264 -preset veryfast -crf 26 -g 30 -pix_fmt yuv420p samples/sample.mp4

# Raw H.264 elementary stream (no container) - same format as the Tello's port-11111 stream.
ffmpeg -y -loglevel error -i samples/sample.mp4 -c:v copy -bsf:v h264_mp4toannexb -f h264 samples/sample.h264
ls -la samples/

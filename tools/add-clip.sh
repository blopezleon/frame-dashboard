#!/bin/bash
# Convert any video or GIF into a frame-ready ambient clip and add it to the playlist.
#   tools/add-clip.sh <input> <name> "<Title>"
# Fills the 1280x800 screen (center crop), 24 fps, H.264, no audio, max 60 s.
set -euo pipefail
in="$1"; name="$2"; title="${3:-$2}"
cd "$(dirname "$0")/.."
ffmpeg -y -loglevel error -i "$in" -t 60 \
  -vf "scale=1280:800:force_original_aspect_ratio=increase:flags=lanczos,crop=1280:800,fps=24,format=yuv420p" \
  -c:v libx264 -profile:v main -level 4.0 -preset slow -crf 21 -movflags +faststart -an "ambient/$name.mp4"
python3 - "$name.mp4" "$title" <<'PY'
import json, sys
p = 'ambient/playlist.json'
data = json.load(open(p))
data['clips'] = [c for c in data['clips'] if c['file'] != sys.argv[1]] + [{'file': sys.argv[1], 'title': sys.argv[2]}]
json.dump(data, open(p, 'w'), indent=2)
PY
echo "added ambient/$name.mp4 ($(du -h "ambient/$name.mp4" | cut -f1))"

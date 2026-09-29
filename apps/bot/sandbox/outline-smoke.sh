#!/usr/bin/env bash
set -euo pipefail
image=${1:-hibana-sandbox:latest}
root=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cat > "$work/scene.py" <<'PY'
import bpy
bpy.ops.wm.read_factory_settings(use_empty=False)
s = bpy.context.scene
s.render.engine = 'CYCLES'
s.cycles.device = 'CPU'
s.cycles.samples = 1
s.render.resolution_x = 160
s.render.resolution_y = 90
s.render.resolution_percentage = 100
s.frame_end = 2
bpy.ops.wm.save_as_mainfile(filepath='/workspace/test.blend')
PY
docker run --rm --pull=never --network none --read-only --memory 512m --memory-swap 512m --cpus 1 \
    --pids-limit 128 --cap-drop ALL --security-opt no-new-privileges \
    --user "$(id -u):$(id -g)" --tmpfs /tmp:rw,size=128m \
    -e PYTHONDONTWRITEBYTECODE=1 -e OPENBLAS_NUM_THREADS=1 \
    -v "$root/skills:/skills:ro" -v "$work:/workspace:rw" "$image" bash -euc '
blender -b -t 1 --disable-autoexec --python-exit-code 1 --python /workspace/scene.py
blender -b --disable-autoexec /workspace/test.blend -t 1 --python-exit-code 1 --python /skills/outline-edits/scripts/render_frames.py -- --output /workspace/frames --frames 1 2
blender -b --disable-autoexec /workspace/test.blend -t 1 --python-exit-code 1 --python /skills/outline-edits/scripts/render_frames.py -- --output /workspace/frames --frames 1 2 > /workspace/resume.log
cat /workspace/resume.log
test "$(grep -c "^reused " /workspace/resume.log)" = 2
if blender -b --disable-autoexec /workspace/test.blend -t 1 --python-exit-code 1 --python /skills/outline-edits/scripts/render_frames.py -- --output /workspace/frames --frames 1 --scale 50; then
    echo "ERROR: incompatible preview cache was accepted" >&2
    exit 1
fi
python3 -c "import cv2, scipy; from PIL import Image; Image.open(\"/workspace/frames/0001.png\").verify()"
python3 /skills/outline-edits/scripts/edit_effects.py --demo /workspace/demo --font /usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf
ffmpeg -v error -threads 1 -i /workspace/demo/effects-demo.mp4 -f null -
ffprobe -v error -show_entries stream=codec_name,width,height -of json /workspace/demo/effects-demo.mp4
'

---
name: outline-edits
description: >
  Starship Edit風の3Dアウトライン・ブループリント動画を、テーマと音楽から制作・修正する。
  Blenderの立体モデル・カメラ移動、白いコード風タイプ文字、ビート同期の揺れ・ブラーを使う短尺edit向け。
  通常のカット・字幕編集はvideo-edit、動画要約はyoutube-summaryを使う。
---

# Outline edits

Use sandbox bash and `/skills/outline-edits` helpers. The sandbox supplies Blender
5.2.0, Python 3.12, NumPy, Pillow, SciPy, headless OpenCV, FFmpeg/FFprobe and fonts.
These are CPU tools; no display, GPU or additional API key is required.

Choose a subject-specific model, camera path and scene sequence from the request.
Music and a topic suffice; a reference video is optional. Use the supplied music
version and excerpt, derive accents from that audio, and record timings in JSON.
Do not reuse Starship's beat times for another song. Read
[references/music-driven.md](references/music-driven.md) for planning, and
[references/reference-analysis.md](references/reference-analysis.md) when a video
reference is supplied. Download inputs to a project directory under `/workspace`.

Default look: black background, opaque dark bodies, selected white visible edges
(not a transparent wire cage), short monospace code text typed character by
character. Move the actual object and camera through a meaningful detail. Apply
brief decaying shakes to the composed subject AND text on musical accents; overlap
object entry and shake. Avoid white full-screen cut flashes. User style choices
can override these defaults.

## Build and render

Read [references/blender-motion.md](references/blender-motion.md) when building the
scene. Import `/skills/outline-edits/scripts/blender_motion.py` inside Blender for
stable camera aim, world-axis rotation and centered assembly pivots. Model the
requested subject's recognizable geometry; preserve existing corrected geometry
when changing only effects. Keep the background transparent but the body opaque
when text should pass behind it. Save the scene and its construction script.

Run Blender with `--background --disable-autoexec --threads 1`, and
`--python-exit-code 1` before `--python`. Use CPU Cycles with low preview samples;
EEVEE may require a working EGL software context, so verify it before committing
to a long render. Blender scripts execute code: inspect downloaded scripts before
running them; disabling autoexec does not disable an explicit Python script.

The ordinary bash sandbox has a per-call timeout and 512MiB memory default. Start
at 320x180, 1–4 CPU samples and one representative frame. Measure cost, simplify
geometry/textures if needed, then render small sequential batches within the tool
timeout. Never launch background processes or parallel Blender jobs to bypass
limits. The existing `video_edit` worker accepts timelines, not Blender projects.

For a saved scene with packed textures, render resumable PNG batches:

```sh
blender -b --disable-autoexec project/scene.blend -t 1 --python-exit-code 1 --python /skills/outline-edits/scripts/render_frames.py -- --output project/preview --frames 1 15 30 --scale 25
```

Frame numbers are Blender timeline numbers (usually start at 1). The helper uses
scene settings; configure CPU/samples in the scene before saving. A manifest binds
cache to scene bytes, Blender version and scale. Pack external assets into the
blend; use a new cache after changing assets or rendering scripts. Resume with the
same arguments; completed PNGs are verified before reuse. Keep full rendering in
a different directory from preview.

## Compose, verify, deliver

Read [references/compositing.md](references/compositing.md) for the helper API and
layer ordering. Import `scripts/edit_effects.py` for typed_title, code_text_layer,
directional_blur_rgba, composite_layers and apply_shake. Process one frame at a
time; do not hold the movie in RAM. `assets/outline-impact.json` is a normalized
shake curve, not a mandatory timeline. Use DejaVuSansMono-Bold.ttf under
`/usr/share/fonts/truetype/dejavu/`; Japanese text uses
`/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf`. Consolas is not bundled.

Write composition code and parameters in the project. Encode numbered frames
with FFmpeg H.264/yuv420p, CRF 15–18, `-threads 1`, `+faststart`; set the actual
start number and framerate. Attach the chosen excerpt as AAC (or stream-copy a
compatible prepared AAC track). Check duration, resolution, fps and audio with
ffprobe, then decode the whole MP4 with `ffmpeg -v error -i final.mp4 -f null -`.
Use `scripts/reference_frames.py final.mp4 inspection --range START:END` to extract
sequential transition frames and a contact sheet. View them with the image tool;
listen if audio playback is available, otherwise state that audio was not audited.
Inspect type timing, occlusion, continuous camera orientation, shakes settling,
and unexpected black/white frames. A contact sheet cannot verify all motion/audio.

For subsequent conventional captions/BGM/cuts, pass the rendered MP4 as a local
clip to `video_edit` using its skill and timeline contract. Blender scene sources
alone cannot be saved/rendered by that worker. Deliver final.mp4 with send_file;
include an editable ZIP (scene, scripts, timings, licensed sources) when requested
or useful for later revisions. Workspace files expire; deliver the archive for
long-term retention. Do not claim rendering itself sent a file.

## Reference provenance

Helpers, preset, tests and detailed references are vendored from
https://github.com/flaceja/outline-edits at commit
`1e04bc5d4be4d9554bd73d35c7e03ddbd51bf9a7` under [LICENSE](references/LICENSE.txt) (MIT).
This entrypoint and render_frames.py adapt that workflow to hibana.
The concrete example is https://github.com/flaceja/starship-edit; see
[references/starship-case.md](references/starship-case.md). Its scene is not bundled.
To reproduce it, clone the project into workspace, inspect its scripts and use its
own render.py/export.py (zero-based 0000–0470), with the installed monospace font.
The original music and proprietary fonts are not distributed; substituted fonts
change the result. Full 471-frame production is hardware-dependent and may exceed
this sandbox's limits; establish feasibility from measured previews first.

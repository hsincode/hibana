---
name: video-edit
description: >
  動画を編集・制作する。CapCut風のカット、ズーム、トランジション、多層合成、
  動く日本語字幕、単語ハイライト、BGM、自動文字起こしに対応。
  「動画編集」「ショート動画を作って」「字幕を付けて」「この動画を修正」で使用する。
  動画の要約だけなら youtube-summary を使う。
---

# Video editing

For Starship-style 3D outline/blueprint edits, use `outline-edits` first.
It renders Blender scenes and code-text effects into an MP4 that this timeline
worker can then use as an ordinary clip.

Use `video_edit` (discover through workspace MCP on upstream harnesses).
Read [references/timeline.md](references/timeline.md) before writing a timeline.
Renderer: `/skills/video-edit/scripts/render.py` (FFmpeg + libass).

Create a project subdirectory in `/workspace` with `timeline.json` and local media.
Use download_attachment/download_media for user sources; inspect representative
frames and ffprobe metadata before choosing cuts. Original productions need actual
images/video appropriate to the subject, not static text cards in place of footage.
Preserve source speech unless asked to remove it.

1. Build the timeline. Validate with `python3 /skills/video-edit/scripts/render.py project/timeline.json --validate`.
2. `video_edit {action:"save", project:"short-01", path:"project"}` persists a snapshot.
3. `video_edit {action:"render", project:"short-01", preview:true}` starts the worker.
4. Check `status` with `wait_seconds:20`; it returns real state/stage/progress.
   Do not repeatedly start renders. If busy, report that the worker is occupied.
5. On completion, `collect` to a new workspace directory. View contact-sheet.jpg
   with the image tool and preview.mp4 when video viewing is available. Check
   composition, caption legibility, timing, unexpected blank frames and audio.
   A contact sheet alone cannot verify sound or every frame.
6. Revise the local timeline and save/render again as needed. Set preview:false for
   final output, collect to a new directory, then send_file final.mp4. Rendering
   does not deliver files. If too large, encode a smaller delivery copy to the
   current attachment limit; retain the full-quality master.

Projects persist outside workspace TTL, under the same guild/thread/DM isolation.
For later edits use list, then restore into a new workspace directory; change
sources/timeline and save under the same id. Save replaces that project's snapshot
and results. collect leaves the persistent copy intact. Only delete projects when
the user requests removal or authorizes cleanup.

CPU limits: one render globally, 640MiB RAM with up to 1GiB memory+swap, 0.75 CPU,
1h deadline, 350MB source, 1GB working project, 3GB global storage including ASR
models, 10min timeline, 60 clips, maximum dimension 1920. Prefer short 30fps edits
and preview first. Bot restart leaves the Docker worker running; host reboot may
fail a job, but saved sources survive. Progress is by stage, not an ETA.
cancel stops the named project's current job.

Auto subtitles: `transcribe:{language:"ja",model:"tiny"}` transcribes edited source
speech BEFORE BGM. First use downloads the model to persistent cache; CPU int8
inference can be slow. base/small cost more RAM/time. Review output/captions.json,
correct proper nouns/timestamps, then replace transcribe with explicit captions
for reproducible final renders. Do not duplicate automatic/manual cues. No API
credentials are needed.

Supported animations: zoom, moving overlays, subtitle fade/pop/karaoke. CapCut
projects/templates, arbitrary React/Remotion scenes, AI background removal and
optical-flow interpolation are not implemented. Explain these limits when relevant.

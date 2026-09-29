---
name: music-create
description: >
  オリジナルの音楽・BGM・インスト・日本語の歌を作曲し、歌声と音色の合成、編曲、ミックス、マスタリングで
  MP3/WAVを制作する。メロディック・エレクトロニカ、電子音楽、ゲーム音楽に向く。
  「曲を作って」「作曲」「BGM制作」「音楽を生成」「歌を付けて」で使用する。歌詞だけ・既存曲の検索は対象外。
---

# Music production

Compose a score in the workspace and render it with the installed synthesis engine.
NumPy and FFmpeg are already in the sandbox. Instrumentals need no network.
Japanese singing uses the installed local VOICEVOX service; no paid API or GPU.
The engine contains the instrument design and mixing chain used for the reviewed
three-minute reference track, Afterlight. It renders the notes you write; it does
not invent a melody from a text prompt. You are the composer.

Read [references/score.md](references/score.md) for the score contract and patches.
Read [references/production.md](references/production.md) when deciding arrangement,
mix balance, or how to adapt the reference approach to another brief.
For songs with vocals, also read [references/singing.md](references/singing.md).

## Workflow

1. Choose tempo, key, duration and an arrangement appropriate to the user's brief.
   Write a short workspace Python composer that produces `song/score.json`. Notes
   and phrases should be intentional; seeded variation is for performance detail.
   The engine under `/skills/music-create/scripts/` is read-only and reusable.
2. Validate without rendering:

   ```sh
   python3 /skills/music-create/scripts/render.py song/score.json --validate
   ```

3. For a vocal score, first run `sing.py` as described in the singing reference.
   Follow its `next_command` until `complete: true`; add `--vocals song/vocals`
   to the render command. Singing and mixing run sequentially to bound memory.
   Render with a bash timeout of **360 seconds** (upstream harness: equivalent
   long-running exec and its wait tool). Run one render at a time:

   ```sh
   python3 /skills/music-create/scripts/render.py song/score.json --output song/audio --plot
   ```

   Choose a **new output directory** on each revision. Add `--stems` when separate
   instruments are useful for editing or requested by the user. Default outputs
   are a 48 kHz/24-bit WAV, delivery MP3, MIDI, score, measured report, and compact
   reproducibility ZIP. MP3 defaults to at most 7.5 MB; use `--max-bytes` for the
   actual attachment limit. Render completion is not delivery.
4. Inspect `audio/analysis.json`: warnings, section levels, measured loudness and
   true peak. View `analysis.png` when generated. Listen when an audio-capable tool
   is available; numerical/visual checks alone do not establish musical quality.
   Correct arrangement or balance in the score, then render to `audio-v2` as needed.
5. Deliver `audio/mix.mp3` through `send_file` (discover workspace/delivery tools on
   upstream harnesses). Also offer/send `project.zip` when editability matters.
   Retain the WAV; it may exceed Discord's attachment limit. Do not claim delivery
   until the tool succeeds. Include the exact `VOICEVOX:<voice name>` credit in
   the delivery caption for singing. `project.zip` contains the score, engine,
   and prepared vocals (when used); optional instrument stems are separate.

## Reference and Boundaries

To reproduce the reference, or inspect its actual voicings, motif development,
humanization and track balance:

```sh
python3 /skills/music-create/scripts/compose_example.py song/afterlight.json
```

This writes an editable 80-bar, 112 BPM example; then use the renderer above.
For a new-song request, write a new composition. Changing the title, tempo, or key
of Afterlight alone is not a new composition. Its full composer is available in
`scripts/compose_example.py` if a concrete arrangement example is needed.

The tested scope is soft electric keys, bass, pads, lead, plucks/bells, electronic
drums and transitions, plus score-driven Japanese VOICEVOX singing. The default
singing style is 波音リツ (6000). It has no sampled grand piano/orchestra,
audio-to-MIDI, voice cloning, or text-to-audio model. Match instrumentation
to those capabilities and state a relevant limitation when the brief requires it.

Scores are fixed-tempo 4/4, **at most 180 seconds including the release tail**,
16 tracks and 20,000 events. This keeps the tested render within 512 MiB. The
Afterlight example took about 30 seconds locally with 1 CPU; VPS time varies.
Default output uses about 60 MB; optional stems/premaster can approach 1 GB.
Workspace files expire under normal workspace TTL. Deliver the project ZIP for
later reproduction; this skill does not add persistent background jobs.

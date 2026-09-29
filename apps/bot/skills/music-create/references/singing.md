# Japanese Singing

Use the existing VOICEVOX **singing** engine. You write both the melody and the
lyrics; this is not spoken TTS over a backing track. The default full singing
voice is **波音リツ**, style **6000**, with a female-sounding timbre. Choose a
comfortable register (roughly D4..E5 for this example); tune pitches to the song.
The result has the character of a synthesized singer, not a recorded human.

## Score

Add a track: `"vocal": {"patch": "vocal", "singer": 6000, "gain": 0.8}`.
Each vocal event has one Japanese **mora** in `lyric`, plus the normal `beat`,
`note`, `duration`, and `velocity`. For example:

```json
{"track":"vocal","beat":4,"note":65,"duration":1,"lyric":"きゃ","velocity":0.85}
```

- Split words into morae: 明日 = `あ`, `し`, `た`; 今日 = `きょ`, `う`.
  Both hiragana and katakana work. One note cannot contain an entire word.
  Write particles by pronunciation (`は` -> `わ`, `へ` -> `え`, `を` -> `お`).
  Extend a vowel with note duration; do not use punctuation, spaces or `ー`.
  The engine checks the exact mora inventory; fix a rejected reading explicitly.
- Melody must be monophonic per vocal track. For harmony use a second vocal
  track; at most two are allowed. Avoid accidental overlaps after quantization.
- Start singing at least 0.25 seconds into the score. Each note lasts 0.08..8
  seconds. Add a **breath of at least 0.52 seconds every 10 seconds**. The engine
  groups the intervening notes into phrases, preserving anticipated consonants.
- Use `beat`/`duration` for timing. Vocal event `pan` and `offset_seconds` must
  remain zero; set `pan` on the track. Velocity is rendered into the dry voice.
- Optional top-level `lyrics` is the readable lyric sheet, with normal kanji and
  line breaks. It is exported to `lyrics.txt`; actual pronunciation uses events.
- Leave space in the arrangement. Remove or quiet the lead that doubles the
  vocal melody, lower busy arpeggios, and keep the vocal near the center. Default
  vocal filtering/compression and modest reverb/delay are already provided.

## Prepare and Mix

Use a **360-second bash timeout** and one job at a time. No installation needed:

```sh
python3 /skills/music-create/scripts/sing.py --list-singers
python3 /skills/music-create/scripts/sing.py song/score.json --output song/vocals
```

`--list-singers` lists only styles that support full singing. A `frame_decode`
(humming) style alone cannot predict the notes; do not substitute its ID.

Each invocation prepares up to four phrases initially. When `complete: false`,
run the returned `next_command` (it advances `--through`, e.g. 4, 8, 12) until
`complete: true`. Completed phrases survive timeout/retry. A completed directory
works without the server. Changes to vocal notes, lyrics, velocity, singer, or
song length require a **new vocal directory**; cached mismatches are refused.
Mix gain, pan, EQ, sends and accompaniment edits can reuse the prepared vocals.

```sh
python3 /skills/music-create/scripts/render.py song/score.json --vocals song/vocals --output song/audio --plot
```

Check `analysis.json`, especially vocal track levels, clipping, true peak and
section balance. Audio review, when available, is still necessary for judging
pronunciation and musical quality. Numeric checks cannot judge either.

An executable reference arrangement of Afterlight with original Japanese lyrics:

```sh
python3 /skills/music-create/scripts/compose_vocal_example.py song/score.json
```

For a different brief, compose new music and lyrics. The example is a reference.

## Delivery and Reproduction

Deliver the MP3 with **`VOICEVOX:波音リツ`** in its caption (or the exact credit
returned by the selected singer). The renderer embeds credits in MP3/WAV
metadata and includes `CREDITS.txt`, `lyrics.txt`, lyric MIDI events and dry vocal
WAVs in `project.zip`. MIDI represents the melody and lyric timing, not the voice.
The ZIP can reproduce the final mix **offline**, without VOICEVOX. It is larger
than an instrumental project; check Discord's file-size limit before sending.

VOICEVOX terms: https://voicevox.hiroshiba.jp/term/
波音リツ terms: https://www.canon-voice.com/terms
The selected voice's own usage policy also applies. Include the credit on
publication, not only inside a ZIP. For other singers inspect their policy via
`/singer_info?speaker_uuid=<uuid>&resource_format=url`.

## Service and Resource Notes

The bot deployment config supplies the local service URL. On a developer machine
it defaults to `http://127.0.0.1:50021`; `--url` or `VOICEVOX_URL` can override it.
If unavailable, retain score/cache and report the concrete connection error.
Do not silently deliver an instrumental in response to a singing request.

Operators install it using `make music-service` or `MUSIC_SINGING=1 make update`.
The 0.25.2 CPU image uses the digest-pinned upstream singing model and keeps all
licenses/resources, omitting speech-only models. It is built locally with
`make music-image` and only the final image is transferred (about 0.5 GB image,
around 1.3 GB Docker disk use; deployment requires at least 2 GB free space).
The service is capped at 640 MiB/1 CPU. It exposes
port 50022 only on the Docker bridge, with mutable APIs disabled. Subsequent
`make update` maintains an existing service. The ordinary mixing stage still
runs within the 512 MiB sandbox; do not run inference and mixing in parallel.
`make music-singing-smoke` exercises a running service with real Japanese singing
and a mix. Ordinary `make music-smoke` remains offline and covers the protocol,
resuming, file integrity, timing and exact offline reproduction using a test server.

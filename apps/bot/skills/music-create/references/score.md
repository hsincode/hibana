# Music Score v1

JSON input to `/skills/music-create/scripts/render.py`. Only standard JSON is
accepted; validate before rendering. Times are quarter-note beats, except fields
explicitly named in seconds. MIDI note 60 is C4; velocity is 0..1, pan is -1..1.

Minimal *format* example (not a finished composition):

```json
{
  "version": 1,
  "title": "New song",
  "bpm": 112,
  "bars": 4,
  "seed": 42,
  "tail_seconds": 5,
  "key": "D minor",
  "key_signature": [-1, 1],
  "tracks": {
    "keys": {"patch": "keys"},
    "lead": {"patch": "melody", "gain": 0.38},
    "drums": {"patch": "kick"}
  },
  "sections": [{"start": 0, "end": 16, "name": "Theme"}],
  "events": [
    {"track": "keys", "beat": 0, "note": 53, "duration": 3, "velocity": 0.65, "pan": -0.2},
    {"track": "keys", "beat": 0.03, "note": 60, "duration": 3, "velocity": 0.6, "pan": 0.2},
    {"track": "lead", "beat": 0.5, "note": 74, "duration": 0.75, "velocity": 0.8},
    {"track": "drums", "beat": 0, "note": 36, "duration": 0.4}
  ]
}
```

## Top Level

| Field | Meaning |
| --- | --- |
| `version` | Required, `1` |
| `title` | Required, nonempty text, at most 200 characters |
| `artist` | Optional, defaults to `hibana` |
| `bpm` | Required, 40..240, constant tempo |
| `bars` | Required, integer; each bar has 4 quarter notes |
| `tail_seconds` | Release after the last bar, 2..12, default 5 |
| `seed` | Integer 0..2147483647, default 0 |
| `tracks` | Required, 1..16 named track objects |
| `events` | Required, 1..20,000 event objects |
| `sections` | Optional, ordered nonoverlapping `{start,end,name}` in beats |
| `key` | Optional descriptive text, e.g. `D minor` |
| `key_signature` | Optional MIDI key: [sharps/flats -7..7, minor 0 or 1] |

Total duration = `bars * 4 * 60 / bpm + tail_seconds`, limited to 4..180 seconds.
The engine is always stereo 48 kHz. `frames`, `duration_seconds`, and `sample_rate`
are calculated by validation. Extra descriptive data such as chord maps is
preserved but does not produce sound; audible parts need events.

## Tracks and Patches

Names must match `[a-z][a-z0-9_-]{0,39}`; `delay_return` and `hall_return` are reserved.
Set `patch` for custom track names.
Mix settings inherit the production defaults for that patch, so a small track
object is enough. See `DEFAULT_TRACKS` in `scripts/score.py` for exact settings.

| Patch | Sound / role |
| --- | --- |
| `keys` | Soft FM electric keys, tine attack, decay and tremolo |
| `pad` | Slowly swelling, detuned additive pad |
| `bass` | Centered harmonic bass with short filter-like decay |
| `melody` | Rounded lead with vibrato and controlled overtones |
| `softlead` | Softer version for lower or sparse phrases |
| `arpeggio` | Short woody/plucked FM tone |
| `bell` | Longer, gently inharmonic chime |
| `vocal` | Japanese singing prepared with VOICEVOX; see [singing.md](singing.md) |
| `kick` | Pitched electronic kick, synthesized transient |
| `snare` / `ghost` | Layered clap/snare and shorter ghost note |
| `hat` / `openhat` / `shaker` | Metallic/noise percussion |
| `rim` / `tom` | Short rim and MIDI-pitched tom |
| `crash` / `riser` / `reverse` | Cymbal, noise rise, reversed pitched pluck |

`gain` (0..1), `verb` (hall send 0..1), `delay` (tempo delay send 0..1), `duck`
(kick-triggered reduction 0..0.95), `hp`/`lp` (high/low-pass cutoff in Hz, hp < lp),
and `midi` (zero-based GM program 0..127) may be overridden per track. These are
linear gains, not dB. Master EQ/compression and shared effect character follow the
reviewed reference. Default master target is -14 LUFS; `--lufs` accepts -24..-10.

Put melodic and percussion patches on separate tracks. Up to 15 melodic MIDI
channels are available; percussion uses GM channel 10. Effects `riser` and
`reverse` are omitted from MIDI. MIDI preserves note performances, not synthesis
timbres, envelope release, automation or effect returns.

## Events

- `track`: required existing track name.
- `beat`: required start, 0..bars*4. Use `bar * 4 + offset` for a phrase.
- `note`: MIDI 24..96, default 60. Pitch applies to melodic patches and toms;
  electronic kick/hat/snare use designed frequencies. GM percussion numbers are
  useful for MIDI: kick 36, snare 38, closed hat 42, open hat 46, crash 49.
- `duration`: gate in beats, 0.015..32, default 0.5. Gate end must fit the bars.
  Keys/pad/lead/bass release after it. Plucks and drum one-shots have designed
  decays; riser/reverse use the gate. Leave a tail for all releases and reverb.
- `velocity`: 0..1, default 0.8; zero is silent.
- `pan`: -1 left, 0 center, +1 right; equal-power pan, default 0.
- `offset_seconds`: timing adjustment -0.1..0.1, default 0. Keep kicks tight;
  a few milliseconds of variation on keys/percussion is usually enough.
- `patch`: optional per-event variation within the track's melodic/percussion
  family, e.g. `ghost` on a snare track or `softlead` on a melody track.
- `seed`: optional per-event noise seed. Missing seeds derive from project seed
  and input order. Preserve the exported score to reproduce the performance.

Vocal events additionally require `lyric` (one kana mora). They are monophonic,
start after 0.25 seconds, and last 0.08..8 seconds. Vocal track settings include
`singer` (default 6000) and `pan`; per-event pan and timing offsets must be zero.
Read the singing reference for phrase lengths, breaths, preparation and credits.

## Outputs

`mix.mp3` is the delivery copy. `master.wav` is 48 kHz/24-bit. `score.mid`, normalized
`score.json`, `analysis.json`, `sha256.json` and `project.zip` are always written.
`--plot` adds `analysis.png`; `--stems` retains 32-bit float instrument/effect WAVs
and `premaster.wav`. Float stems may exceed 0 dBFS without clipping and are at mix
levels; their sum precedes master processing.

`analysis.json` reports measured master/MP3 loudness and true peak, sample clipping,
section RMS, track levels, stereo correlation, tool versions and warnings. For
loudnorm records, **`input_i` / `input_tp` are the measured file values**;
`output_*` describes a hypothetical normalization pass, not the saved master.

The renderer writes a temporary directory beside the output and only publishes it
after validation. Existing outputs are refused. A forced container kill may leave
a `.music-render-*` directory; the score remains the source for a fresh render.

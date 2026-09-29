# Production Decisions

The reference is a concrete quality baseline for instrumental electronic music.
Use its methods where they fit the brief, and write the melody and arrangement for
the current request. Timbres are synthesized, so convincing electronic material
is a better fit than promising sampled concert instruments or vocals.

## Composition

Write a motif that can be remembered, then develop it through phrase endings,
register, rhythmic displacement, rests, and a contrasting answer. Repeated bars
need a musical reason. Uniform random scale notes do not make a strong melody.
Use voicings and inversions to connect chords; keep the bass separate from dense
upper extensions. Resolve or deliberately suspend the ending.

Build an energy map before creating hundreds of events. A main theme, contrasting
middle, and reprise help a full song feel complete. A short game cue can be more
compact. For a seamless loop, the current engine's release and final fade must be
accounted for in a separate editing pass; its default output is a finished song.

Afterlight's example: D minor, 112 BPM, 80 bars. Intro 8, first theme 16, lift 8,
main theme 16, bridge 8, final reprise 16, outro 8. The primary progression is
Dm9 / Bbmaj9 / Fmaj9 / Cadd9 with two bars per chord; the bridge adds Gm9 and
A7 before returning. These choices illustrate a structure, not a mandatory style.

## Performance and Sound

Keep the kick/bass timing controlled; use small seeded offsets on keys, snare and
percussion. Vary velocities by musical accent. Roll chord attacks slightly instead
of triggering every note at precisely the same sample. The renderer does not add
these musical decisions automatically.

Use `softlead` in lower-register phrases, `melody` for the hook, and sparse high
chimes as a counterline. Leave rests and reserve the densest instrumentation for
the intended peak. `pad` attacks slowly; short pad gates may never reach full level.
Electronic one-shots have fixed tonal centers except for toms.

## Mixing and Revision

Start with the supplied track levels. In the reviewed mix, keys initially masked
the lead, so keys were reduced and the lead/percussion raised. That balance is
already reflected in the defaults. A new composition with different density or
register may need different levels. Master normalization cannot fix masking.

Center kick and bass. Distribute upper chord voices and percussion across the
stereo field without hard-panning the whole arrangement. Bass should have enough
harmonics to read on small speakers, with room left by the kick's duck envelope.
Avoid giving every instrument a large hall/delay send; leave the rhythm dry enough
to define attacks. Delay is filtered, dotted-eighth based, and stereo; hall decay
is frequency-dependent. The same sends and effects are available to custom tracks.

Check section RMS rather than demanding identical loudness everywhere. A quiet
bridge and louder hook are intentional. Watch warnings about nearly silent
sections and excessive track peaks. `master.input_i` near -14 LUFS and true peak
below -1 dBTP are technical delivery checks, not proof of musical quality.

Listen when possible. Otherwise inspect waveform/spectrum and report only the
checks actually performed. A user-requested revision should change the score or
mix choices, then generate a new output folder and deliver the revised MP3.

For reuse, keep the composer, exported score and project ZIP. A short Python
composer is usually easier to edit than hand-writing thousands of JSON events.
The exported score fixes seeds and performance details; the ZIP includes the
engine so the sound can be regenerated in an equivalent NumPy/FFmpeg environment.

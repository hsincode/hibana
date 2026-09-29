# Timeline v1

All `src` paths are local files relative to timeline.json. Absolute paths, URLs,
missing files and symlink escapes are rejected. Save only timeline + source assets;
`output/` and `.render-*` are reserved. All durations are seconds, measured on the
OUTPUT timeline after speed changes/transitions. Width and height must be even.

```json
{
  "version": 1, "width": 1080, "height": 1920, "fps": 30,
  "clips": [
    {"src": "shot-a.mp4", "in": 1, "duration": 3, "speed": 1, "volume": 1,
     "fit": "cover", "zoom": [1, 1.12]},
    {"src": "shot-b.mp4", "in": 0, "duration": 3, "speed": 1.25,
     "transition": {"type": "fade", "duration": 0.4}}
  ],
  "overlays": [
    {"src": "logo.png", "start": 0.2, "duration": 2, "width": 0.2,
     "x": 0.05, "y": 0.05, "end_x": 0.8, "fade": 0.2}
  ],
  "captions": [{"start": 0.2, "end": 2.5, "text": "編集した字幕"}],
  "caption_style": {"size": 64, "margin": 160, "animation": "pop"},
  "audio": [
    {"src": "music.mp3", "start": 0, "duration": 5.6, "volume": 0.18,
     "fade_in": 0.3, "fade_out": 0.5, "duck": true}
  ]
}
```

The example lasts 5.6s: sum(clip.duration) minus incoming transitions. The second
source must contain at least 3 * 1.25 = 3.75 seconds.

## Clips

Required src, duration. Video or still PNG/JPEG/WebP/BMP. Each still lasts duration.
Defaults: in=0, speed=1, volume=1, fit=cover, zoom=[1,1]. duration is output duration:
speed=0.5 stretches 1s input to 2s output. Audio tempo changes preserve pitch.
speed: .25..4. Missing audio becomes silence; volume=0 mutes original sound.
fit=cover fills/crops centrally; contain letterboxes. zoom=[start,end] (each 1..3)
animates centrally. Optional brightness=-1..1 (default 0), contrast=.1..3 and
saturation=0..3 (default 1).

transition belongs to the INCOMING clip, never the first. duration=0..2.
type: fade, wipeleft, wiperight, slideleft, slideright, circleopen, dissolve.
Video and audio both crossfade. Adjacent overlaps cannot consume an entire clip.
Omit for a straight cut.

## Overlays

Up to 12, list order above base and below captions. Images retain alpha; video
is silent (add an audio track separately if needed). src, start (default 0),
duration (default remainder), in (default 0), width (.05..1 of canvas width).
x/y=0..1 are fractions of available travel: 0=left/top, 1=right/bottom.
end_x/end_y default to x/y, interpolate linearly. fade adds alpha fade in/out.
Useful for logos, picture-in-picture and moving panels.

## Captions

start, end, text required. Up to 2000 cues. Style size/margin are original canvas
pixels and scale with preview. IPAGothic supports Japanese. libass wraps text;
split long paragraphs into short cues and insert newlines when appropriate.
animation: fade/pop/none. Bottom center alignment, outline and shadow.

Word highlighting: add `words:[{start:0.2,end:0.5,text:"Hello "}, ...]`. Word times
are absolute OUTPUT times, ascending and inside cue bounds. Include spaces as
needed. Words replace displayed text; cue.text remains the transcript. Highlight
sweeps yellow; unspoken words are white. Literal ASS override tags are escaped.

Optional `transcribe:{language:"ja",model:"tiny"}` uses faster-whisper CPU int8.
tiny/base/small only. Source speech is transcribed AFTER speed changes/crossfades
and BEFORE extra audio tracks. Narration in audio[] is not transcribed: use explicit
cues or prepare the narration as clip audio. Render emits captions.json; correct
it, remove transcribe and set captions explicitly to reuse them in the final.

## Audio and output

Up to 12 tracks: src, start/in (default 0), duration (default remainder), volume
(0..4, default 1), fade_in/fade_out (seconds, default 0). duck=true reduces the track
under original speech plus non-ducked narration. Use low volume for BGM. No automatic
looping: provide enough audio or prepare a looped source. Final mix is peak limited;
listen to assess clarity and loudness.

Outputs: preview.mp4 (max dimension 640), final.mp4 (timeline resolution),
contact-sheet.jpg (six labeled frames), captions.json, status.json.
MP4 = H.264 yuv420p + stereo AAC 48kHz, faststart. Master/preview may coexist;
status.video identifies the latest successful output. An old MP4 left on disk
does not mean the current failed job succeeded.

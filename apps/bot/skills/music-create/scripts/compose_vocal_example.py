#!/usr/bin/env python3
"""Write an original Japanese vocal arrangement of Afterlight (VOICEVOX singing)."""

import argparse
import copy
import json
from pathlib import Path

from compose_example import BPM, BARS, CHORDS, SECTIONS, SEED, TAIL, chord_at, compose
from score import DEFAULT_TRACKS, validate_score


def compose_vocals():
    verse = ["よあけまえのまち", "あめのにおいだけ", "ほどけたきのうお", "みずにながしたら",
             "とおくひかるまど", "きみのこえがする", "ねむっていたとき", "いまうごきだした"]
    hook = ["ひかりのむこうえ", "きみとあるきたい", "なまえのないあす", "いろおかさねよう",
            "こぼれたねがいも", "そらえとほどけて", "あたらしいあさお", "きみとむかえよう"]
    verse_pitches = [[62, 65, 67, 69, 67, 65, 64, 62], [65, 65, 69, 70, 69, 65, 62, 65],
                     [65, 67, 69, 72, 69, 67, 65, 64], [64, 67, 69, 67, 64, 62, 60, 62]]
    hook_pitches = [[69, 69, 72, 74, 72, 69, 67, 65], [65, 69, 70, 74, 72, 70, 69, 65],
                    [69, 72, 72, 76, 74, 72, 69, 67], [67, 72, 71, 69, 67, 64, 62, 64]]
    # Long final vowels and a 0.54-second breath before each following line.
    offsets = [0, .5, 1, 1.75, 2.5, 3.25, 4, 5]
    durations = [.5, .5, .75, .75, .75, .75, 1, 2]
    events = []
    for start in [8, 32, 56]:
        lines = verse if start == 8 else hook
        melodies = verse_pitches if start == 8 else hook_pitches
        for index, line in enumerate(lines):
            assert len(line) == 8, line
            notes = melodies[index % 4].copy()
            if start == 56 and index == 7:
                notes[-3:] = [65, 64, 62]
            for mora, note, offset, duration in zip(line, notes, offsets, durations):
                events.append({"track": "vocal", "beat": (start + index * 2) * 4 + offset,
                               "note": note, "duration": duration, "lyric": mora,
                               "velocity": .84 if start == 8 else .94})
    return events


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    events = compose()
    vocal_sections = [(8 * 4, 24 * 4), (32 * 4, 48 * 4), (56 * 4, 72 * 4)]
    events = [e for e in events if not (e["track"] == "melody"
              and any(a <= e["beat"] < b for a, b in vocal_sections))]
    tracks = copy.deepcopy(DEFAULT_TRACKS)
    tracks["vocal"] = {"patch": "vocal", "singer": 6000, "gain": .80, "verb": .12, "delay": .07}
    tracks["arpeggio"]["gain"] *= .7
    tracks["counterline"]["gain"] *= .65
    score = {"version": 1, "title": "ひかりの向こうへ / Afterlight", "artist": "Hibana",
             "bpm": BPM, "bars": BARS, "seed": SEED, "tail_seconds": TAIL, "key": "D minor",
             "key_signature": [-1, 1], "tracks": tracks, "events": events + compose_vocals(),
             "sections": [{"start": a * 4, "end": b * 4, "name": title} for a, b, title in SECTIONS],
             "chords": CHORDS, "chord_sequence": [chord_at(b) for b in range(BARS)],
             "lyrics": "夜明け前の街\n雨の匂いだけ\nほどけた昨日を\n水に流したら\n"
                       "遠く光る窓\n君の声がする\n眠っていた時\n今 動き出した\n\n"
                       "光の向こうへ\n君と歩きたい\n名前のない明日\n色を重ねよう\n"
                       "こぼれた願いも\n空へとほどけて\n新しい朝を\n君と迎えよう\n\n"
                       "[Chorus repeats]"}
    score = validate_score(score)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("x", encoding="utf-8") as handle:
        json.dump(score, handle, ensure_ascii=False, indent=2)
        handle.write("\n")


if __name__ == "__main__":
    main()

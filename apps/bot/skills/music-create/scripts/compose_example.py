#!/usr/bin/env python3
"""Write the original Afterlight score as an editable production example."""

import argparse
import json
from pathlib import Path

import numpy as np
from score import DEFAULT_TRACKS, validate_score

SR = 48000
BPM = 112
BARS = 80
TAIL = 7.5
SEED = 9122026
SECTIONS = [
    (0, 8, "First light"),
    (8, 24, "Moving water"),
    (24, 32, "Upstream"),
    (32, 48, "Afterlight"),
    (48, 56, "Suspended"),
    (56, 72, "Open sky"),
    (72, 80, "Home"),
]

# Root, upper voicing, arpeggio. Common tones connect the two-bar changes.
CHORDS = {
    "Dm9": (38, [53, 57, 60, 64, 69], [74, 77, 81, 84, 88]),
    "Bbmaj9": (34, [53, 57, 60, 62, 65], [74, 77, 81, 84, 86]),
    "Fmaj9": (41, [52, 57, 60, 64, 67], [72, 76, 77, 81, 84]),
    "Cadd9": (36, [52, 55, 60, 62, 67], [72, 74, 76, 79, 84]),
    "Gm9": (31, [53, 57, 58, 62, 65], [74, 77, 79, 81, 86]),
    "A7sus4": (33, [52, 55, 57, 62, 64], [73, 76, 79, 81, 85]),
    "A7": (33, [52, 55, 57, 61, 64], [73, 76, 79, 81, 85]),
    "Dm69": (38, [53, 57, 59, 64, 69], [74, 77, 81, 83, 88]),
}

def chord_at(bar):
    if 48 <= bar < 56:
        return ["Gm9", "Bbmaj9", "Dm9", "A7sus4", "A7"][[0, 0, 1, 1, 2, 2, 3, 4][bar - 48]]
    if bar >= 72:
        return ["Bbmaj9", "Bbmaj9", "Cadd9", "Cadd9", "Dm9", "Dm9", "Dm69", "Dm69"][bar - 72]
    return ["Dm9", "Bbmaj9", "Fmaj9", "Cadd9"][(bar % 8) // 2]


def compose():
    rng = np.random.default_rng(SEED)
    notes = []

    def add(track, beat, note=60, duration=0.4, velocity=0.8, pan=0, patch=None, human=0.004):
        notes.append({"track": track, "beat": round(beat, 5), "note": note,
                      "duration": duration, "velocity": round(velocity, 5), "pan": round(pan, 4),
                      "offset_seconds": round(float(rng.uniform(-human, human)), 6) if beat > 0 else 0,
                      "patch": patch or track, "seed": int(rng.integers(0, 2**31))})

    for bar in range(BARS):
        b = bar * 4
        root, chord, arp = CHORDS[chord_at(bar)]
        full = 32 <= bar < 48 or 56 <= bar < 72
        bridge = 48 <= bar < 56
        lift = 24 <= bar < 32
        active = 8 <= bar < 48 or 56 <= bar < 76

        if bar % 2 == 0 or bar == 55:
            length = 4 if bar in (54, 55) else 8
            for j, n in enumerate(chord):
                add("pad", b + j * 0.011, n + 12, length - 0.22,
                    0.64 if full else 0.53, (j - 2) * 0.31, human=0)
        if bar == 78:
            for j, n in enumerate([50, 57, 64, 65, 69, 74]):
                add("keys", b + j * 0.025, n, 7.6, 0.57, (j - 2.5) * 0.19)
        elif bar < 78:
            strikes = [(0, 0.78), (2.75, 0.42)] if active and not lift else [(0, 0.66)]
            if bridge:
                strikes = [(0.08, 0.74), (3.20, 0.28)] if bar % 2 == 0 else [(1.65, 0.48)]
            if bar < 4 and bar % 2:
                strikes = []
            for pos, vel in strikes:
                for j, n in enumerate(chord):
                    add("keys", b + pos + j * 0.018, n + (12 if bar < 2 else 0),
                        2.3 if pos == 0 else 1.1, vel * (0.88 + 0.04 * j), (j - 2) * 0.20)

        if active:
            # An intentionally broken kick pattern opens into four-on-the-floor at the hook.
            kicks = [0, 1.75, 2.5] if not full else [0, 1, 2, 3]
            if bar % 4 == 1 and not full:
                kicks = [0, 1.5, 2.75, 3.5]
            if bar % 4 == 3:
                kicks = [0, 1.75, 2.5, 3.5] if not full else [0, 1, 2, 3, 3.75]
            if bar in (31, 47, 71):
                kicks = [0, 1, 2]
            for k in kicks:
                add("kick", b + k, 36, 0.4, 0.92 if k % 1 == 0 else 0.74, human=0)
            for k in [1, 3]:
                if bar not in (31, 47, 71) or k < 3:
                    add("snare", b + k, 38, 0.4, 0.84 + 0.05 * (k == 3), -0.04, human=0.006)
            if bar % 2 == 1:
                add("snare", b + 2.73, 38, 0.13, 0.20, -0.13, patch="ghost")
            for j in range(8):
                if bar in (31, 47, 71) and j >= 6:
                    continue
                pos = j * 0.5 + (0.032 if j % 2 else 0)
                opened = full and j in (1, 5)
                add("hats", b + pos, 46 if opened else 42, 0.2 if opened else 0.06,
                    (0.48 if j % 2 == 0 else 0.77) * rng.uniform(0.88, 1.08),
                    0.26 if j % 2 else -0.20, patch="openhat" if opened else "hat")
            if full or lift:
                for j in range(16):
                    if j % 4 == 2:
                        continue
                    add("hats", b + j / 4 + (0.026 if j % 2 else 0), 70, 0.038,
                        (0.20 if j % 2 == 0 else 0.35) * rng.uniform(0.8, 1.1),
                        -0.45 + 0.1 * np.sin(j), patch="shaker")
            for pos, n, v, p in [(0.75, 75, 0.34, -0.38), (2.25, 76, 0.47, 0.43), (3.75, 75, 0.28, -0.24)]:
                if bar % 2 == 0 or full:
                    add("percussion", b + pos, n, 0.11, v, p, patch="rim")
            if bar % 8 == 7 and bar not in (47, 71):
                for k, n in enumerate([50, 47, 45, 43]):
                    add("percussion", b + 3 + k * 0.25, n, 0.3, 0.44 + k * 0.065,
                        -0.38 + k * 0.24, patch="tom")

            bass_pattern = [(0.05, root, 0.65, 0.92), (0.88, root, 0.47, 0.62),
                            (1.75, root, 0.52, 0.80), (2.55, root + 12, 0.38, 0.61),
                            (3.18, root + 7, 0.48, 0.75)]
            if full:
                bass_pattern = [(0.06, root, 0.72, 0.91), (1.35, root, 0.46, 0.74),
                                (2.07, root, 0.69, 0.89), (3.32, root + 12, 0.43, 0.72)]
            if bar % 2 == 1:
                next_root = CHORDS[chord_at(min(79, bar + 1))][0]
                bass_pattern.append((3.78, next_root + (12 if next_root < 34 else 0), 0.16, 0.56))
            if bar in (31, 47, 71):
                bass_pattern = bass_pattern[:3]
            for pos, n, d, v in bass_pattern:
                add("bass", b + pos, n, d, v, human=0.003)
        elif bridge and bar in (48, 50, 52):
            add("bass", b, root + 12, 6.9, 0.50)
            add("kick", b, 36, 0.4, 0.58, human=0)
            add("snare", b + 2, 38, 0.4, 0.35, -0.08)
        elif 4 <= bar < 8:
            for pos in [1.5, 2.5, 3.5]:
                add("hats", b + pos, 42, 0.07, 0.3 + (bar - 4) * 0.05, 0.25, patch="hat")
            add("percussion", b + 3, 75, 0.1, 0.27, -0.3, patch="rim")

        if 16 <= bar < 48 or 56 <= bar < 76:
            order = [0, 2, 1, 3, 2, 4, 1, 3]
            positions = [0.25, 0.75, 1.25, 1.75, 2.25, 2.75, 3.25, 3.75]
            for j, pos in enumerate(positions):
                if not (full or lift) and j % 2:
                    continue
                vel = (0.48 if j % 2 else 0.70) * (0.8 if bar < 24 else 1)
                add("arpeggio", b + pos, arp[order[j]], 0.25, vel,
                    0.48 * np.sin(j * 1.9 + bar * 0.6), human=0.003)

    # Eight-bar theme: two opening phrases, an upward answer, then a suspended cadence.
    theme = [
        [(0, 74, .62), (.75, 77, .52), (1.5, 81, 1.0), (2.75, 79, .45), (3.5, 77, .40)],
        [(.5, 76, .54), (1.25, 77, .53), (2, 74, 1.38), (3.65, 72, .23)],
        [(0, 74, .62), (.75, 77, .52), (1.5, 81, 1.02), (2.75, 84, .5), (3.5, 81, .4)],
        [(.25, 79, .64), (1.25, 77, .54), (2, 76, .62), (2.85, 74, .90)],
        [(0, 77, .64), (.75, 81, .52), (1.5, 84, 1.18), (3, 81, .68)],
        [(.25, 79, .68), (1.25, 77, .63), (2.25, 76, 1.25)],
        [(0, 79, .64), (.75, 76, .55), (1.5, 74, 1.05), (2.85, 72, .7)],
        [(.5, 74, .74), (1.5, 76, .75), (2.6, 79, 1.0)],
    ]
    for start in [8, 16, 32, 40, 56, 64]:
        for m, phrase in enumerate(theme):
            for j, (pos, n, duration) in enumerate(phrase):
                if start == 8 and m % 2 == 1 and j > 1:
                    continue
                if start < 24:
                    patch, vel = "softlead", 0.61
                    n -= 12
                else:
                    patch, vel = "melody", 0.83
                if start in (40, 64) and m == 7:
                    n = [77, 76, 74][j]
                add("melody", (start + m) * 4 + pos, n, duration,
                    vel * (0.9 + 0.06 * (j % 3)), -0.07 + 0.025 * (j % 3), patch=patch)
                if start == 64 and m in (0, 2, 4, 6) and j in (0, 2):
                    add("counterline", (start + m) * 4 + pos + .04, n + 12,
                        duration * 1.25, 0.46, 0.34, patch="bell")

    for bar, line in {
        2: [(0.4, 74, 1.1), (2.0, 77, 1.4)],
        4: [(0.4, 81, 1.6), (2.6, 79, .7)],
        6: [(0.5, 76, 1.4), (2.3, 74, 1.2)],
        24: [(0, 77, 1.4), (2.0, 81, 1.5)],
        26: [(0.0, 81, 1.2), (1.5, 84, 1.5), (3.3, 86, .5)],
        28: [(0, 84, 1.4), (2, 88, 1.4)],
        30: [(0, 86, 1.4), (2, 84, 1.4)],
        31: [(0, 79, 1.3), (1.75, 81, .75)],
        48: [(.75, 81, 1.1), (2.25, 79, 1.3)],
        50: [(.75, 77, 1.2), (2.5, 74, 1.3)],
        52: [(.5, 76, 1.2), (2.25, 77, 1.35)],
        54: [(0, 76, 1.2), (2, 74, 1.4)],
        55: [(0.5, 73, 1.8), (3, 76, .6)],
        72: [(.5, 81, 1.2), (2.2, 77, 1.3)],
        74: [(.5, 79, 1.3), (2.3, 76, 1.4)],
        76: [(0, 77, 1.35), (2, 76, 1.1)],
        78: [(.5, 74, 5.3)],
    }.items():
        for pos, n, dur in line:
            add("melody", bar * 4 + pos, n, dur, 0.64 if bar >= 24 else 0.45, -0.06,
                patch="softlead" if bar < 8 or 48 <= bar < 56 or bar >= 72 else "melody")

    for bar in [36, 38, 44, 46, 58, 60, 62, 66, 68, 70]:
        arp = CHORDS[chord_at(bar)][2]
        for k, pos in enumerate([.5, 1.75, 3.0]):
            add("counterline", bar * 4 + pos, arp[[4, 3, 1][k]], 0.8, 0.46,
                0.35 if k % 2 else -0.38, patch="bell")

    for bar in [8, 24, 32, 48, 56, 72]:
        add("transitions", bar * 4, 49, 3.5, 0.50 if bar in (32, 56) else 0.31, 0.1,
            patch="crash", human=0)
        add("transitions", (bar - 2) * 4, 60, 7.9, 0.63 if bar in (32, 56) else 0.30, 0,
            patch="riser", human=0)
        add("transitions", bar * 4 - 1, 74 if bar != 56 else 73, 1, .65, -.3,
            patch="reverse", human=0)
    for bar in [31, 55]:
        for j in range(8):
            add("snare", bar * 4 + j / 4, 38, .11, .13 + j * .05, (j % 2 - .5) * .18,
                patch="ghost", human=0)
    return sorted(notes, key=lambda e: (e["beat"], e["track"], e["note"]))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path, help="New JSON score to create")
    args = parser.parse_args()
    score = {"version": 1, "title": "Afterlight", "artist": "Hibana", "bpm": BPM,
             "bars": BARS, "seed": SEED, "tail_seconds": TAIL, "key": "D minor",
             "key_signature": [-1, 1],
             "sections": [{"start": a * 4, "end": b * 4, "name": title} for a, b, title in SECTIONS],
             "chords": CHORDS, "chord_sequence": [chord_at(b) for b in range(BARS)],
             "tracks": DEFAULT_TRACKS, "events": compose()}
    score = validate_score(score)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("x", encoding="utf-8") as handle:
        json.dump(score, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    print(f"Created {args.output}: {len(score['events'])} events, {score['duration_seconds']:.1f}s")


if __name__ == "__main__":
    main()

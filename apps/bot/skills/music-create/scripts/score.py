"""Validated music scores and Standard MIDI export; standard library only."""

import copy
import json
import math
from pathlib import Path
import re
import struct

SAMPLE_RATE = 48000
MAX_SECONDS = 180
MAX_EVENTS = 20000
MAX_SCORE_BYTES = 4_000_000
DRUM_PATCHES = {"kick", "snare", "ghost", "hat", "openhat", "shaker", "rim", "tom", "crash", "riser", "reverse"}
PATCHES = DRUM_PATCHES | {"bass", "keys", "pad", "arpeggio", "bell", "melody", "softlead", "vocal"}

DEFAULT_TRACKS = {
    "kick": {"gain": 0.68, "verb": 0, "delay": 0, "hp": 28, "lp": 6500, "midi": 0},
    "snare": {"gain": 0.47, "verb": 0.10, "delay": 0, "hp": 150, "lp": 11500, "midi": 0},
    "hats": {"gain": 0.30, "verb": 0.05, "delay": 0, "hp": 3400, "lp": 14000, "midi": 0},
    "percussion": {"gain": 0.37, "verb": 0.22, "delay": 0.09, "hp": 180, "lp": 7800, "midi": 0},
    "bass": {"gain": 0.38, "verb": 0, "delay": 0, "hp": 29, "lp": 1500, "duck": 0.48, "midi": 38},
    "keys": {"gain": 0.15, "verb": 0.24, "delay": 0.10, "hp": 220, "lp": 7500, "duck": 0.17, "midi": 4},
    "pad": {"gain": 0.125, "verb": 0.40, "delay": 0, "hp": 340, "lp": 4800, "duck": 0.23, "midi": 89},
    "arpeggio": {"gain": 0.135, "verb": 0.21, "delay": 0.32, "hp": 600, "lp": 8300, "duck": 0.15, "midi": 10},
    "melody": {"gain": 0.38, "verb": 0.23, "delay": 0.22, "hp": 170, "lp": 7800, "duck": 0.08, "midi": 80},
    "counterline": {"gain": 0.10, "verb": 0.35, "delay": 0.23, "hp": 650, "lp": 6500, "duck": 0.13, "midi": 14},
    "transitions": {"gain": 0.18, "verb": 0.45, "delay": 0.06, "hp": 450, "lp": 10500, "midi": 0},
}

for _name, _config in DEFAULT_TRACKS.items():
    _config["patch"] = {"hats": "hat", "percussion": "rim", "counterline": "bell",
                        "transitions": "crash"}.get(_name, _name)

VOCAL_DEFAULT = {"gain": .65, "verb": .14, "delay": .08, "hp": 120, "lp": 14000, "midi": 54}


def number(value, low, high, label, integer=False):
    if (isinstance(value, bool) or not isinstance(value, (int, float))
            or not math.isfinite(value) or not low <= value <= high
            or (integer and int(value) != value)):
        raise ValueError(f"{label} must be {'an integer' if integer else 'a number'} in [{low}, {high}]")
    return int(value) if integer else float(value)


def text(value, label, limit=200):
    if not isinstance(value, str) or not value.strip() or len(value) > limit or "\x00" in value:
        raise ValueError(f"{label} must be nonempty text of at most {limit} characters")
    return value


def load_score(path):
    path = Path(path)
    if path.stat().st_size > MAX_SCORE_BYTES:
        raise ValueError(f"Score exceeds {MAX_SCORE_BYTES} bytes")
    return validate_score(json.loads(path.read_text(encoding="utf-8")))


def validate_score(raw):
    if not isinstance(raw, dict):
        raise ValueError("Score must be an object")
    score = copy.deepcopy(raw)
    number(score.get("version"), 1, 1, "version", integer=True)
    score["title"] = text(score.get("title"), "title")
    score["artist"] = text(score.get("artist", "Hibana"), "artist")
    score["bpm"] = number(score.get("bpm"), 40, 240, "bpm")
    score["bars"] = number(score.get("bars"), 1, 180, "bars", integer=True)
    score["seed"] = number(score.get("seed", 0), 0, 2**31 - 1, "seed", integer=True)
    score["tail_seconds"] = number(score.get("tail_seconds", 5), 2, 12, "tail_seconds")
    beats = score["bars"] * 4
    score["duration_seconds"] = beats * 60 / score["bpm"] + score["tail_seconds"]
    if not 4 <= score["duration_seconds"] <= MAX_SECONDS:
        raise ValueError(f"Duration including release must be 4..{MAX_SECONDS} seconds; reduce bars or increase bpm")
    score["sample_rate"] = SAMPLE_RATE
    score["frames"] = round(score["duration_seconds"] * SAMPLE_RATE)
    score["key"] = text(score.get("key", "Unspecified"), "key", 80)
    if "key_signature" in score:
        sig = score["key_signature"]
        if not isinstance(sig, list) or len(sig) != 2:
            raise ValueError("key_signature must be [sharps_flats, minor]")
        score["key_signature"] = [number(sig[0], -7, 7, "sharps_flats", True), number(sig[1], 0, 1, "minor", True)]

    tracks = score.get("tracks")
    if not isinstance(tracks, dict) or not 1 <= len(tracks) <= 16:
        raise ValueError("tracks must contain 1..16 named objects")
    melodic = 0
    vocals = 0
    for name, config in tracks.items():
        if not isinstance(name, str) or not re.fullmatch(r"[a-z][a-z0-9_-]{0,39}", name):
            raise ValueError("Track names must be safe lowercase identifiers, at most 40 characters")
        if name in {"delay_return", "hall_return"}:
            raise ValueError(f"Track name {name} is reserved for an effect return")
        if not isinstance(config, dict):
            raise ValueError(f"Track {name} must be an object")
        patch = config.get("patch", DEFAULT_TRACKS.get(name, {}).get("patch"))
        if not isinstance(patch, str) or patch not in PATCHES:
            raise ValueError(f"Unknown patch for track {name}: {patch}")
        base = next((cfg for cfg in DEFAULT_TRACKS.values() if cfg["patch"] == patch), DEFAULT_TRACKS["melody"])
        if patch == "vocal":
            base = VOCAL_DEFAULT
        merged = {**base, **config, "patch": patch}
        for key, low, high in [("gain", 0, 1), ("verb", 0, 1), ("delay", 0, 1), ("duck", 0, .95),
                               ("hp", 20, 18000), ("lp", 20, 20000)]:
            merged[key] = number(merged.get(key, 0), low, high, f"tracks.{name}.{key}")
        if merged["hp"] >= merged["lp"]:
            raise ValueError(f"Track {name}: hp must be below lp")
        merged["midi"] = number(merged.get("midi", 0), 0, 127, f"tracks.{name}.midi", True)
        merged["percussion"] = patch in DRUM_PATCHES
        if patch == "vocal":
            vocals += 1
            merged["singer"] = number(merged.get("singer", 6000), 0, 2**31 - 1, f"tracks.{name}.singer", True)
            merged["pan"] = number(merged.get("pan", 0), -1, 1, f"tracks.{name}.pan")
        melodic += not merged["percussion"]
        tracks[name] = merged
    if melodic > 15:
        raise ValueError("At most 15 melodic MIDI channels are available")
    if vocals > 2:
        raise ValueError("At most two vocal tracks are supported")

    sections = score.setdefault("sections", [{"start": 0, "end": beats, "name": score["title"]}])
    if not isinstance(sections, list) or not 1 <= len(sections) <= 64:
        raise ValueError("sections must contain 1..64 objects")
    previous = 0
    for section in sections:
        if not isinstance(section, dict):
            raise ValueError("Each section must be an object")
        section["name"] = text(section.get("name"), "section.name", 80)
        section["start"] = number(section.get("start"), previous, beats, "section.start")
        section["end"] = number(section.get("end"), section["start"], beats, "section.end")
        if section["end"] - section["start"] < .01:
            raise ValueError("Sections must have positive length and not overlap")
        previous = section["end"]

    events = score.get("events")
    if not isinstance(events, list) or not 1 <= len(events) <= MAX_EVENTS:
        raise ValueError(f"events must contain 1..{MAX_EVENTS} objects")
    audible = False
    for index, event in enumerate(events):
        if not isinstance(event, dict):
            raise ValueError(f"Event {index} must be an object")
        track = event.get("track")
        if not isinstance(track, str) or track not in tracks:
            raise ValueError(f"Event {index} names an unknown track")
        config = tracks[track]
        event["patch"] = event.get("patch", config["patch"])
        if not isinstance(event["patch"], str) or event["patch"] not in PATCHES:
            raise ValueError(f"Event {index} names an unknown patch")
        if (event["patch"] in DRUM_PATCHES) != config["percussion"]:
            raise ValueError(f"Event {index}: percussion and melodic patches need separate tracks")
        if (event["patch"] == "vocal") != (config["patch"] == "vocal"):
            raise ValueError(f"Event {index}: vocal and synthesized patches need separate tracks")
        event["beat"] = number(event.get("beat"), 0, beats, f"event {index} beat")
        event["note"] = number(event.get("note", 60), 24, 96, f"event {index} note", True)
        event["duration"] = number(event.get("duration", .5), .015, min(32, beats), f"event {index} duration")
        if event["beat"] + event["duration"] > beats + .00001:
            raise ValueError(f"Event {index} ends past the last bar")
        event["velocity"] = number(event.get("velocity", .8), 0, 1, f"event {index} velocity")
        event["pan"] = number(event.get("pan", 0), -1, 1, f"event {index} pan")
        event["offset_seconds"] = number(event.get("offset_seconds", 0), -.1, .1, f"event {index} offset_seconds")
        if event["patch"] == "vocal":
            event["lyric"] = text(event.get("lyric"), f"event {index} lyric", 3)
            # One mora per note. The engine validates the exact kana inventory.
            kana = "".join(chr(ord(c) + 96) if "ぁ" <= c <= "ゔ" else c for c in event["lyric"])
            if not re.fullmatch(r"[ァ-ヴ](?:[ャュョァィゥェォ])?", kana):
                raise ValueError(f"Event {index}: lyric must be a Japanese kana mora (e.g. あ or きゃ)")
            if event["pan"] != 0 or event["offset_seconds"] != 0:
                raise ValueError("Vocal timing uses beat/duration; set pan on the track, not individual notes")
            number(event["duration"] * 60 / score["bpm"], .08, 8, f"event {index} vocal seconds")
            number(event["beat"] * 60 / score["bpm"], .25, MAX_SECONDS, f"event {index} vocal onset seconds")
        event["seed"] = number(event.get("seed", (score["seed"] + index * 104729) % 2**31),
                               0, 2**31 - 1, f"event {index} seed", True)
        audible |= event["velocity"] > 0 and config["gain"] > 0
    if not audible:
        raise ValueError("The score has no audible events")
    events.sort(key=lambda e: (e["beat"], e["track"], e["note"]))
    for name, config in tracks.items():
        if config["patch"] != "vocal":
            continue
        previous_end = 0
        for event in (e for e in events if e["track"] == name):
            if event["beat"] < previous_end - 1e-7:
                raise ValueError(f"Vocal track {name} has overlapping notes; use another track for harmony")
            previous_end = event["beat"] + event["duration"]
    return score


def midi_vlq(value):
    value = max(0, int(value))
    out = [value & 127]
    while value >> 7:
        value >>= 7
        out.insert(0, (value & 127) | 128)
    return bytes(out)


def export_midi(path, score):
    ppq = 960

    def chunk(events):
        data, previous = bytearray(), 0
        for tick, priority, event in sorted(events, key=lambda x: (x[0], x[1])):
            data.extend(midi_vlq(tick - previous))
            data.extend(event)
            previous = tick
        data.extend(b"\x00\xff\x2f\x00")
        return b"MTrk" + struct.pack(">I", len(data)) + data

    conductor = [(0, 0, b"\xff\x51\x03" + round(60_000_000 / score["bpm"]).to_bytes(3, "big")),
                 (0, 0, b"\xff\x58\x04\x04\x02\x18\x08")]
    if "key_signature" in score:
        sharps, minor = score["key_signature"]
        conductor.append((0, 0, b"\xff\x59\x02" + struct.pack("bB", sharps, minor)))
    for section in score["sections"]:
        label = section["name"].encode("utf-8")
        conductor.append((round(section["start"] * ppq), 1, b"\xff\x06" + midi_vlq(len(label)) + label))
    tracks = [chunk(conductor)]
    channels = iter(c for c in range(16) if c != 9)
    for name, config in score["tracks"].items():
        channel = 9 if config["percussion"] else next(channels)
        encoded = name.encode("ascii")
        events = [(0, 0, b"\xff\x03" + midi_vlq(len(encoded)) + encoded)]
        if channel != 9:
            events.append((0, 0, bytes([0xC0 | channel, config["midi"]])))
        for e in score["events"]:
            if e["track"] != name or e["velocity"] == 0 or e["patch"] in ("riser", "reverse"):
                continue
            start = max(0, round((e["beat"] + e["offset_seconds"] * score["bpm"] / 60) * ppq))
            end = start + max(1, round(e["duration"] * ppq))
            if e["patch"] == "vocal":
                lyric = e["lyric"].encode("utf-8")
                events.append((start, 1, b"\xff\x05" + midi_vlq(len(lyric)) + lyric))
            events.extend([(start, 2, bytes([0x90 | channel, e["note"], max(1, min(127, round(e["velocity"] * 110)))])),
                           (end, 1, bytes([0x80 | channel, e["note"], 0]))])
        tracks.append(chunk(events))
    Path(path).write_bytes(b"MThd" + struct.pack(">IHHH", 6, 1, len(tracks), ppq) + b"".join(tracks))

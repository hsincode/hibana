#!/usr/bin/env python3
"""Prepare resumable, time-aligned Japanese singing with a local VOICEVOX engine."""

import argparse
import fcntl
import hashlib
import io
import json
import math
import os
from pathlib import Path
import shlex
import sys
import urllib.error
import urllib.request
import wave

from score import SAMPLE_RATE, load_score

FRAME_RATE = 93.75
PAD = 24  # 256 ms for consonants before the first vowel and the final release.
MAX_PHRASE_SECONDS = 10


def digest(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode()


def atomic_write(path, data):
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_bytes(data)
    tmp.replace(path)


def vocal_plan(score):
    phrases = []
    for name, config in score["tracks"].items():
        if config["patch"] != "vocal":
            continue
        groups = []
        for event in (e for e in score["events"] if e["track"] == name and e["velocity"] > 0):
            start = round(event["beat"] * 60 / score["bpm"] * FRAME_RATE)
            end = round((event["beat"] + event["duration"]) * 60 / score["bpm"] * FRAME_RATE)
            item = {"start": start, "end": end, "key": event["note"], "lyric": event["lyric"],
                    "velocity": event["velocity"]}
            if not groups or start - groups[-1][-1]["end"] >= 2 * PAD:
                groups.append([])
            groups[-1].append(item)
        for group in groups:
            first, last = group[0]["start"], group[-1]["end"]
            if (last - first) / FRAME_RATE > MAX_PHRASE_SECONDS:
                raise ValueError(f"Vocal {name}: add a breath of at least 0.52 seconds every 10 seconds")
            # Round absolute endpoints, so subdivision rounding never accumulates.
            origin = max(0, first - PAD)
            cursor, notes, velocities = origin, [], {}
            for index, event in enumerate(group):
                if event["start"] > cursor:
                    notes.append({"key": None, "lyric": "", "frame_length": event["start"] - cursor})
                note_id = str(index)
                notes.append({"id": note_id, "key": event["key"], "lyric": event["lyric"],
                              "frame_length": event["end"] - event["start"]})
                velocities[note_id] = event["velocity"]
                cursor = event["end"]
            notes.append({"key": None, "lyric": "", "frame_length": PAD})
            phrases.append({"track": name, "singer": config["singer"], "origin_frame": origin,
                            "notes": notes, "velocities": velocities})
    return phrases


def fingerprint(score):
    return digest(encoded({"version": 1, "frames": score["frames"], "phrases": vocal_plan(score)}))


def default_url():
    if os.environ.get("VOICEVOX_URL"):
        return os.environ["VOICEVOX_URL"]
    config = Path(__file__).resolve().parents[1] / "service.json"
    if config.is_file():
        return json.loads(config.read_text())["url"]
    return "http://127.0.0.1:50021"


class Client:
    def __init__(self, url):
        self.url = url.rstrip("/")
        if not self.url.startswith(("http://", "https://")):
            raise ValueError("VOICEVOX URL must use HTTP or HTTPS")
        # The service is local to the Docker host, including when egress uses VPN.
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def request(self, path, body=None, audio=False):
        request = urllib.request.Request(self.url + path, data=None if body is None else encoded(body),
                                         headers={"Content-Type": "application/json"})
        try:
            with self.opener.open(request, timeout=120) as response:
                data = response.read(8_000_001)
        except urllib.error.HTTPError as exc:
            raise ValueError(f"VOICEVOX {path}: HTTP {exc.code}: {exc.read(1000).decode(errors='replace')}") from exc
        except (urllib.error.URLError, TimeoutError) as exc:
            raise ValueError(f"VOICEVOX unavailable at {self.url}: {exc}. Completed phrases are cached; retry the command.") from exc
        if len(data) > 8_000_000:
            raise ValueError("VOICEVOX response exceeds 8 MB")
        return data if audio else json.loads(data)

    def singers(self):
        return [{"id": style["id"], "name": singer["name"], "style": style["name"],
                 "uuid": singer["speaker_uuid"], "version": singer["version"],
                 "credit": "VOICEVOX:" + singer["name"]}
                for singer in self.request("/singers") for style in singer["styles"] if style["type"] == "sing"]


def wav_frames(data, expected=None):
    with wave.open(io.BytesIO(data), "rb") as source:
        if (source.getframerate(), source.getnchannels(), source.getsampwidth()) != (SAMPLE_RATE, 1, 2):
            raise ValueError("Prepared vocals must be mono 48 kHz 16-bit PCM WAV")
        count = source.getnframes()
        pcm = source.readframes(count)
    if len(pcm) != count * 2 or (expected is not None and count != expected):
        raise ValueError("Vocal WAV is truncated or has an incorrect duration")
    return pcm


def synthesize(client, phrase):
    query = client.request(f"/sing_frame_audio_query?speaker={phrase['singer']}", {"notes": phrase["notes"]})
    length = sum(n["frame_length"] for n in phrase["notes"])
    if (len(query["f0"]) != length or len(query["volume"]) != length
            or sum(p["frame_length"] for p in query["phonemes"]) != length):
        raise ValueError("VOICEVOX returned an inconsistent frame query")
    cursor = 0
    for phoneme in query["phonemes"]:
        end = cursor + phoneme["frame_length"]
        velocity = phrase["velocities"].get(phoneme.get("note_id"), 1)
        for index in range(cursor, end):
            # The predictor can return slightly negative amplitudes near rests.
            volume = query["volume"][index]
            query["volume"][index] = max(0, volume) * velocity if math.isfinite(volume) else volume
        cursor = end
    if not all(isinstance(x, (int, float)) and math.isfinite(x) and x >= 0
               for field in ("volume", "f0") for x in query[field]):
        raise ValueError("VOICEVOX returned invalid pitch or volume")
    query.update(outputSamplingRate=SAMPLE_RATE, outputStereo=False, volumeScale=1)
    data = client.request(f"/frame_synthesis?speaker={phrase['singer']}", query, audio=True)
    wav_frames(data, round(length / FRAME_RATE * SAMPLE_RATE))
    return data, query


def load_vocals(directory, score):
    """Verify all prepared audio before rendering; also works offline from a ZIP."""
    directory = Path(directory)
    manifest = json.loads((directory / "manifest.json").read_text())
    if manifest.get("fingerprint") != fingerprint(score):
        raise ValueError("Prepared vocals do not match the score; run sing.py into a new directory")
    expected = {name for name, cfg in score["tracks"].items() if cfg["patch"] == "vocal"}
    if set(manifest["tracks"]) != expected:
        raise ValueError("Prepared vocal track set is incomplete")
    for name in expected:
        data = (directory / f"{name}.wav").read_bytes()
        if digest(data) != manifest["tracks"][name]["sha256"]:
            raise ValueError(f"Vocal checksum mismatch: {name}")
        wav_frames(data, score["frames"])
    return manifest


def prepare(score, output, client, through=4):
    output.mkdir(parents=True, exist_ok=True)
    with (output / ".lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise ValueError("Another singing process is using this output directory") from exc
        return _prepare(score, output, client, through)


def _prepare(score, output, client, through):
    phrases = vocal_plan(score)
    if not phrases:
        raise ValueError("The score needs an audible vocal track")
    identity = fingerprint(score)
    output.mkdir(parents=True, exist_ok=True)
    marker = output / "input.sha256"
    if marker.exists() and marker.read_text().strip() != identity:
        raise ValueError("Vocal cache belongs to another score; choose a new --output directory")
    atomic_write(marker, (identity + "\n").encode())
    if (output / "manifest.json").exists():
        return {"complete": True, "phrases": len(phrases), "credits": load_vocals(output, score)["credits"]}

    state_path = output / "engine.json"
    version = client.request("/version")
    manifest = client.request("/engine_manifest")
    if manifest.get("frame_rate") != FRAME_RATE or not manifest.get("supported_features", {}).get("sing"):
        raise ValueError("VOICEVOX must support singing at 93.75 frames/second")
    singers = {s["id"]: s for s in client.singers()}
    if any(p["singer"] not in singers for p in phrases):
        raise ValueError("Selected singer cannot predict singing; use sing.py --list-singers")
    state = {"version": version, "singers": {str(p["singer"]): singers[p["singer"]] for p in phrases}}
    if state_path.exists() and json.loads(state_path.read_text()) != state:
        raise ValueError("VOICEVOX version or voice library changed; use a new vocal directory")
    atomic_write(state_path, encoded(state))
    chunks = output / "chunks"
    chunks.mkdir(exist_ok=True)
    for index, phrase in enumerate(phrases[:through]):
        path = chunks / f"{index:03}.wav"
        checksum = path.with_suffix(".sha256")
        if path.exists() and checksum.exists() and digest(path.read_bytes()) == checksum.read_text().strip():
            continue
        print(f"Singing phrase {index + 1}/{len(phrases)} ({phrase['track']})...", flush=True)
        data, query = synthesize(client, phrase)
        atomic_write(path, data)
        atomic_write(path.with_suffix(".json"), encoded(query))
        atomic_write(checksum, (digest(data) + "\n").encode())
    if through < len(phrases):
        return {"complete": False, "prepared_through": through, "phrases": len(phrases),
                "next_through": min(through + 4, len(phrases))}

    tracks = {}
    # Sparse placement keeps this stage independent of NumPy and the full stereo mix.
    for name, config in score["tracks"].items():
        if config["patch"] != "vocal":
            continue
        pcm = bytearray(score["frames"] * 2)
        for index, phrase in enumerate(phrases):
            if phrase["track"] != name:
                continue
            data = wav_frames((chunks / f"{index:03}.wav").read_bytes())
            start = round(phrase["origin_frame"] / FRAME_RATE * SAMPLE_RATE) * 2
            end = min(start + len(data), len(pcm))
            pcm[start:end] = data[:end-start]
        destination = output / f"{name}.wav"
        temp = destination.with_suffix(".tmp")
        with wave.open(str(temp), "wb") as target:
            target.setparams((1, 2, SAMPLE_RATE, 0, "NONE", "not compressed"))
            target.writeframes(pcm)
        temp.replace(destination)
        tracks[name] = {"sha256": digest(destination.read_bytes()), "singer": config["singer"]}
    credits = sorted({s["credit"] for s in state["singers"].values()})
    atomic_write(output / "manifest.json", encoded({"fingerprint": identity, "engine": state,
                                                    "tracks": tracks, "credits": credits}))
    return {"complete": True, "phrases": len(phrases), "credits": credits}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("score", type=Path, nargs="?")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--url", help="VOICEVOX base URL; default: deployment config or localhost:50021")
    parser.add_argument("--list-singers", action="store_true")
    parser.add_argument("--through", type=int, default=4, help="Prepare up to this phrase number, then checkpoint")
    args = parser.parse_args()
    try:
        client = Client(args.url or default_url())
        if args.list_singers:
            result = client.singers()
        else:
            if args.score is None or not 1 <= args.through <= 1000:
                raise ValueError("Provide a score and --through in 1..1000")
            score = load_score(args.score)
            output = args.output or args.score.parent / "vocals"
            result = prepare(score, output, client, args.through)
            result["output"] = str(output)
            if not result["complete"]:
                command = ["python3", str(Path(__file__).resolve()), str(args.score), "--output", str(output),
                           "--through", str(result["next_through"])]
                if args.url:
                    command.extend(["--url", args.url])
                result["next_command"] = shlex.join(command)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except (ValueError, OSError, KeyError, TypeError, wave.Error) as exc:
        print(f"music-create singing: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())

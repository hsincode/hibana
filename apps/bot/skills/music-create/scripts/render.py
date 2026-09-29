#!/usr/bin/env python3
"""Render an original music score using the sandbox's existing NumPy and FFmpeg."""

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import shlex
import subprocess
import sys
import tempfile
import time
import zipfile

from score import export_midi, load_score
from sing import load_vocals, vocal_plan


def run(args):
    score = load_score(args.score)
    phrases = vocal_plan(score)
    if args.validate:
        print(json.dumps({"valid": True, "title": score["title"], "events": len(score["events"]),
                          "seconds": score["duration_seconds"], "vocal_phrases": len(phrases)}, ensure_ascii=False))
        return
    if shutil.which("ffmpeg") is None:
        raise ValueError("FFmpeg is required; run inside the Hibana sandbox")
    if not -24 <= args.lufs <= -10:
        raise ValueError("lufs must be between -24 and -10")
    if args.max_bytes < 32_000:
        raise ValueError("max-bytes must be at least 32000")
    output = args.output or args.score.parent / "audio"
    if output.exists():
        raise ValueError(f"Output already exists: {output}; choose a new --output directory")
    from engine import analyze, master, render

    vocal_manifest = None
    if any(cfg["patch"] == "vocal" for cfg in score["tracks"].values()):
        if args.vocals is None:
            raise ValueError("Prepare singing with sing.py, then provide --vocals DIRECTORY")
        vocal_manifest = load_vocals(args.vocals, score)
    elif args.vocals is not None:
        raise ValueError("--vocals requires a vocal track in the score")
    credits = vocal_manifest["credits"] if vocal_manifest else []

    started = time.monotonic()
    output.parent.mkdir(parents=True, exist_ok=True)
    # Publish only a complete, validated render. Failures leave the input score intact.
    with tempfile.TemporaryDirectory(prefix=".music-render-", dir=output.parent) as tmp:
        stage = Path(tmp)
        (stage / "score.json").write_text(json.dumps(score, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        export_midi(stage / "score.mid", score)
        levels = render(stage, score, args.stems, args.vocals)
        mastering = master(stage, score, args.lufs, args.max_bytes, credits)
        report = analyze(stage, score, levels, mastering, time.monotonic() - started, args.plot)
        reproduce = ["python3", "scripts/render.py", "score.json", "--output", "audio",
                     "--lufs", str(args.lufs), "--max-bytes", str(args.max_bytes)]
        if args.stems:
            reproduce.append("--stems")
        if args.plot:
            reproduce.append("--plot")
        vocal_files = []
        if vocal_manifest:
            reproduce += ["--vocals", "vocals"]
            report["vocals"] = vocal_manifest
            (stage / "vocals").mkdir()
            for name in ["manifest.json", *[f"{name}.wav" for name in vocal_manifest["tracks"]]]:
                shutil.copyfile(args.vocals / name, stage / "vocals" / name)
                vocal_files.append(f"vocals/{name}")
            (stage / "CREDITS.txt").write_text("\n".join(credits) + "\nhttps://voicevox.hiroshiba.jp/\n", encoding="utf-8")
            lyrics = score.get("lyrics")
            if not isinstance(lyrics, str):
                lyrics = "\n".join("".join(n["lyric"] for n in p["notes"]) for p in phrases)
            (stage / "lyrics.txt").write_text(lyrics + "\n", encoding="utf-8")
            vocal_files += ["CREDITS.txt", "lyrics.txt"]
        report["reproduce_command"] = shlex.join(reproduce)
        (stage / "analysis.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        if not args.stems:
            (stage / "premaster.wav").unlink()
        paths = ["score.json", "score.mid", "master.wav", "mix.mp3", *vocal_files]
        checksums = {}
        for name in paths:
            with (stage / name).open("rb") as handle:
                checksums[name] = hashlib.file_digest(handle, "sha256").hexdigest()
        (stage / "sha256.json").write_text(json.dumps(checksums, indent=2) + "\n")
        with zipfile.ZipFile(stage / "project.zip", "w", zipfile.ZIP_DEFLATED) as bundle:
            for name in ["score.json", "score.mid", "analysis.json", "sha256.json", *vocal_files]:
                bundle.write(stage / name, f"music-project/{name}")
            for name in ["render.py", "engine.py", "score.py", "sing.py"]:
                bundle.write(Path(__file__).with_name(name), f"music-project/scripts/{name}")
            bundle.writestr("music-project/REPRODUCE.txt",
                            "Requires Python 3.11+, NumPy, FFmpeg with libmp3lame. No network or API.\n"
                            f"Run: {report['reproduce_command']}\n"
                            "See analysis.json for original tool versions. Generic MIDI playback differs from the synth patches.\n"
                            "WAV stems are 32-bit float at mix levels and precede master processing.\n")
            if vocal_manifest:
                bundle.writestr("music-project/VOCALS.txt",
                                "Prepared singing is included for offline remixing. Keep CREDITS.txt when publishing.\n"
                                "Changing vocal notes/lyrics/velocity requires sing.py and VOICEVOX; gain/pan/EQ/sends do not.\n")
        if output.exists():
            raise ValueError(f"Output was created during rendering: {output}; choose a new directory")
        stage.rename(output)
    print(json.dumps({"output": str(output), "audio": str(output / "mix.mp3"),
                      "master": str(output / "master.wav"), "project": str(output / "project.zip"),
                      "seconds": report["duration_seconds"], "lufs": mastering["master"]["input_i"],
                      "true_peak_dbtp": mastering["master"]["input_tp"], "warnings": report["warnings"]},
                     ensure_ascii=False, indent=2), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("score", type=Path)
    parser.add_argument("--validate", action="store_true", help="Validate without NumPy or FFmpeg")
    parser.add_argument("--output", type=Path, help="New output directory (default: score directory/audio)")
    parser.add_argument("--stems", action="store_true", help="Keep instrument/effect stems and floating-point premaster")
    parser.add_argument("--plot", action="store_true", help="Also create waveform/spectrogram (Matplotlib)")
    parser.add_argument("--vocals", type=Path, help="Prepared vocal directory from sing.py")
    parser.add_argument("--lufs", type=float, default=-14)
    parser.add_argument("--max-bytes", type=int, default=7_500_000, help="Maximum size of delivery MP3")
    args = parser.parse_args()
    try:
        run(args)
    except (ValueError, OSError, ImportError, subprocess.CalledProcessError) as exc:
        detail = exc.stderr if isinstance(exc, subprocess.CalledProcessError) else str(exc)
        print(f"music-create: {str(detail)[-2000:]}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

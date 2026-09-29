#!/usr/bin/env python3
"""Opt-in real VOICEVOX singing and mix smoke test; never part of offline CI."""

import argparse
import json
from pathlib import Path
import subprocess
import sys
import tempfile

from score import validate_score
from sing import Client, default_url, prepare


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="music-singing-smoke-") as tmp:
        root = Path(tmp)
        score = validate_score({
            "version": 1, "title": "Singing smoke", "bpm": 120, "bars": 3, "tail_seconds": 2,
            "tracks": {"vocal": {"patch": "vocal"}, "keys": {"patch": "keys"}},
            "events": [*[{"track": "vocal", "beat": 1 + i * .75, "note": note, "lyric": mora,
                          "duration": .75, "velocity": .85}
                         for i, (mora, note) in enumerate(zip("ひかりのむこうえ", [69, 69, 72, 74, 72, 69, 67, 65]))],
                       *[{"track": "keys", "beat": 0, "note": note, "duration": 10, "velocity": .5}
                         for note in [50, 57, 60, 65]]]})
        source = root / "score.json"
        source.write_text(json.dumps(score))
        result = prepare(score, root / "vocals", Client(args.url or default_url()))
        if not result["complete"]:
            raise ValueError("Smoke singing did not finish")
        subprocess.run([sys.executable, str(Path(__file__).with_name("render.py")), str(source),
                        "--vocals", str(root / "vocals"), "--output", str(root / "audio")], check=True)
        report = json.loads((root / "audio/analysis.json").read_text())
        if report["tracks"]["vocal"]["rms_dbfs"] < -45:
            raise ValueError("Generated vocal is nearly silent")
        print(json.dumps({"singing_smoke": "passed", "credits": result["credits"],
                          "vocal_levels": report["tracks"]["vocal"], "warnings": report["warnings"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()

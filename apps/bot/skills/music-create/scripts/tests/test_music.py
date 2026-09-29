import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import shlex
import struct
import subprocess
import sys
import tempfile
import unittest
import zipfile

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
from score import export_midi, load_score, validate_score


def small_score():
    return {
        "version": 1, "title": "Test composition", "bpm": 120, "bars": 2, "tail_seconds": 3, "seed": 27,
        "tracks": {"theme": {"patch": "melody", "gain": .3},
                   "chords": {"patch": "keys", "gain": .13},
                   "drums": {"patch": "kick", "gain": .4}},
        "events": [
            *[{"track": "theme", "beat": i * 1.5, "note": n, "duration": 1.0, "pan": -.15}
              for i, n in enumerate([69, 72, 76, 74])],
            *[{"track": "chords", "beat": .02 * i, "note": n, "duration": 6.5, "pan": (i-1) * .4}
              for i, n in enumerate([57, 60, 64])],
            *[{"track": "drums", "beat": i * 2, "note": 36, "duration": .3}
              for i in range(4)],
        ],
    }


class ScoreTests(unittest.TestCase):
    def test_validation_fixes_performance_without_mutating_input(self):
        raw = small_score()
        original = copy.deepcopy(raw)
        score = validate_score(raw)
        self.assertEqual(raw, original)
        self.assertEqual(score["frames"], 7 * 48000)
        self.assertEqual(score, validate_score(score))
        self.assertEqual(score, validate_score(raw))
        self.assertEqual(score["tracks"]["theme"]["hp"], 170)
        self.assertTrue(score["tracks"]["drums"]["percussion"])

    def test_rejects_invalid_numbers_and_resource_exhaustion(self):
        for bad in [True, "120", None, float("nan"), float("inf"), 0, 241]:
            raw = small_score()
            raw["bpm"] = bad
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                validate_score(raw)
        for field, bad in [("bars", 180), ("events", []), ("seed", -1), ("tracks", {})]:
            raw = small_score()
            raw[field] = bad
            with self.subTest(field=field), self.assertRaises(ValueError):
                validate_score(raw)
        raw = small_score()
        raw["events"] = [raw["events"][0]] * 20001
        with self.assertRaises(ValueError):
            validate_score(raw)

    def test_invalid_events_and_track_names(self):
        for field, bad in [("note", 97), ("note", True), ("patch", "unknown"), ("patch", []),
                           ("patch", "kick"), ("track", "missing"), ("track", {}),
                           ("duration", 9), ("pan", 2), ("velocity", float("nan"))]:
            raw = small_score()
            raw["events"][0][field] = bad
            with self.subTest(field=field, bad=bad), self.assertRaises(ValueError):
                validate_score(raw)
        for name in ["../escape", "/tmp/stem", "../../mix", "a/b", "Bad", "", "delay_return", "hall_return"]:
            raw = small_score()
            raw["tracks"][name] = {"patch": "keys"}
            with self.subTest(name=name), self.assertRaises(ValueError):
                validate_score(raw)

    def test_silence_sections_filters_and_midi_channels(self):
        raw = small_score()
        for event in raw["events"]:
            event["velocity"] = 0
        with self.assertRaises(ValueError):
            validate_score(raw)
        raw = small_score()
        raw["sections"] = [{"start": 2, "end": 5, "name": "A"}, {"start": 4, "end": 6, "name": "B"}]
        with self.assertRaises(ValueError):
            validate_score(raw)
        raw = small_score()
        raw["tracks"]["theme"]["hp"] = 18000
        with self.assertRaises(ValueError):
            validate_score(raw)
        raw = small_score()
        raw["tracks"] = {f"t{i}": {"patch": "keys"} for i in range(16)}
        with self.assertRaises(ValueError):
            validate_score(raw)

    def test_midi_metadata_and_percussion_channel(self):
        score = validate_score(small_score())
        score["events"][0]["velocity"] = 0
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "song.mid"
            export_midi(path, score)
            data = path.read_bytes()
        self.assertEqual(data[:4], b"MThd")
        self.assertEqual(struct.unpack(">IHHH", data[4:14]), (6, 1, 4, 960))
        self.assertIn(bytes.fromhex("ff510307a120"), data)
        self.assertIn(bytes([0x99, 36, 88]), data)
        self.assertIn(bytes([0x89, 36, 0]), data)
        self.assertNotIn(bytes([0x90, 69, 1]), data)
        pos, tracks = 14, 0
        while pos < len(data):
            self.assertEqual(data[pos:pos+4], b"MTrk")
            length = int.from_bytes(data[pos+4:pos+8], "big")
            self.assertEqual(data[pos+8+length-4:pos+8+length], bytes.fromhex("00ff2f00"))
            pos += 8 + length
            tracks += 1
        self.assertEqual((pos, tracks), (len(data), 4))

    def test_cli_validate_and_bad_input_never_create_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "score.json"
            source.write_text(json.dumps(small_score()))
            result = subprocess.run([sys.executable, str(SCRIPTS / "render.py"), str(source), "--validate"], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(json.loads(result.stdout)["valid"])
            self.assertFalse((root / "audio").exists())
            source.write_text('{"version": 1}')
            result = subprocess.run([sys.executable, str(SCRIPTS / "render.py"), str(source)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 1)
            self.assertFalse((root / "audio").exists())


HAS_AUDIO = importlib.util.find_spec("numpy") is not None and shutil.which("ffmpeg") and shutil.which("ffprobe")
if os.environ.get("MUSIC_REQUIRE_AUDIO") == "1" and not HAS_AUDIO:
    raise RuntimeError("Music smoke test requires NumPy, FFmpeg, and ffprobe")


@unittest.skipUnless(HAS_AUDIO, "Run make music-smoke for NumPy/FFmpeg render tests inside the sandbox")
class AudioTests(unittest.TestCase):
    def test_all_patches_finite_and_lead_pitch_tracks_midi(self):
        import numpy as np
        from engine import voice
        from score import PATCHES

        for patch in PATCHES - {"vocal"}:
            for note in [24, 96]:
                with self.subTest(patch=patch, note=note):
                    x = voice({"patch": patch, "duration": .5, "seed": 1, "note": note}, .5)
                    self.assertTrue(np.isfinite(x).all())
                    self.assertGreater(float(np.max(np.abs(x))), .0001)
                    self.assertEqual(float(x[0]), 0)
                    self.assertEqual(float(x[-1]), 0)
        for note, expected in [(69, 440), (81, 880)]:
            x = voice({"patch": "melody", "duration": 2, "seed": 1, "note": note}, .5)
            x = x[4800:24000]
            spec = np.abs(np.fft.rfft(x * np.hanning(len(x))))
            peak = np.fft.rfftfreq(len(x), 1 / 48000)[np.argmax(spec)]
            self.assertAlmostEqual(peak, expected, delta=3)

    def test_custom_kick_track_drives_ducking(self):
        from engine import duck_envelope
        score = validate_score(small_score())
        duck = duck_envelope(score["events"], score["frames"], .5)
        self.assertGreater(float(duck[480]), .5)
        self.assertLess(float(duck[24000]), .02)

    def test_render_reproducibility_stems_and_delivery_limit(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            score_path = root / "score.json"
            score_path.write_text(json.dumps(small_score()))
            for name in ["first", "second"]:
                output = root / name
                result = subprocess.run([sys.executable, str(SCRIPTS / "render.py"), str(score_path),
                                         "--output", str(output), "--stems", "--lufs", "-17", "--max-bytes", "90000"],
                                        capture_output=True, text=True, timeout=120)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                report = json.loads((output / "analysis.json").read_text())
                self.assertEqual(report["clipped_samples"], 0)
                self.assertAlmostEqual(report["duration_seconds"], 7, places=4)
                self.assertLessEqual(float(report["loudness"]["master"]["input_tp"]), -1)
                self.assertLessEqual((output / "mix.mp3").stat().st_size, 90000)
                self.assertEqual(report["loudness"]["target_lufs"], -17)
                info = json.loads(subprocess.check_output(["ffprobe", "-v", "error", "-show_streams", "-of", "json", str(output / "master.wav")]))
                self.assertEqual(info["streams"][0]["bits_per_raw_sample"], "24")
                self.assertEqual(info["streams"][0]["sample_rate"], "48000")
                self.assertEqual(len(list((output / "stems").glob("*.wav"))), 5)
                with zipfile.ZipFile(output / "project.zip") as bundle:
                    self.assertIsNone(bundle.testzip())
                    self.assertIn("music-project/scripts/engine.py", bundle.namelist())
            for name in ["master.wav", "mix.mp3", "score.mid"]:
                self.assertEqual((root / "first" / name).read_bytes(), (root / "second" / name).read_bytes())
            with zipfile.ZipFile(root / "first/project.zip") as bundle:
                bundle.extractall(root / "restored")
            restored = root / "restored/music-project"
            instructions = (restored / "REPRODUCE.txt").read_text()
            command = next(line.removeprefix("Run: ") for line in instructions.splitlines() if line.startswith("Run: "))
            result = subprocess.run([sys.executable, *shlex.split(command)[1:]], cwd=restored,
                                    capture_output=True, text=True, timeout=120)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            for name in ["master.wav", "mix.mp3"]:
                self.assertEqual((root / "first" / name).read_bytes(), (restored / "audio" / name).read_bytes())
            before = hashlib.sha256((root / "first/master.wav").read_bytes()).hexdigest()
            result = subprocess.run([sys.executable, str(SCRIPTS / "render.py"), str(score_path), "--output", str(root / "first")],
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(before, hashlib.sha256((root / "first/master.wav").read_bytes()).hexdigest())


if __name__ == "__main__":
    unittest.main()

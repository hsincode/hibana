import copy
import io
import json
import math
from pathlib import Path
import shlex
import struct
import subprocess
import sys
import tempfile
import threading
import unittest
import wave
import zipfile
from http.server import BaseHTTPRequestHandler, HTTPServer

from test_music import HAS_AUDIO, SCRIPTS, small_score
from score import export_midi, validate_score
from sing import Client, FRAME_RATE, fingerprint, load_vocals, prepare, vocal_plan, wav_frames


def singing_score():
    raw = small_score()
    raw["tracks"]["theme"] = {"patch": "vocal", "gain": .65}
    raw["events"] = [e for e in raw["events"] if e["track"] != "theme"]
    raw["events"] += [{"track": "theme", "beat": beat, "note": note, "duration": .6, "lyric": lyric}
                      for beat, note, lyric in [(1, 65, "あ"), (3, 67, "し"), (5, 69, "た")]]
    return raw


class TestEngine(BaseHTTPRequestHandler):
    """Exercise the real HTTP contract without downloading a model in CI."""
    calls = 0

    def log_message(self, *args):
        pass

    def reply(self, value):
        data = value if isinstance(value, bytes) else json.dumps(value).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        payloads = {
            "/version": "test-0.25.2",
            "/engine_manifest": {"frame_rate": FRAME_RATE, "supported_features": {"sing": True}},
            "/singers": [{"name": "Test voice", "speaker_uuid": "test", "version": "1",
                          "styles": [{"id": 6000, "name": "Normal", "type": "sing"},
                                     {"id": 3002, "name": "Hum", "type": "frame_decode"}]}],
        }
        self.reply(payloads[self.path])

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if self.path == "/sing_frame_audio_query?speaker=6000":
            self.server.queries.append(body)
            length = sum(n["frame_length"] for n in body["notes"])
            phonemes = [{"phoneme": "pau" if n["key"] is None else "a", "frame_length": n["frame_length"],
                         "note_id": n.get("id")} for n in body["notes"]]
            volume = [v for n in body["notes"] for v in [0 if n["key"] is None else .3] * n["frame_length"]]
            self.reply({"f0": [440] * length, "volume": volume, "phonemes": phonemes})
        elif self.path == "/frame_synthesis?speaker=6000":
            self.server.syntheses.append(body)
            length = round(len(body["f0"]) / FRAME_RATE * 48000)
            pcm = bytearray()
            for i in range(length):
                volume = body["volume"][min(len(body["volume"]) - 1, int(i / 48000 * FRAME_RATE))]
                pcm.extend(struct.pack("<h", round(32767 * volume * math.sin(2 * math.pi * 440 * i / 48000))))
            result = io.BytesIO()
            with wave.open(result, "wb") as output:
                output.setparams((1, 2, body["outputSamplingRate"], 0, "NONE", "not compressed"))
                output.writeframes(pcm)
            self.reply(result.getvalue())
        else:
            self.send_error(404)


class SingingTests(unittest.TestCase):
    def test_score_contract_and_frame_timing(self):
        raw = singing_score()
        score = validate_score(raw)
        self.assertEqual(score, validate_score(score))
        plan = vocal_plan(score)
        self.assertEqual(len(plan), 3)
        for phrase, event in zip(plan, [e for e in score["events"] if e["track"] == "theme"]):
            rest = phrase["notes"][0]
            self.assertIsNone(rest["key"])
            absolute = phrase["origin_frame"] + rest["frame_length"]
            self.assertAlmostEqual(absolute / FRAME_RATE, event["beat"] * .5, delta=.006)
        for field, bad in [("lyric", "あした"), ("lyric", "明日"), ("lyric", ""), ("beat", 0),
                           ("duration", .01), ("pan", .5), ("offset_seconds", .01), ("patch", "melody")]:
            changed = copy.deepcopy(raw)
            changed["events"][-1][field] = bad
            with self.subTest(field=field), self.assertRaises(ValueError):
                validate_score(changed)
        raw["events"][-1]["beat"] = 3.2
        with self.assertRaisesRegex(ValueError, "overlapping"):
            validate_score(raw)
        raw = singing_score()
        raw["bars"] = 8
        raw["events"] = [{"track": "theme", "beat": 1 + i, "note": 65, "duration": 1, "lyric": "きゃ"}
                         for i in range(24)]
        with self.assertRaisesRegex(ValueError, "breath"):
            vocal_plan(validate_score(raw))

    def test_vocal_fingerprint_and_midi_lyrics(self):
        score = validate_score(singing_score())
        original = fingerprint(score)
        changed = copy.deepcopy(score)
        changed["tracks"]["theme"]["gain"] = .1
        changed["events"][0]["note"] += 1  # accompaniment edit
        self.assertEqual(original, fingerprint(changed))
        next(e for e in changed["events"] if e["patch"] == "vocal")["lyric"] = "か"
        self.assertNotEqual(original, fingerprint(changed))
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "song.mid"
            export_midi(path, score)
            self.assertIn(b"\xff\x05\x03" + "し".encode(), path.read_bytes())

    def test_http_resume_integrity_offline_remix(self):
        server = HTTPServer(("127.0.0.1", 0), TestEngine)
        server.queries, server.syntheses = [], []
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                score = validate_score(singing_score())
                directory = root / "vocals"
                client = Client(f"http://127.0.0.1:{server.server_port}")
                self.assertEqual(len(client.singers()), 1)
                result = prepare(score, directory, client, through=1)
                self.assertFalse(result["complete"])
                self.assertFalse((directory / "manifest.json").exists())
                result = prepare(score, directory, client, through=3)
                self.assertTrue(result["complete"])
                self.assertEqual(len(server.queries), 3)
                self.assertEqual(len(server.syntheses), 3)
                self.assertAlmostEqual(max(server.syntheses[0]["volume"]), .3 * .8)
                manifest = load_vocals(directory, score)
                self.assertEqual(manifest["credits"], ["VOICEVOX:Test voice"])
                samples = struct.unpack(f"<{score['frames']}h", wav_frames((directory / "theme.wav").read_bytes()))
                self.assertEqual(max(abs(s) for s in samples[:20000]), 0)
                self.assertGreater(max(abs(s) for s in samples[24000:38000]), 1000)
                # Completed preparations must work without a running engine.
                prepare(score, directory, Client("http://127.0.0.1:1"))
                changed = copy.deepcopy(score)
                next(e for e in changed["events"] if e["patch"] == "vocal")["note"] += 1
                with self.assertRaisesRegex(ValueError, "another score"):
                    prepare(changed, directory, client)
                if HAS_AUDIO:
                    source = root / "score.json"
                    source.write_text(json.dumps(score))
                    result = subprocess.run([sys.executable, str(SCRIPTS / "render.py"), str(source),
                                             "--vocals", str(directory), "--output", str(root / "audio")],
                                            capture_output=True, text=True, timeout=120)
                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                    with zipfile.ZipFile(root / "audio/project.zip") as bundle:
                        self.assertIsNone(bundle.testzip())
                        bundle.extractall(root / "restored")
                    restored = root / "restored/music-project"
                    report = json.loads((restored / "analysis.json").read_text())
                    result = subprocess.run([sys.executable, *shlex.split(report["reproduce_command"])[1:]],
                                            cwd=restored, capture_output=True, text=True, timeout=120)
                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                    self.assertEqual((root / "audio/master.wav").read_bytes(), (restored / "audio/master.wav").read_bytes())
                    info = json.loads(subprocess.check_output(["ffprobe", "-v", "error", "-show_format", "-of", "json",
                                                              str(root / "audio/mix.mp3")]))
                    self.assertEqual(info["format"]["tags"]["comment"], "VOICEVOX:Test voice")
                (directory / "theme.wav").write_bytes(b"truncated")
                with self.assertRaisesRegex(ValueError, "checksum"):
                    load_vocals(directory, score)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == "__main__":
    unittest.main()

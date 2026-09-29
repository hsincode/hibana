import copy
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import struct
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "render.py"
spec = importlib.util.spec_from_file_location("video_render", SCRIPT)
render = importlib.util.module_from_spec(spec)
spec.loader.exec_module(render)


class ValidationTests(unittest.TestCase):
    def test_numbers_and_paths(self):
        for value in [float("nan"), float("inf"), True, "1", -1]:
            with self.assertRaises(ValueError):
                render.number(value, 0, 10, "test")
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for value in ["../escape", "/etc/passwd", "https://example.com/v.mp4", "missing"]:
                with self.assertRaises(ValueError):
                    render.media_path(root, value)

    def test_literal_subtitle_tags_and_time_rounding(self):
        self.assertEqual(render.ass_time(59.999), "0:01:00.00")
        escaped = render.ass_text(r"{\pos(0,0)}" + "\n日本語")
        self.assertNotIn(r"\pos", escaped)
        self.assertIn(r"\N", escaped)


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "FFmpeg required for render integration")
class RenderTests(unittest.TestCase):
    def setUp(self):
        try:
            from PIL import Image
        except ImportError:
            self.skipTest("Pillow required for contact sheet")
        self.tmp = tempfile.TemporaryDirectory(prefix="ds-video-smoke-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.ffmpeg("-f", "lavfi", "-i", "color=red:s=160x240:r=10:d=3",
                    "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", self.root / "a.mp4")
        self.ffmpeg("-f", "lavfi", "-i", "color=blue:s=240x160:r=10:d=3",
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", self.root / "b.mp4")
        self.ffmpeg("-f", "lavfi", "-i", "sine=frequency=220:duration=5", self.root / "music.wav")
        Image.new("RGBA", (60, 40), (0, 255, 0, 180)).save(self.root / "logo.png")
        Image.new("RGB", (160, 240), "yellow").save(self.root / "still.png")
        self.project = {
            "version": 1, "width": 160, "height": 240, "fps": 10,
            "clips": [{"src": "a.mp4", "in": 0.2, "duration": 1.5, "zoom": [1, 1.15]},
                      {"src": "b.mp4", "duration": 1.5, "speed": 1.5, "fit": "contain",
                       "transition": {"type": "fade", "duration": 0.3}},
                      {"src": "still.png", "duration": 0.5}],
            "overlays": [{"src": "logo.png", "start": 0.1, "duration": 1.5, "width": 0.3,
                          "x": 0, "y": 0, "end_x": 1, "fade": 0.1}],
            "captions": [{"start": 0.2, "end": 1.2, "text": "日本語テスト"},
                         {"start": 1.3, "end": 2.5, "text": "Word highlight",
                          "words": [{"start": 1.3, "end": 1.7, "text": "Word "},
                                    {"start": 1.8, "end": 2.5, "text": "highlight"}]}],
            "caption_style": {"size": 18, "margin": 20, "animation": "pop"},
            "audio": [{"src": "music.wav", "start": 0, "duration": 3.2, "volume": 0.2,
                       "fade_in": 0.1, "fade_out": 0.2, "duck": True}],
        }

    def ffmpeg(self, *args):
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-threads", "1", *map(str, args)],
                       check=True, capture_output=True, timeout=60)

    def test_render_timing_pixels_audio_and_preview(self):
        (self.root / "timeline.json").write_text(json.dumps(self.project))
        result = subprocess.run(["python3", str(SCRIPT), str(self.root / "timeline.json"), "--preview"],
                                capture_output=True, text=True, timeout=120)
        self.assertEqual(result.returncode, 0, result.stderr)
        state = json.loads((self.root / "output/status.json").read_text())
        self.assertEqual(state["state"], "completed")
        output = self.root / state["video"]
        info = render.probe(output)
        self.assertAlmostEqual(float(info["format"]["duration"]), 3.2, delta=0.15)
        video = next(s for s in info["streams"] if s["codec_type"] == "video")
        self.assertEqual((video["width"], video["height"]), (160, 240))
        self.assertTrue(any(s["codec_type"] == "audio" for s in info["streams"]))
        pcm = subprocess.run(["ffmpeg", "-v", "error", "-i", str(output), "-vn", "-f", "f32le", "-ac", "1", "pipe:1"],
                             capture_output=True, check=True, timeout=30).stdout
        samples = struct.unpack(f"<{len(pcm) // 4}f", pcm)
        self.assertGreater(sum(x * x for x in samples) / len(samples), 0.00001)
        from PIL import Image, ImageStat
        sheet = Image.open(self.root / "output/contact-sheet.jpg")
        self.assertGreater(sum(ImageStat.Stat(sheet).var), 1000)
        # Real decoded frames: the first shot is red, the last still is yellow.
        for at, expect in [(0.05, "red"), (3.05, "yellow")]:
            path = self.root / f"{expect}.png"
            self.ffmpeg("-ss", at, "-i", output, "-frames:v", "1", path)
            with Image.open(path) as image:
                red, green, blue = image.convert("RGB").getpixel((80, 100))
                self.assertGreater(red, 180)
                self.assertLess(blue, 60)
                if expect == "yellow":
                    self.assertGreater(green, 180)
                else:
                    self.assertLess(green, 60)
        self.assertFalse(list(self.root.glob(".render-*")))

    def test_full_resolution_export(self):
        project = {"version": 1, "width": 1080, "height": 1920, "fps": 10,
                   "clips": [{"src": "still.png", "duration": 0.5, "zoom": [1, 1.05]}],
                   "captions": [{"start": 0, "end": 0.5, "text": "日本語の字幕"}]}
        (self.root / "timeline.json").write_text(json.dumps(project))
        result = subprocess.run(["python3", str(SCRIPT), str(self.root / "timeline.json")],
                                capture_output=True, text=True, timeout=120)
        self.assertEqual(result.returncode, 0, result.stderr)
        info = render.probe(self.root / "output/final.mp4")
        video = next(s for s in info["streams"] if s["codec_type"] == "video")
        self.assertEqual((video["width"], video["height"]), (1080, 1920))

    @unittest.skipUnless(os.environ.get("VIDEO_TEST_ASR") == "1", "opt-in model download / CPU ASR")
    def test_real_cpu_transcription(self):
        self.ffmpeg("-f", "lavfi", "-i", "color=green:s=160x240:r=10:d=10",
                    "-f", "lavfi", "-i", "flite=text='Hello world. This is a video editing test.':voice=slt",
                    "-c:v", "libx264", "-c:a", "aac", "-shortest", self.root / "speech.mp4")
        duration = float(render.probe(self.root / "speech.mp4")["format"]["duration"])
        project = {"version": 1, "width": 160, "height": 240, "fps": 10,
                   "clips": [{"src": "speech.mp4", "duration": duration - 0.1}],
                   "caption_style": {"size": 18, "margin": 20},
                   "transcribe": {"language": "en", "model": "tiny"}}
        (self.root / "timeline.json").write_text(json.dumps(project))
        result = subprocess.run(["python3", str(SCRIPT), str(self.root / "timeline.json"), "--preview"],
                                capture_output=True, text=True, timeout=600)
        self.assertEqual(result.returncode, 0, result.stderr)
        captions = json.loads((self.root / "output/captions.json").read_text())
        self.assertTrue(captions)
        self.assertTrue(any(c["words"] for c in captions))
        self.assertIn("test", " ".join(c["text"].lower() for c in captions))

    def test_invalid_timing_is_rejected_before_encoding(self):
        for mutate in [
            lambda p: p["clips"][0].update(duration=8),
            lambda p: p["clips"][0].update(transition={"type": "fade", "duration": 0.2}),
            lambda p: p["clips"][1].update(transition={"type": "unknown", "duration": 0.2}),
            lambda p: p["captions"][0].update(end=99),
            lambda p: p["audio"][0].update(duration=9),
        ]:
            project = copy.deepcopy(self.project)
            mutate(project)
            with self.assertRaises(ValueError):
                render.validate(project, self.root)


if __name__ == "__main__":
    unittest.main()

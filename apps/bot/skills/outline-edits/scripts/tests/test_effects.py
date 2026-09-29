"""Regression checks for portable effects and timestamp-aware video inspection."""
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("outline_effects", ROOT / "scripts/edit_effects.py")
fx = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fx)


class EffectsTests(unittest.TestCase):
    def setUp(self):
        self.preset = fx.load_preset()

    def test_shake_preserves_frames_outside_the_pulse(self):
        image = np.random.default_rng(42).integers(0, 256, (60, 100, 3), dtype=np.uint8)
        for time_s in (-0.1, 0.7):
            np.testing.assert_array_equal(fx.apply_shake(image, time_s, [0], self.preset), image)
        np.testing.assert_array_equal(fx.apply_shake(image, 0.1, [0], self.preset, strength=0), image)

    def test_shake_changes_both_landscape_and_portrait_frames(self):
        for size in ((160, 90), (90, 160)):
            with self.subTest(size=size):
                image = Image.new("RGB", size)
                ImageDraw.Draw(image).rectangle((10, 10, size[0]-10, size[1]-10), outline="white", width=2)
                result = fx.apply_shake(image, 0.1, [0], self.preset)
                self.assertEqual(result.shape, (size[1], size[0], 3))
                self.assertGreater(np.mean(np.abs(result.astype(float) - np.asarray(image))), 1)

    def test_blur_does_not_add_dark_transparent_fringes(self):
        image = Image.new("RGBA", (160, 90))
        ImageDraw.Draw(image).rectangle((45, 25, 65, 65), fill="white")
        result = np.asarray(fx.directional_blur_rgba(image, (18, 0)))
        visible = result[..., 3] > 0
        self.assertGreater(np.count_nonzero(visible), 21*41)
        self.assertTrue((result[..., :3][visible] >= 254).all())

    def test_opaque_subject_occludes_text_but_transparent_background_does_not(self):
        text = Image.new("RGBA", (50, 50), "white")
        subject = Image.new("RGBA", (50, 50))
        ImageDraw.Draw(subject).rectangle((10, 10, 30, 30), fill=(0, 0, 0, 255))
        result = fx.composite_layers([text], subject)
        self.assertEqual(result.getpixel((20, 20)), (0, 0, 0))
        self.assertEqual(result.getpixel((0, 0)), (255, 255, 255))

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "FFmpeg and FFprobe required")
    def test_inspection_uses_actual_variable_frame_timestamps(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            video = folder / "vfr.mp4"
            subprocess.run([
                "ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=64x36:rate=30:duration=0.6",
                "-vf", "select='eq(n,0)+eq(n,6)+eq(n,15)'", "-fps_mode", "vfr", "-an", "-c:v", "libx264", str(video),
            ], check=True, capture_output=True)
            subprocess.run([
                sys.executable, str(ROOT / "scripts/reference_frames.py"), str(video), str(folder / "check"),
                "--range", "0.19:0.21", "--overview-every", "0.3",
            ], check=True, capture_output=True)
            result = json.loads((folder / "check/frame-index.json").read_text(encoding="utf-8"))
            detail = [frame for frame in result["selection"] if frame["detail"]]
            self.assertEqual(result["frames"], 3)
            self.assertEqual(len(detail), 1)
            self.assertEqual(detail[0]["frame"], 1)
            self.assertAlmostEqual(detail[0]["time_seconds"], 0.2, places=5)
            self.assertTrue((folder / "check" / detail[0]["file"]).is_file())


if __name__ == "__main__":
    unittest.main()

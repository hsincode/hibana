#!/usr/bin/env python3
"""Render a versioned video timeline with FFmpeg/libass, using bounded CPU memory."""

import argparse
from fractions import Fraction
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time

TRANSITIONS = {"fade", "wipeleft", "wiperight", "slideleft", "slideright", "circleopen", "dissolve"}
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}
MAX_BYTES = 1_000_000_000


def number(value, lo, hi, name):
    if isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value):
        raise ValueError(f"{name}: expected finite number")
    if not lo <= value <= hi:
        raise ValueError(f"{name}: must be between {lo} and {hi}")
    return float(value)


def media_path(root, value):
    if not isinstance(value, str) or not value or Path(value).is_absolute():
        raise ValueError("src must be a relative local file")
    path = (root / value).resolve()
    if not path.is_relative_to(root.resolve()) or not path.is_file():
        raise ValueError(f"src outside project or missing: {value}")
    return path


def probe(path):
    proc = subprocess.run(["ffprobe", "-v", "error", "-show_format", "-show_streams",
                           "-of", "json", str(path)], capture_output=True, text=True, timeout=30)
    if proc.returncode:
        raise ValueError(f"Cannot probe {path.name}: {proc.stderr[-1000:]}")
    return json.loads(proc.stdout)


def validate(project, root):
    if project.get("version") != 1:
        raise ValueError("timeline version must be 1")
    if project.get("transcribe"):
        config = project["transcribe"]
        if not isinstance(config, dict) or config.get("model", "tiny") not in {"tiny", "base", "small"}:
            raise ValueError("transcribe.model: tiny/base/small only")
        language = config.get("language", "ja")
        if not isinstance(language, str) or not re.fullmatch(r"[a-z]{2,3}", language):
            raise ValueError("transcribe.language: ISO language code required")
    for key, default, low, high in [("width", 1080, 64, 1920), ("height", 1920, 64, 1920),
                                     ("fps", 30, 10, 60)]:
        value = number(project.get(key, default), low, high, key)
        if value != int(value) or (key != "fps" and int(value) % 2):
            raise ValueError(f"{key}: expected integer (even for dimensions)")
        project[key] = int(value)
    clips = project.get("clips", [])
    if not isinstance(clips, list) or not 1 <= len(clips) <= 60:
        raise ValueError("clips: expected 1..60 clips")
    total = 0
    previous_overlap = 0
    for i, clip in enumerate(clips):
        src = media_path(root, clip["src"])
        duration = number(clip.get("duration"), 0.2, 600, "clip.duration")
        speed = number(clip.get("speed", 1), 0.25, 4, "clip.speed")
        start = number(clip.get("in", 0), 0, 86400, "clip.in")
        number(clip.get("volume", 1), 0, 4, "clip.volume")
        for key, default, low, high in [("brightness", 0, -1, 1), ("contrast", 1, 0.1, 3),
                                         ("saturation", 1, 0, 3)]:
            number(clip.get(key, default), low, high, key)
        if clip.get("fit", "cover") not in {"cover", "contain"}:
            raise ValueError("clip.fit must be cover or contain")
        zoom = clip.get("zoom", [1, 1])
        if not isinstance(zoom, list) or len(zoom) != 2:
            raise ValueError("zoom must be [start, end]")
        for v in zoom:
            number(v, 1, 3, "zoom")
        info = probe(src)
        if not any(s["codec_type"] == "video" for s in info["streams"]):
            raise ValueError(f"clip has no video: {src.name}")
        if src.suffix.lower() not in IMAGE_EXTS:
            available = float(info["format"].get("duration", 0))
            if start + duration * speed > available + 0.08:
                raise ValueError(f"clip {i}: in + duration * speed exceeds source ({available}s)")
        transition = clip.get("transition", {})
        overlap = number(transition.get("duration", 0), 0, 2, "transition.duration")
        if overlap:
            if not i or transition.get("type", "fade") not in TRANSITIONS:
                raise ValueError("transition belongs on an incoming clip, with a supported type")
            if overlap + previous_overlap >= clips[i - 1]["duration"] or overlap >= duration:
                raise ValueError("transitions must not consume the adjacent clips")
        previous_overlap = overlap
        total += duration - overlap
    number(total, 0.2, 600, "total duration")
    for key, limit in [("overlays", 12), ("audio", 12), ("captions", 2000)]:
        entries = project.get(key, [])
        if not isinstance(entries, list) or len(entries) > limit:
            raise ValueError(f"{key}: max {limit} entries")
        for entry in entries:
            start = number(entry.get("start", 0), 0, total, f"{key}.start")
            if key == "captions":
                end = number(entry.get("end"), start + 0.01, total + 0.1, "caption.end")
                if not isinstance(entry.get("text"), str) or len(entry["text"]) > 1000:
                    raise ValueError("caption.text: expected text up to 1000 characters")
                words = entry.get("words", [])
                if not isinstance(words, list) or len(words) > 200:
                    raise ValueError("caption.words: max 200 words")
                last = start
                for word in words:
                    a = number(word["start"], last, end, "word.start")
                    last = number(word["end"], a, end, "word.end")
                    if not isinstance(word["text"], str):
                        raise ValueError("word.text must be text")
                continue
            src = media_path(root, entry["src"])
            duration = number(entry.get("duration", total - start), 0.01, total - start + 0.1, "duration")
            offset = number(entry.get("in", 0), 0, 86400, "in")
            info = probe(src)
            expected = "video" if key == "overlays" else "audio"
            if not any(s["codec_type"] == expected for s in info["streams"]):
                raise ValueError(f"{src.name}: no {expected} stream")
            if src.suffix.lower() not in IMAGE_EXTS and offset + duration > float(info["format"].get("duration", 0)) + 0.08:
                raise ValueError(f"{key}: source too short; trim duration or supply longer media")
            if key == "overlays":
                for axis in ["x", "y", "end_x", "end_y"]:
                    number(entry.get(axis, entry.get(axis.removeprefix("end_"), 0)), 0, 1, axis)
                number(entry.get("width", 0.3), 0.05, 1, "overlay.width")
                number(entry.get("fade", 0), 0, duration / 2, "overlay.fade")
            else:
                number(entry.get("volume", 1), 0, 4, "audio.volume")
                for f in ["fade_in", "fade_out"]:
                    number(entry.get(f, 0), 0, duration / 2, f)
                if not isinstance(entry.get("duck", False), bool):
                    raise ValueError("audio.duck must be boolean")
    style = project.get("caption_style", {})
    number(style.get("size", 64), 12, 160, "caption size")
    number(style.get("margin", min(160, project["height"] / 4)), 0, project["height"] / 2, "caption margin")
    if style.get("animation", "fade") not in {"fade", "pop", "none"}:
        raise ValueError("caption animation must be fade, pop or none")
    return total


def atomic_json(path, data):
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2))
    tmp.replace(path)


def ass_time(seconds):
    centis = round(seconds * 100)
    return f"{centis // 360000}:{centis // 6000 % 60:02}:{centis // 100 % 60:02}.{centis % 100:02}"


def ass_text(text):
    # ASS override tags must never be interpreted as part of transcript text.
    return text.replace("\\", "＼").replace("{", "｛").replace("}", "｝").replace("\n", r"\N")


def write_subtitles(project, captions, path):
    style = project.get("caption_style", {})
    size = style.get("size", 64)
    margin = style.get("margin", min(160, project["height"] / 4))
    header = (f"[Script Info]\nScriptType: v4.00+\nPlayResX: {project['width']}\n"
              f"PlayResY: {project['height']}\nWrapStyle: 0\n\n[V4+ Styles]\n"
              "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, "
              "Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, "
              "Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n"
              f"Style: Default,IPAGothic,{size},&H0000FFFF,&H00FFFFFF,&H00101010,&H80000000,"
              f"-1,0,0,0,100,100,0,0,1,3,1,2,50,50,{margin},1\n\n[Events]\n"
              "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n")
    rows = []
    for caption in captions:
        words = caption.get("words", [])
        if words:
            text, cursor = "", caption["start"]
            for word in words:
                gap = max(0, round((word["start"] - cursor) * 100))
                length = max(1, round((word["end"] - word["start"]) * 100))
                text += (f"{{\\k{gap}}}" if gap else "") + f"{{\\kf{length}}}" + ass_text(word["text"])
                cursor = word["end"]
        else:
            text = r"{\1c&HFFFFFF&}" + ass_text(caption["text"])
        animation = style.get("animation", "fade")
        if animation == "fade":
            text = r"{\fad(100,100)}" + text
        elif animation == "pop":
            text = r"{\fscx85\fscy85\t(0,120,\fscx100\fscy100)}" + text
        rows.append(f"Dialogue: 0,{ass_time(caption['start'])},{ass_time(caption['end'])},Default,,0,0,0,,{text}\n")
    path.write_text(header + "".join(rows))


class Renderer:
    def __init__(self, root, preview=False):
        self.root = root.resolve()
        self.out = self.root / "output"
        self.out.mkdir(exist_ok=True)
        self.work = Path(tempfile.mkdtemp(prefix=".render-", dir=self.root))
        self.preview = preview
        self.started = time.monotonic()
        self.state = {"state": "running", "stage": "validate", "progress": 0}

    def update(self, stage, progress):
        self.state.update(stage=stage, progress=round(progress, 3))
        atomic_json(self.out / "status.json", self.state)

    def run(self, args):
        log = self.work / "ffmpeg.log"
        command = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
                   "-threads", "1", "-filter_threads", "1", "-filter_complex_threads", "1"] + list(map(str, args))
        with log.open("w") as err:
            proc = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=err)
            try:
                while proc.poll() is None:
                    if time.monotonic() - self.started > 3500:
                        raise RuntimeError("render deadline exceeded (3500s)")
                    used = sum(p.stat().st_size for p in self.root.rglob("*") if p.is_file())
                    if used > MAX_BYTES or shutil.disk_usage(self.root).free < 256_000_000:
                        raise RuntimeError("render disk budget exceeded")
                    time.sleep(0.2)
                if proc.returncode:
                    raise RuntimeError(log.read_text()[-3000:])
            finally:
                if proc.poll() is None:
                    proc.kill()
                    proc.wait()

    def encode(self):
        return ["-c:v", "libx264", "-preset", "ultrafast" if self.preview else "veryfast",
                "-crf", "28" if self.preview else "21", "-pix_fmt", "yuv420p", "-threads", "1",
                "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2", "-movflags", "+faststart"]

    def render(self, project):
        total = validate(project, self.root)
        w, h, fps = project["width"], project["height"], project["fps"]
        if self.preview:
            ratio = min(1, 640 / max(w, h))
            w, h = max(64, round(w * ratio / 2) * 2), max(64, round(h * ratio / 2) * 2)
        clips = project["clips"]
        normalized = []
        for i, clip in enumerate(clips):
            self.update(f"clip {i + 1}/{len(clips)}", 0.05 + 0.45 * i / len(clips))
            src = media_path(self.root, clip["src"])
            duration, speed = clip["duration"], clip.get("speed", 1)
            args = []
            if src.suffix.lower() in IMAGE_EXTS:
                args += ["-loop", "1", "-framerate", fps]
            args += ["-ss", clip.get("in", 0), "-t", duration * speed, "-i", src]
            has_audio = any(s["codec_type"] == "audio" for s in probe(src)["streams"])
            if not has_audio:
                args += ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"]
            if clip.get("fit", "cover") == "cover":
                fit = f"scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h}"
            else:
                fit = f"scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2"
            vf = f"setpts=(PTS-STARTPTS)/{speed},fps={fps},{fit},setsar=1"
            z0, z1 = clip.get("zoom", [1, 1])
            if (z0, z1) != (1, 1):
                frames = max(1, round(duration * fps) - 1)
                vf += (f",zoompan=z='{z0}+({z1}-{z0})*min(on/{frames},1)':"
                       f"x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=1:s={w}x{h}:fps={fps}")
            vf += (f",eq=brightness={clip.get('brightness', 0)}:contrast={clip.get('contrast', 1)}:"
                   f"saturation={clip.get('saturation', 1)},format=yuv420p,settb=AVTB")
            tempo, remaining = [], speed
            while remaining > 2:
                tempo.append("atempo=2")
                remaining /= 2
            while remaining < 0.5:
                tempo.append("atempo=0.5")
                remaining /= 0.5
            tempo.append(f"atempo={remaining}")
            af = ",".join(["asetpts=PTS-STARTPTS", *tempo, f"volume={clip.get('volume', 1)}",
                           "aresample=48000", "aformat=channel_layouts=stereo", "apad"])
            target = self.work / f"clip-{i}.mp4"
            graph = f"[0:v]{vf}[v];[{0 if has_audio else 1}:a]{af}[a]"
            self.run(args + ["-filter_complex", graph, "-map", "[v]", "-map", "[a]", "-t", duration,
                             *self.encode(), target])
            normalized.append(target)

        self.update("transitions", 0.5)
        base = self.work / "base.mp4"
        if len(clips) == 1:
            normalized[0].replace(base)
        else:
            args, graph = [], []
            for i, path in enumerate(normalized):
                args += ["-i", path]
                graph += [f"[{i}:v]settb=AVTB,setpts=PTS-STARTPTS[v{i}]",
                          f"[{i}:a]asetpts=PTS-STARTPTS[a{i}]"]
            v, a, elapsed = "v0", "a0", clips[0]["duration"]
            for i, clip in enumerate(clips[1:], 1):
                transition = clip.get("transition", {})
                overlap = transition.get("duration", 0)
                nv, na = f"joinedv{i}", f"joineda{i}"
                if overlap:
                    kind = transition.get("type", "fade")
                    graph += [f"[{v}][v{i}]xfade=transition={kind}:duration={overlap}:offset={elapsed - overlap}[{nv}]",
                              f"[{a}][a{i}]acrossfade=d={overlap}:c1=tri:c2=tri[{na}]"]
                else:
                    graph += [f"[{v}][{a}][v{i}][a{i}]concat=n=2:v=1:a=1[{nv}][{na}]"]
                v, a = nv, na
                elapsed += clip["duration"] - overlap
            self.run(args + ["-filter_complex", ";".join(graph), "-map", f"[{v}]", "-map", f"[{a}]",
                             "-t", total, *self.encode(), base])
            for path in normalized:
                path.unlink()

        captions = list(project.get("captions", []))
        if project.get("transcribe"):
            self.update("transcribing (CPU)", 0.6)
            captions += self.transcribe(base, project["transcribe"])
        atomic_json(self.out / "captions.json", captions)
        ass = self.work / "captions.ass"
        write_subtitles(project, captions, ass)
        self.update("compositing and audio", 0.75)
        args, graph, index, video, audio = ["-i", base], [], 1, "0:v", "0:a"
        for overlay in project.get("overlays", []):
            src = media_path(self.root, overlay["src"])
            start = overlay.get("start", 0)
            duration = overlay.get("duration", total - start)
            if src.suffix.lower() in IMAGE_EXTS:
                args += ["-loop", "1", "-framerate", fps]
            args += ["-ss", overlay.get("in", 0), "-t", duration, "-i", src]
            width = max(2, round(w * overlay.get("width", 0.3) / 2) * 2)
            filt = f"fps={fps},scale={width}:-2,format=rgba,setpts=PTS-STARTPTS"
            fade = overlay.get("fade", 0)
            if fade:
                filt += f",fade=t=in:st=0:d={fade}:alpha=1,fade=t=out:st={duration - fade}:d={fade}:alpha=1"
            graph.append(f"[{index}:v]{filt},setpts=PTS+{start}/TB[ov{index}]")
            coords = []
            for axis, extent in [("x", "W-w"), ("y", "H-h")]:
                a0, a1 = overlay.get(axis, 0), overlay.get(f"end_{axis}", overlay.get(axis, 0))
                coords.append(f"({extent})*({a0}+({a1}-{a0})*clip((t-{start})/{duration},0,1))")
            out = f"overlay{index}"
            graph.append(f"[{video}][ov{index}]overlay=x='{coords[0]}':y='{coords[1]}':eof_action=pass:"
                         f"enable='between(t,{start},{start + duration})'[{out}]")
            video, index = out, index + 1
        tracks, ducked = [], []
        for track in project.get("audio", []):
            start = track.get("start", 0)
            duration = track.get("duration", total - start)
            args += ["-ss", track.get("in", 0), "-t", duration, "-i", media_path(self.root, track["src"])]
            filt = f"asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,volume={track.get('volume', 1)}"
            for key, kind, pos in [("fade_in", "in", 0), ("fade_out", "out", duration - track.get("fade_out", 0))]:
                if track.get(key, 0):
                    filt += f",afade=t={kind}:st={pos}:d={track[key]}"
            filt += f",adelay={round(start * 1000)}:all=1,apad,atrim=duration={total}"
            label = f"track{index}"
            graph.append(f"[{index}:a]{filt}[{label}]")
            (ducked if track.get("duck") else tracks).append(label)
            index += 1
        if tracks:
            graph.append(f"[{audio}]" + "".join(f"[{a}]" for a in tracks) +
                         f"amix=inputs={len(tracks) + 1}:duration=first:normalize=0[voice]")
            audio = "voice"
        if ducked:
            graph.append(f"[{audio}]asplit=2[voiceout][control]")
            graph.append("".join(f"[{a}]" for a in ducked) +
                         f"amix=inputs={len(ducked)}:duration=longest:normalize=0[music]")
            graph.append("[music][control]sidechaincompress=threshold=0.025:ratio=8:attack=20:release=300[ducked]")
            graph.append("[voiceout][ducked]amix=inputs=2:duration=first:normalize=0[mixed]")
            audio = "mixed"
        if captions:
            # Relative, generated path avoids FFmpeg filter escaping user filenames.
            graph.append(f"[{video}]ass={ass.relative_to(self.root).as_posix()}[captioned]")
            video = "captioned"
        graph += [f"[{video}]format=yuv420p[finalv]", f"[{audio}]alimiter=limit=0.95:latency=1[finala]"]
        target = self.out / ("preview.mp4" if self.preview else "final.mp4")
        pending = self.work / "result.mp4"
        self.run(args + ["-filter_complex", ";".join(graph), "-map", "[finalv]", "-map", "[finala]",
                         "-t", total, *self.encode(), pending])
        pending.replace(target)
        self.update("contact sheet", 0.95)
        self.contact_sheet(target, total)
        self.state.update(state="completed", progress=1, stage="done", duration=total,
                          video=f"output/{target.name}", contact_sheet="output/contact-sheet.jpg",
                          elapsed_seconds=round(time.monotonic() - self.started, 1), bytes=target.stat().st_size)
        atomic_json(self.out / "status.json", self.state)
        return self.state

    def contact_sheet(self, video, duration):
        from PIL import Image, ImageDraw
        stream = next(s for s in probe(video)["streams"] if s["codec_type"] == "video")
        fps = float(Fraction(stream["avg_frame_rate"]))
        count = int(stream.get("nb_frames", max(1, int(duration * fps))))
        frames = []
        for i in range(6):
            # Seeking past the last frame's timestamp can succeed without writing
            # an image, especially for sub-second clips. Pick actual frame times.
            at = min(count - 1, int(count * (i + 0.5) / 6)) / fps
            path = self.work / f"frame-{i}.jpg"
            self.run(["-ss", max(0, at - 0.00001), "-i", video, "-frames:v", "1", "-vf", "scale=320:-2", path])
            with Image.open(path) as frame:
                frame = frame.convert("RGB")
                ImageDraw.Draw(frame).text((8, 8), f"{at:.2f}s", fill="white", stroke_width=2, stroke_fill="black")
                frames.append(frame)
        width, height = frames[0].size
        sheet = Image.new("RGB", (width * 3, (height + 4) * 2), "#222222")
        for i, frame in enumerate(frames):
            sheet.paste(frame, ((i % 3) * width, (i // 3) * (height + 4)))
        sheet.save(self.out / "contact-sheet.jpg", quality=85)

    def transcribe(self, base, config):
        from faster_whisper import WhisperModel
        from faster_whisper.utils import download_model
        model = config.get("model", "tiny")
        if model not in {"tiny", "base", "small"}:
            raise ValueError("transcribe.model: tiny/base/small only on this CPU worker")
        language = config.get("language", "ja")
        if not isinstance(language, str) or not re.fullmatch(r"[a-z]{2,3}", language):
            raise ValueError("transcribe.language: ISO language code required")
        cache = os.environ.get("VIDEO_MODEL_CACHE", "/tmp/whisper")
        # local_dir stores actual files instead of HF's cache symlinks. Persistent
        # project quotas intentionally reject links that could cross scope roots.
        model_path = Path(cache) / model
        if not (model_path / ".ready").exists():
            download_model(model, output_dir=str(model_path))
            (model_path / ".ready").touch()
        engine = WhisperModel(str(model_path), device="cpu", compute_type="int8", cpu_threads=1, num_workers=1)
        segments, _ = engine.transcribe(str(base), language=language, word_timestamps=True, beam_size=1)
        return [{"start": s.start, "end": s.end, "text": s.text,
                 "words": [{"start": w.start, "end": w.end, "text": w.word} for w in (s.words or [])]}
                for s in segments]


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("timeline", type=Path)
    ap.add_argument("--preview", action="store_true")
    ap.add_argument("--validate", action="store_true")
    args = ap.parse_args()
    root = args.timeline.resolve().parent
    project = json.loads(args.timeline.read_text())
    os.chdir(root)
    if args.validate:
        print(json.dumps({"valid": True, "duration": validate(project, root)}))
        return
    renderer = Renderer(root, args.preview)
    try:
        print(json.dumps(renderer.render(project), ensure_ascii=False))
    except Exception as exc:
        renderer.state.update(state="failed", error=str(exc)[-3000:])
        atomic_json(renderer.out / "status.json", renderer.state)
        print(str(exc), file=sys.stderr)
        sys.exit(1)
    finally:
        shutil.rmtree(renderer.work)


if __name__ == "__main__":
    main()

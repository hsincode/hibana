"""Offline synthesis and mixing engine, derived from the reviewed Afterlight production."""

import gc
import json
import math
from pathlib import Path
import resource
import subprocess
import time

import numpy as np

from score import SAMPLE_RATE

SR = SAMPLE_RATE
TAU = 2 * np.pi


def clock_array(seconds):
    return np.arange(max(1, round(seconds * SR)), dtype=np.float32) / SR


def finish(x):
    x = np.asarray(x, dtype=np.float32)
    ramp = min(len(x) // 2, round(SR * 0.004))
    if ramp:
        x[:ramp] *= np.linspace(0, 1, ramp, dtype=np.float32)
        x[-ramp:] *= np.linspace(1, 0, ramp, dtype=np.float32)
    return x


def band_noise(rng, length, low, high):
    size = 1 << (length - 1).bit_length()
    freq = np.fft.rfftfreq(size, 1 / SR)
    spectrum = np.fft.rfft(rng.standard_normal(size).astype(np.float32))
    curve = np.minimum(1, (freq / max(1, low)) ** 3)
    curve *= np.minimum(1, (high / np.maximum(freq, 1)) ** 4)
    spectrum *= curve
    noise = np.fft.irfft(spectrum, n=size)[:length].astype(np.float32)
    noise /= max(float(np.std(noise)), .0001)
    return noise


def envelope(t, gate, attack=.007, release=.16):
    return (1 - np.exp(-t / attack)) * np.exp(-np.maximum(0, t - gate) / release)


def voice(event, beat):
    patch = event["patch"]
    gate = event["duration"] * beat
    rng = np.random.default_rng(event["seed"])
    f = 440 * 2 ** ((event["note"] - 69) / 12)
    if patch == "kick":
        t = clock_array(.66)
        phase = TAU * (47 * t + 94 * .031 * (1 - np.exp(-t / .031)))
        body = np.sin(phase) * np.exp(-t / .165) * (1 - np.exp(-t / .0015))
        body += .16 * np.sin(phase * 2) * np.exp(-t / .05)
        click = band_noise(rng, len(t), 2300, 7600) * np.exp(-t / .006) * .095
        return finish(np.tanh(1.3 * body) * .82 + click)
    if patch in ("snare", "ghost"):
        t = clock_array(.35 if patch == "snare" else .16)
        noise = band_noise(rng, len(t), 1100, 10500)
        clap_env = np.zeros_like(t)
        for onset, scale in [(0, .42), (.009, .62), (.018, .90)]:
            clap_env += scale * np.exp(-np.maximum(t - onset, 0) / .022) * (t >= onset)
        clap_env += .42 * np.exp(-np.maximum(t - .025, 0) / .11) * (t >= .025)
        body = .50 * np.sin(TAU * (185 * t + 28 * .018 * (1 - np.exp(-t / .018)))) * np.exp(-t / .047)
        return finish(noise * clap_env * .36 + body)
    if patch in ("hat", "openhat", "shaker"):
        length, decay = {"hat": (.12, .024), "openhat": (.40, .10), "shaker": (.08, .016)}[patch]
        t = clock_array(length)
        noise = band_noise(rng, len(t), 6200 if patch != "shaker" else 4600, 14500)
        metallic = np.zeros_like(t)
        for hz in [4283, 6127, 7793, 9349, 11239]:
            metallic += np.sin(TAU * hz * t + rng.uniform(0, TAU)) * .036
        env = np.exp(-t / decay) * (1 - np.exp(-t / .0006))
        return finish((.38 * noise + metallic) * env)
    if patch == "rim":
        t = clock_array(.12)
        sig = np.sin(TAU * 1620 * t) * .38 + np.sin(TAU * 2371 * t) * .24
        sig += band_noise(rng, len(t), 900, 7500) * .15
        return finish(sig * np.exp(-t / .012))
    if patch == "tom":
        t = clock_array(.45)
        phase = TAU * (f * t + f * .5 * .025 * (1 - np.exp(-t / .025)))
        return finish((np.sin(phase) + .15 * np.sin(phase * 1.6)) * np.exp(-t / .10))
    if patch == "bass":
        t = clock_array(gate + .20)
        phase = TAU * f * t
        x = np.sin(phase) * .88
        for h in range(2, 8):
            x += .36 / h * np.sin(phase * h) * (.2 + .8 * np.exp(-t / (.06 + .15 / h)))
        return finish(np.tanh(x * 1.4) / 1.25 * envelope(t, gate, .006, .038))
    if patch == "keys":
        t = clock_array(gate + 1.6)
        phase = TAU * f * t
        mod = (1.55 * np.exp(-t / .16) + .16) * np.sin(phase * 2)
        x = np.sin(phase + mod) * np.exp(-t / 1.75)
        x += .19 * np.sin(phase * 3.997 + .3) * np.exp(-t / .28)
        x += .085 * np.sin(phase * 7.03) * np.exp(-t / .08)
        trem = .94 + .06 * np.sin(TAU * 4.7 * t + f)
        return finish(x * trem * envelope(t, gate, .003, .32))
    if patch == "pad":
        t = clock_array(gate + 1.9)
        x = np.zeros_like(t)
        # Additive oscillators stay below Nyquist and avoid aliasing from naive saw waves.
        for detune, gain in [(-.055, .30), (0, .42), (.049, .30)]:
            phase = TAU * f * 2 ** (detune / 12) * t
            phase += .006 * np.sin(TAU * .31 * t + f)
            for h in range(1, 7):
                if f * h < SR * .44:
                    x += gain / h ** 1.75 * np.sin(phase * h + h * .3)
        swell = .86 + .14 * np.sin(TAU * .19 * t + event["note"])
        return finish(x * envelope(t, gate, .48, .47) * swell)
    if patch in ("arpeggio", "bell", "reverse"):
        t = clock_array(gate + (1.6 if patch == "bell" else .85))
        phase = TAU * f * t
        x = np.sin(phase + .65 * np.exp(-t / .065) * np.sin(phase * 2)) * np.exp(-t / .24)
        x += .22 * np.sin(phase * 2.002) * np.exp(-t / .12)
        x += .09 * np.sin(phase * 3) * np.exp(-t / .075)
        if patch == "bell":
            x = np.sin(phase) * np.exp(-t / .70) + .24 * np.sin(phase * 2.004) * np.exp(-t / .28)
        if patch == "reverse":
            x = np.pad(x[:round(gate * SR)], (max(0, round(gate * SR) - len(x)), 0))[::-1]
        return finish(x * .85)
    if patch in ("melody", "softlead"):
        t = clock_array(gate + .38)
        vibrato = .0030 * (1 - np.exp(-t / .33)) * np.sin(TAU * 5.15 * t)
        phase = TAU * f * t + vibrato * (f / 5.15)
        x = np.sin(phase) * .71
        brightness = np.exp(-t / .16)
        for h in range(2, 7):
            gain = (.28 if patch == "melody" else .15) / h ** 1.3
            x += gain * (.35 + .65 * brightness) * np.sin(phase * h)
        x += .12 * np.sin(phase * 1.0018 + .18) + .12 * np.sin(phase * .9983 - .18)
        contour = .76 + .24 * np.exp(-t / .16)
        return finish(x * envelope(t, gate, .012, .083) * contour)
    if patch == "crash":
        t = clock_array(3.8)
        x = band_noise(rng, len(t), 5500, 13500)
        for hz in [3241, 4373, 5827, 8123]:
            x += .075 * np.sin(TAU * hz * t)
        return finish(x * np.exp(-t / .76) * .30)
    if patch == "riser":
        t = clock_array(gate)
        x = band_noise(rng, len(t), 1800, 9800)
        pulse = .75 + .25 * np.sin(TAU * (2 * t + .45 * t * t))
        return finish(x * (t / max(gate, .01)) ** 2.8 * pulse * .24)
    raise ValueError(patch)


def ffmpeg(args, capture=False):
    result = subprocess.run(["ffmpeg", "-hide_banner", "-nostdin", "-y", "-threads", "1", *map(str, args)],
                            check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    return result.stderr if capture else None


def save_float(path, samples):
    samples.astype("<f4", copy=False).tofile(path)


def filter_audio(samples, path, filters):
    save_float(path, samples)
    processed = path.with_suffix(".filtered.f32")
    ffmpeg(["-f", "f32le", "-ar", SR, "-ac", 2, "-i", path, "-af", filters,
            "-f", "f32le", "-c:a", "pcm_f32le", processed])
    result = np.fromfile(processed, dtype="<f4").reshape(-1, 2)
    if result.shape != samples.shape:
        raise RuntimeError(f"Filter changed length: {result.shape} != {samples.shape}")
    path.unlink()
    processed.unlink()
    return result


def duck_envelope(notes, frames, beat):
    duck = np.zeros(frames, dtype=np.float32)
    t = clock_array(.45)
    shape = np.exp(-t / .105) * (1 - np.exp(-t / .002))
    for e in notes:
        if e["patch"] != "kick":
            continue
        start = round(e["beat"] * beat * SR)
        end = min(frames, start + len(shape))
        duck[start:end] = np.maximum(duck[start:end], shape[:end-start] * e["velocity"])
    return duck


def convolve(signal, impulse):
    # Block convolution keeps 48 kHz stereo rendering within the existing 512 MiB sandbox.
    block = 32768
    size = 1 << (block + len(impulse) - 2).bit_length()
    kernel = np.fft.rfft(impulse, n=size)
    out = np.zeros(len(signal), dtype=np.float32)
    for start in range(0, len(signal), block):
        piece = signal[start:start + block]
        wet = np.fft.irfft(np.fft.rfft(piece, n=size) * kernel, n=size).astype(np.float32)
        length = min(len(out) - start, len(piece) + len(impulse) - 1)
        out[start:start + length] += wet[:length]
    return out


def reverb_ir(channel, seed):
    rng = np.random.default_rng(seed + 800 + channel)
    t = clock_array(2.7)
    ir = np.zeros_like(t)
    # Frequency-dependent decay: a diffuse hall with shorter treble and a dark tail.
    for low, high, decay, level in [(250, 1100, .52, .60), (1100, 3500, .38, .42), (3500, 8500, .21, .23)]:
        noise = band_noise(rng, len(t), low, high)
        ir += noise * np.exp(-t / decay) * (1 - np.exp(-t / .045)) * level
    ir[:round(.026 * SR)] = 0
    ir /= np.sqrt(np.sum(ir * ir))
    ir *= .63
    for delay, gain in [(.031, .25), (.047, .19), (.073, .13), (.109, .09), (.149, .06)]:
        ir[round((delay + channel * .0031) * SR)] += gain
    return ir


def render(out, score, keep_stems=False, vocals=None):
    notes = score["events"]
    TRACKS = score["tracks"]
    N = score["frames"]
    BEAT = 60 / score["bpm"]
    SECONDS = score["duration_seconds"]
    stems = out / "stems"
    work = out / "work"
    if keep_stems:
        stems.mkdir()
    work.mkdir()
    mix = np.zeros((N, 2), dtype=np.float32)
    verb_bus = np.zeros_like(mix)
    delay_bus = np.zeros_like(mix)
    duck = duck_envelope(notes, N, BEAT)
    levels = {}
    started = time.monotonic()
    for name, cfg in TRACKS.items():
        print(f"Rendering {name}...", flush=True)
        track = np.zeros_like(mix)
        events = [e for e in notes if e["track"] == name]
        if cfg["patch"] == "vocal":
            from sing import wav_frames
            if vocals is None:
                raise ValueError("Prepare singing with sing.py, then provide --vocals")
            pcm = wav_frames((vocals / f"{name}.wav").read_bytes(), N)
            sig = np.frombuffer(pcm, dtype="<i2").astype(np.float32) * (cfg["gain"] / 32768)
            angle = (cfg["pan"] + 1) * np.pi / 4
            track[:, 0] = sig * math.cos(angle)
            track[:, 1] = sig * math.sin(angle)
            del sig, pcm
        for e in ([] if cfg["patch"] == "vocal" else events):
            sig = voice(e, BEAT)
            start = max(0, round((e["beat"] * BEAT + e["offset_seconds"]) * SR))
            end = min(N, start + len(sig))
            if end <= start:
                continue
            angle = (e["pan"] + 1) * np.pi / 4
            sig = sig[:end-start] * (e["velocity"] * cfg["gain"])
            track[start:end, 0] += sig * math.cos(angle)
            track[start:end, 1] += sig * math.sin(angle)
        filters = f"highpass=f={cfg['hp']},lowpass=f={cfg['lp']}"
        if cfg["patch"] == "keys":
            filters += ",equalizer=f=2200:t=q:w=0.8:g=-1.5"
        if cfg["patch"] == "snare":
            filters += ",equalizer=f=3400:t=q:w=1.2:g=-2,acompressor=threshold=0.11:ratio=2.5:attack=0.5:release=45:makeup=1.35"
        if cfg["patch"] == "vocal":
            filters += ",equalizer=f=6500:t=q:w=0.8:g=-2,acompressor=threshold=0.12:ratio=2:attack=12:release=100:makeup=1.15"
        track = filter_audio(track, work / "track.f32", filters)
        if cfg.get("duck"):
            track *= (1 - cfg["duck"] * duck[:, None])
        levels[name] = {"events": len(events), "peak_dbfs": db(float(np.max(np.abs(track)))),
                        "rms_dbfs": db(float(np.sqrt(np.mean(track * track))))}
        mix += track
        if cfg["verb"]:
            for c in range(2):
                verb_bus[:, c] += track[:, c] * cfg["verb"]
        if cfg["delay"]:
            for c in range(2):
                delay_bus[:, c] += track[:, c] * cfg["delay"]
        if keep_stems:
            save_float(work / "stem.f32", track)
            ffmpeg(["-f", "f32le", "-ar", SR, "-ac", 2, "-i", work / "stem.f32", "-c:a", "pcm_f32le", stems / f"{name}.wav"])
            (work / "stem.f32").unlink()
        del track
        gc.collect()

    del duck
    print("Rendering tempo delay and diffuse hall...", flush=True)
    delay_bus = filter_audio(delay_bus, work / "delay.f32", "highpass=f=700,lowpass=f=4300")
    wet = np.zeros_like(mix)
    for i, (beats, gain) in enumerate([(0.75, .69), (1.5, .43), (2.25, .27), (3, .17), (3.75, .10), (4.5, .06)]):
        offset = round(beats * BEAT * SR)
        for c in range(2):
            source = 1-c if i % 2 == 0 else c
            wet[offset:, c] += delay_bus[:-offset, source] * gain
    mix += wet
    for c in range(2):
        verb_bus[:, c] += wet[:, c] * .18
    if keep_stems:
        save_float(work / "delay_stem.f32", wet)
        ffmpeg(["-f", "f32le", "-ar", SR, "-ac", 2, "-i", work / "delay_stem.f32", "-c:a", "pcm_f32le", stems / "delay_return.wav"])
        (work / "delay_stem.f32").unlink()
    del delay_bus, wet
    gc.collect()
    wet = np.zeros_like(mix)
    for c in range(2):
        signal = verb_bus[:, c] * .78 + verb_bus[:, 1-c] * .22
        wet[:, c] = convolve(signal, reverb_ir(c, score["seed"]))
        del signal
    del verb_bus
    mix += wet
    if keep_stems:
        save_float(work / "reverb_stem.f32", wet)
        ffmpeg(["-f", "f32le", "-ar", SR, "-ac", 2, "-i", work / "reverb_stem.f32", "-c:a", "pcm_f32le", stems / "hall_return.wav"])
        (work / "reverb_stem.f32").unlink()
    del wet
    gc.collect()
    save_float(work / "mix.f32", mix)
    del mix
    # Only gentle bus compression. Loudness normalization below preserves the quiet bridge.
    fade_duration = min(3.5, score['tail_seconds'])
    fade = SECONDS - fade_duration
    ffmpeg(["-f", "f32le", "-ar", SR, "-ac", 2, "-i", work / "mix.f32",
            "-af", f"highpass=f=25,equalizer=f=310:t=q:w=0.7:g=-1.0,acompressor=threshold=0.28:ratio=1.4:attack=25:release=180:makeup=1:knee=2.8,afade=t=in:d=0.035,afade=t=out:st={fade:.6f}:d={fade_duration:.6f}",
            "-c:a", "pcm_f32le", out / "premaster.wav"])
    (work / "mix.f32").unlink()
    work.rmdir()
    print(f"Synthesis and mix: {time.monotonic() - started:.1f}s", flush=True)
    return levels


def db(value):
    return round(20 * math.log10(max(value, 1e-12)), 3)


def loudness(path):
    log = ffmpeg(["-i", path, "-af", "loudnorm=I=-14:TP=-1.4:LRA=11:print_format=json", "-f", "null", "-"], capture=True)
    return json.JSONDecoder().raw_decode(log[log.rfind("{"):])[0]


def encode_delivery(source, destination, seconds, max_bytes, metadata):
    for rate in [320, 256, 224, 192, 160, 128, 112, 96, 80, 64, 48, 40, 32]:
        if seconds * rate * 1000 / 8 + 8192 > max_bytes:
            continue
        ffmpeg(["-i", source, "-c:a", "libmp3lame", "-b:a", f"{rate}k", *metadata, destination])
        if destination.stat().st_size <= max_bytes:
            return rate
    raise ValueError("MP3 cannot fit max-bytes; increase the limit or shorten the score")


def master(out, score, target_lufs=-14, max_bytes=7_500_000, credits=()):
    print("Measuring and mastering...", flush=True)
    measured = loudness(out / "premaster.wav")
    integrated = float(measured["input_i"])
    if not math.isfinite(integrated):
        raise ValueError("Mix is silent or too short to measure; check the score")
    gain = target_lufs - integrated
    metadata = ["-metadata", f"title={score['title']}", "-metadata", f"artist={score['artist']}"]
    if credits:
        metadata += ["-metadata", "comment=" + "; ".join(credits)]
    ffmpeg(["-i", out / "premaster.wav", "-af",
            f"volume={gain:.6f}dB,aresample=192000,alimiter=limit=0.851:attack=5:release=80:level=false:latency=true,aresample={SR}:dither_method=triangular_hp",
            "-c:a", "pcm_s24le", *metadata, out / "master.wav"])
    rate = encode_delivery(out / "master.wav", out / "mix.mp3", score["duration_seconds"], max_bytes, metadata)
    measured_master = loudness(out / "master.wav")
    measured_mp3 = loudness(out / "mix.mp3")
    # Lossy encoding can overshoot even a true-peak-limited master. Correct only the delivery copy.
    peak = float(measured_mp3["input_tp"])
    if peak > -1:
        ffmpeg(["-i", out / "master.wav", "-af", f"volume={-1.4-peak:.6f}dB", "-c:a", "pcm_f32le",
                out / "delivery.wav"])
        try:
            rate = encode_delivery(out / "delivery.wav", out / "mix.mp3", score["duration_seconds"], max_bytes, metadata)
        finally:
            (out / "delivery.wav").unlink(missing_ok=True)
        measured_mp3 = loudness(out / "mix.mp3")
    return {"target_lufs": target_lufs, "premaster": measured, "gain_db": gain,
            "master": measured_master, "mp3": measured_mp3, "mp3_kbps": rate}


def analyze(out, score, levels, mastering, elapsed, plot=False):
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(out / "master.wav"), "-f", "f32le", "-"],
                         check=True, stdout=subprocess.PIPE).stdout
    x = np.frombuffer(raw, dtype="<f4").reshape(-1, 2)
    channels = x[::8]
    correlation = float(np.corrcoef(channels[:, 0], channels[:, 1])[0, 1]) if np.all(np.std(channels, axis=0) > 0) else None
    report = {"title": score["title"], "bpm": score["bpm"], "key": score["key"], "time_signature": "4/4",
              "sample_rate": SR, "duration_seconds": len(x) / SR, "seed": score["seed"],
              "render_seconds": round(elapsed, 2), "max_rss_mib": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, 1),
              "versions": {"numpy": np.__version__, "ffmpeg": subprocess.check_output(["ffmpeg", "-version"], text=True).splitlines()[0]},
              "peak_dbfs": db(float(np.max(np.abs(x)))), "finite": bool(np.isfinite(x).all()),
              "clipped_samples": int(np.count_nonzero(np.abs(x) >= 1)),
              "stereo_correlation": correlation,
              "dc_offset": [float(np.mean(x[:, c])) for c in range(2)],
              "loudness": mastering, "tracks": levels, "sections": [], "warnings": []}
    for s in score["sections"]:
        start, end = s["start"] * 60 / score["bpm"], s["end"] * 60 / score["bpm"]
        section = x[round(start * SR):round(end * SR)]
        rms = db(float(np.sqrt(np.mean(section * section))))
        report["sections"].append({"name": s["name"], "start_seconds": round(start, 3),
                                   "end_seconds": round(end, 3), "rms_dbfs": rms})
        if rms < -55:
            report["warnings"].append(f"Section {s['name']} is nearly silent; confirm that this is intentional")
    if abs(float(mastering["master"]["input_i"]) - mastering["target_lufs"]) > 1.0:
        report["warnings"].append("Loudness differs from target by over 1 LU; reduce dominant transients and remix")
    for name, level in levels.items():
        if level["peak_dbfs"] > 0:
            report["warnings"].append(f"Track {name} exceeds 0 dBFS before mastering; reduce gain for easier mixing")
    if not report["finite"] or report["clipped_samples"] or len(x) != score["frames"]:
        raise ValueError("Audio validation failed: nonfinite, clipped, or incorrect-length master")
    if float(mastering["master"]["input_tp"]) > -1 or float(mastering["mp3"]["input_tp"]) > -1:
        raise ValueError("True-peak headroom is insufficient")
    if plot:
        plot_audio(out / "analysis.png", x, score)
    return report


def plot_audio(path, audio, score):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig, axes = plt.subplots(2, 1, figsize=(14, 6), gridspec_kw={"height_ratios": [1, 2]}, layout="constrained")
    hop = 2400
    count = len(audio) // hop
    peaks = np.max(np.abs(audio[:count*hop].reshape(count, hop, 2)), axis=(1, 2))
    seconds = np.arange(count) * hop / SR
    axes[0].fill_between(seconds, -peaks, peaks, color="#287b79", linewidth=0)
    axes[0].set_title(f"{score['bpm']:g} BPM / {score['bars']} bars", loc="left")
    axes[0].set_ylim(-1, 1)
    axes[0].set_ylabel("Amplitude")
    axes[1].specgram(audio[::4].mean(axis=1), NFFT=1024, Fs=SR/4, noverlap=768, cmap="magma", vmin=-100, vmax=-25)
    axes[1].set_ylim(0, 6000)
    axes[1].set_ylabel("Frequency (Hz)")
    axes[1].set_xlabel("Time (seconds)")
    for ax in axes:
        ax.set_xlim(0, score["duration_seconds"])
        for s in score["sections"]:
            ax.axvline(s["start"] * 60 / score["bpm"], color="#8b8b8b", alpha=.35, linewidth=.7)
    fig.savefig(path, dpi=120)
    plt.close(fig)

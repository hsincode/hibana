#!/usr/bin/env python3
"""台本(YAML/JSON) から猫ミーム動画を組み立てる.

シーンを 1 本ずつ同一パラメータの mp4 にレンダリングしてから concat する。
巨大な filter_complex を 1 発で書くより、失敗したシーンを個別に再生成・
確認できるほうがデバッグが早いのでこの構成にしている。

  nm-build.py script.yaml -o out.mp4
  nm-build.py script.yaml --scene 2 -o preview.mp4   # 1シーンだけ確認
  nm-build.py script.yaml --check                    # 素材の有無だけ検証
  nm-build.py --init script.yaml                     # 雛形を書き出す
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import unicodedata
from pathlib import Path

SIZE_PRESETS = {
    "shorts": (1080, 1920),
    "vertical": (1080, 1920),
    "square": (1080, 1080),
    "landscape": (1920, 1080),
    "hd": (1920, 1080),
}

IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}


def die(msg: str) -> "None":
    print(f"error: {msg}", file=sys.stderr)
    raise SystemExit(2)


# --------------------------------------------------------------------------
# environment
# --------------------------------------------------------------------------


def root_dir() -> Path:
    return Path(os.environ.get("NEKO_MEME_DIR", Path.home() / ".cache" / "neko-meme"))


def load_index() -> dict:
    path = root_dir() / "index.json"
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh).get("materials", {})
    except FileNotFoundError:
        return {}


def default_font() -> str:
    env = os.environ.get("NEKO_MEME_FONT")
    if env:
        return env
    if shutil.which("fc-match"):
        for query in ("Noto Sans CJK JP:weight=bold", ":lang=ja"):
            out = subprocess.run(
                ["fc-match", "-f", "%{file}", query], capture_output=True, text=True
            ).stdout.strip()
            if out and Path(out).exists():
                return out
    die("日本語フォントが見つかりません。script の font: か $NEKO_MEME_FONT で指定してください")
    return ""


# --------------------------------------------------------------------------
# script loading
# --------------------------------------------------------------------------


def load_script(path: Path) -> dict:
    text = path.read_text(encoding="utf-8")
    if path.suffix in (".yaml", ".yml"):
        try:
            import yaml
        except ImportError:
            die("YAML 台本には PyYAML が必要です (pip install pyyaml)。JSON 台本なら不要")
        data = yaml.safe_load(text)
    else:
        data = json.loads(text)
    if not isinstance(data, dict) or "scenes" not in data:
        die("台本には scenes: が必要です")
    return data


def resolve_size(spec) -> tuple[int, int]:
    if spec is None:
        return SIZE_PRESETS["landscape"]
    if isinstance(spec, str):
        if spec in SIZE_PRESETS:
            return SIZE_PRESETS[spec]
        if "x" in spec:
            w, _, h = spec.partition("x")
            return int(w), int(h)
        die(f"不明な size: {spec}")
    if isinstance(spec, (list, tuple)) and len(spec) == 2:
        return int(spec[0]), int(spec[1])
    die(f"不明な size: {spec}")
    return (0, 0)


# --------------------------------------------------------------------------
# media helpers
# --------------------------------------------------------------------------


def probe_duration(path: Path) -> float | None:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nw=1:nk=1", str(path)],
        capture_output=True, text=True,
    ).stdout.strip()
    try:
        return float(out)
    except ValueError:
        return None


def has_audio(path: Path) -> bool:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries",
         "stream=index", "-of", "csv=p=0", str(path)],
        capture_output=True, text=True,
    ).stdout.strip()
    return bool(out)


def resolve_material(spec: str, index: dict) -> dict:
    """素材 ID かファイルパスを {file, key_color, crop, duration} に解決する."""
    if spec in index:
        entry = dict(index[spec])
        if not Path(entry["file"]).exists():
            die(f"素材ファイルが消えています: {entry['file']} (nm-fetch.py sync で再取得)")
        return entry
    path = Path(spec).expanduser()
    if path.exists():
        return {"file": str(path), "key_color": None, "crop": None,
                "duration": probe_duration(path), "has_audio": has_audio(path)}
    die(f"素材が見つかりません: {spec}\n"
        f"  ローカル素材: nm-fetch.py list\n"
        f"  未取得なら  : nm-fetch.py sync --only {spec}")
    return {}


# --------------------------------------------------------------------------
# text layout
# --------------------------------------------------------------------------


def wrap_text(text: str, max_units: int) -> list[str]:
    """表示幅ベースで折り返す. CJK は単語境界が無いので文字単位で折る."""
    lines: list[str] = []
    for raw in text.split("\n"):
        cur = ""
        width = 0
        for ch in raw:
            w = 2 if unicodedata.east_asian_width(ch) in "WFA" else 1
            # 行頭に来ると気持ち悪い約物は前の行に残す
            if width + w > max_units and ch not in "、。」』）!?！？":
                lines.append(cur)
                cur, width = "", 0
            cur += ch
            width += w
        lines.append(cur)
    return lines


def drawtext_filter(text: str, cfg: dict, size: tuple[int, int], workdir: Path,
                    tag: str) -> str:
    """drawtext を組み立てる. 本文は textfile 経由にしてエスケープ地獄を避ける."""
    w, h = size
    # 幅だけを基準にすると 16:9 (1920幅) で 120px になって画面を潰す。
    # 縦長では幅が、横長では高さが効くように両方の下限を取る。
    font_size = cfg.get("size") or max(20, round(min(w / 16, h / 19)))
    max_units = max(4, int((w * cfg.get("width_ratio", 0.90)) / font_size * 2))
    lines = wrap_text(text, max_units)
    tf = workdir / f"text-{tag}.txt"
    tf.write_text("\n".join(lines), encoding="utf-8")

    pos = cfg.get("pos", "top")
    margin = cfg.get("margin", 0.10)
    if pos == "top":
        y = f"{round(h * margin)}"
    elif pos == "bottom":
        y = f"h-th-{round(h * margin)}"
    elif pos == "center":
        y = "(h-th)/2"
    else:
        y = str(pos)  # 生の ffmpeg 式もそのまま通す

    opts = [
        f"fontfile={escape_filter_value(cfg['font'])}",
        f"textfile={escape_filter_value(str(tf))}",
        f"fontsize={font_size}",
        f"fontcolor={cfg.get('color', 'white')}",
        f"line_spacing={cfg.get('line_spacing', round(font_size * 0.25))}",
        "x=(w-tw)/2",
        f"y={y}",
    ]
    if cfg.get("box"):
        opts += [
            "box=1",
            f"boxcolor={cfg.get('box_color', 'black@0.55')}",
            f"boxborderw={cfg.get('box_padding', round(font_size * 0.35))}",
        ]
    border = cfg.get("border", round(font_size * 0.09))
    if border:
        opts += [f"borderw={border}", f"bordercolor={cfg.get('border_color', 'black')}"]
    if cfg.get("shadow", True):
        off = max(2, round(font_size * 0.05))
        opts += [f"shadowx={off}", f"shadowy={off}",
                 f"shadowcolor={cfg.get('shadow_color', 'black@0.6')}"]
    return "drawtext=" + ":".join(opts)


def escape_filter_value(value: str) -> str:
    """filter_complex 内のパス等をエスケープ (\\ : ' を潰す)."""
    return value.replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")


# --------------------------------------------------------------------------
# background
# --------------------------------------------------------------------------


def bg_input(spec, size: tuple[int, int], duration: float, fps: int,
             index: dict) -> list[str]:
    """背景の ffmpeg 入力引数 (-i まで) を組み立てる."""
    w, h = size
    if spec is None:
        spec = "gradient:#12131a,#2b2f45"
    if isinstance(spec, (list, tuple)):
        spec = "gradient:" + ",".join(spec)
    spec = str(spec)

    if spec.startswith("gradient:"):
        colors = [c.strip() for c in spec[len("gradient:"):].split(",") if c.strip()]
        while len(colors) < 2:
            colors.append(colors[0])
        args = ["-f", "lavfi", "-t", f"{duration}", "-i",
                f"gradients=s={w}x{h}:c0={colors[0]}:c1={colors[1]}:"
                f"x0=0:y0=0:x1={w}:y1={h}:r={fps}"]
        return args
    if spec.startswith("#") or spec.startswith("color:") or spec.startswith("0x"):
        color = spec[len("color:"):] if spec.startswith("color:") else spec
        args = ["-f", "lavfi", "-t", f"{duration}", "-i",
                f"color=c={color}:s={w}x{h}:r={fps}"]
        return args

    path = Path(spec).expanduser()
    if not path.exists():
        # backgrounds/ 配下の名前指定。stem 完全一致を優先する
        # (glob "focus.*" は focus.png のみだが、念のため focus-red と混同しない)
        bg_dir = root_dir() / "backgrounds"
        exact = [p for p in bg_dir.glob(f"{spec}.*") if p.stem == spec]
        if exact:
            path = sorted(exact)[0]
        else:
            for cand in sorted(bg_dir.glob(f"{spec}.*")):
                path = cand
                break
    if not path.exists() and spec in index:
        path = Path(index[spec]["file"])
    if not path.exists():
        die(f"背景が見つかりません: {spec}\n"
            f"  みんちりえ定番: nm-bg.py list --source minchi\n"
            f"  取得例        : nm-bg.py fetch --jpg-only --only mc-medium_office\n"
            f"  保存先        : {root_dir() / 'backgrounds'}")
    if path.suffix.lower() in IMAGE_EXT:
        return ["-loop", "1", "-t", f"{duration}", "-i", str(path)]
    return ["-stream_loop", "-1", "-t", f"{duration}", "-i", str(path)]


def bg_zoom_filter(mode: str, size: tuple[int, int], fps: int, duration: float,
                   amount: float) -> str:
    """静止画背景にゆっくりズームを掛けるフィルタ (いわゆる Ken Burns).

    背景がイラスト 1 枚だとカット全体が完全静止して見え、動画としては死ぬ。
    数 % のズームを足すだけで「生きている画」になる。
    zoompan は入力解像度のまま動かすとピクセルがガタつくので、先に 2 倍へ
    拡大してから動かし、最後に出力サイズへ落とす。
    """
    w, h = size
    frames = max(2, round(duration * fps))
    # zoompan の z は 1 フレームずつ評価される。始点と終点だけ決めて線形に振る
    if mode == "out":
        z = f"'{1 + amount}-{amount}*on/{frames - 1}'"
    else:
        z = f"'1+{amount}*on/{frames - 1}'"
    return (f"scale={w * 2}:{h * 2}:force_original_aspect_ratio=increase,"
            f"crop={w * 2}:{h * 2},"
            f"zoompan=z={z}:d={frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':"
            f"s={w}x{h}:fps={fps}")


def bg_filter(fit: str, size: tuple[int, int], fps: int) -> str:
    """[0:v] から [bg] までの背景フィルタ列を丸ごと返す."""
    w, h = size
    tail = f",fps={fps},setsar=1[bg]"
    if fit == "contain":
        return (f"[0:v]scale={w}:{h}:force_original_aspect_ratio=decrease,"
                f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=black{tail}")
    if fit == "blur":
        # 縦横比が合わない背景を切らずに収めたいときの定番。周囲をぼかして埋める
        return (f"[0:v]split=2[bgblur][bgfit];"
                f"[bgblur]scale={w}:{h}:force_original_aspect_ratio=increase,"
                f"crop={w}:{h},gblur=sigma={max(10, w // 40)}[bgblurred];"
                f"[bgfit]scale={w}:{h}:force_original_aspect_ratio=decrease[bgfitted];"
                f"[bgblurred][bgfitted]overlay=(W-w)/2:(H-h)/2{tail}")
    return (f"[0:v]scale={w}:{h}:force_original_aspect_ratio=increase,"
            f"crop={w}:{h}{tail}")


# --------------------------------------------------------------------------
# scene rendering
# --------------------------------------------------------------------------


def clamp_to_keyed_range(scene: dict, mat: dict, dur: float, scene_no: int) -> float:
    """素材のグリーン区間からはみ出さないよう start を寄せる.

    素材の頭や尻にタイトルカードが焼き込まれていることがあり
    (yt-goat-talking は 25.9 秒中グリーンなのは頭の 8.5 秒だけ)、
    そこを掴むとカードがそのまま合成結果に出る。黙って直すと分かりにくいので、
    寄せた場合は必ず警告を出す。
    """
    start = float(scene.get("start", 0))
    keyed = mat.get("keyed_range")
    if not keyed:
        return start
    lo, hi = float(keyed[0]), float(keyed[1])
    span = dur * float(scene.get("speed", 1) or 1)
    if lo <= start and start + span <= hi:
        return start

    if span > hi - lo:
        print(f"  warning: シーン {scene_no}: {mat['id']} のグリーン区間は "
              f"{lo:.1f}〜{hi:.1f}s ({hi - lo:.1f}s) しかなく、必要な {span:.1f}s に"
              f"足りません。duration を縮めるか別素材にしてください "
              f"(このままだとタイトルカードが映り込みます)", file=sys.stderr)
        return lo
    fixed = min(max(start, lo), hi - span)
    print(f"  warning: シーン {scene_no}: {mat['id']} の start を "
          f"{start:.1f}s -> {fixed:.1f}s に補正しました "
          f"(グリーン区間は {lo:.1f}〜{hi:.1f}s)", file=sys.stderr)
    return fixed


def auto_chromakey_params(key: str) -> tuple[float, float]:
    """キー色の彩度から chromakey の similarity / blend を決める.

    ffmpeg の chromakey は UV 平面上の距離で判定するので、閾値を固定値
    (よくある 0.2) にすると彩度の低いグリーンバック素材では「無彩色に近い
    被写体」まで一緒に消える。実際 yt-sleeping-cat (#55C150) は 0.2 だと
    クリーム色の猫が半透明になって消し飛んだ。
    キー色自身の UV 距離に比例させると、鮮やかな 0x00FF00 では従来どおり
    約 0.2、くすんだ緑では自動的に小さい閾値になる。
    """
    hexpart = re.sub(r"^(#|0[xX])", "", key)[:6].rjust(6, "0")
    r, g, b = (int(hexpart[i:i + 2], 16) for i in (0, 2, 4))
    y = 0.299 * r + 0.587 * g + 0.114 * b
    u = 0.492 * (b - y)
    v = 0.877 * (r - y)
    norm = (u * u + v * v) ** 0.5 / (255 * 2 ** 0.5)
    sim = min(0.28, max(0.06, norm * 0.5))
    return round(sim, 3), round(sim * 0.3, 3)


def overlay_position(pos, size: tuple[int, int]) -> tuple[str, str]:
    w, h = size
    if isinstance(pos, (list, tuple)) and len(pos) == 2:
        return str(pos[0]), str(pos[1])
    pos = (pos or "center").lower()
    xs = {"left": f"{round(w * 0.04)}", "center": "(W-w)/2",
          "right": f"W-w-{round(w * 0.04)}"}
    ys = {"top": f"{round(h * 0.10)}", "center": "(H-h)/2",
          "bottom": f"H-h-{round(h * 0.10)}"}
    parts = pos.split("-")
    if "flush" in parts:
        # 猫ミーム素材の多くは被写体が元動画の端で切れている (足やお尻が
        # フレーム外、あるいは元から矩形に切り抜かれている)。中央に浮かせると
        # 平らな切断面が丸見えになるので、画面の端にぴったり付けて隠す。
        # 例: yt-dj-cat は左と下が直線で切れているので bottom-left-flush。
        ys["bottom"] = "H-h"
        ys["top"] = "0"
        xs["left"] = "0"
        xs["right"] = "W-w"
    ypart = next((p for p in parts if p in ys), "center")
    xpart = next((p for p in parts if p in xs), "center")
    return xs[xpart], ys[ypart]


def scene_duration(scene: dict, mat: dict | None, defaults: dict) -> float:
    if scene.get("duration"):
        return float(scene["duration"])
    # ナレーションがあるならそれが尺を決める。猫素材は loop/trim で合わせる
    # (素材のほうが長いからといって喋り終わりの後を延々と見せる意味はない)
    voice = scene.get("voice")
    if voice:
        vd = probe_duration(Path(voice).expanduser())
        if vd:
            return vd + float(defaults.get("voice_padding", 0.4))
    if mat and mat.get("duration"):
        start = float(scene.get("start", 0))
        speed = float(scene.get("speed", 1)) or 1
        natural = max(0.5, (mat["duration"] - start) / speed)
        return min(natural, float(defaults.get("max_scene_duration", 8.0)))
    return float(defaults.get("default_duration", 3.0))


def build_scene(scene: dict, i: int, doc: dict, index: dict, workdir: Path,
                out: Path, dry_run: bool) -> None:
    size = resolve_size(doc.get("size"))
    w, h = size
    fps = int(doc.get("fps", 30))
    font = doc.get("font") or default_font()

    mat_spec = scene.get("cat") or scene.get("material")
    mat = resolve_material(str(mat_spec), index) if mat_spec else None
    dur = scene_duration(scene, mat, doc)

    args: list[str] = ["ffmpeg", "-v", "error", "-y"]
    filters: list[str] = []

    # ---- 背景 (input 0)
    args += bg_input(scene.get("bg", doc.get("bg")), size, dur, fps, index)
    fit = scene.get("bg_fit", doc.get("bg_fit", "cover"))
    zoom = scene.get("bg_zoom", doc.get("bg_zoom", "none"))
    if zoom in ("in", "out"):
        amount = float(scene.get("bg_zoom_amount", doc.get("bg_zoom_amount", 0.08)))
        chain = bg_zoom_filter(zoom, size, fps, dur, amount)
        filters.append(f"[0:v]{chain},setsar=1[bg]")
    else:
        filters.append(bg_filter(fit, size, fps))

    # ---- 猫素材 (input 1)
    idx_next = 1
    cat_idx = None
    if mat:
        start = clamp_to_keyed_range(scene, mat, dur, i)
        loop = scene.get("loop", True)
        if loop:
            args += ["-stream_loop", "-1"]
        if start:
            args += ["-ss", f"{start}"]
        args += ["-t", f"{dur * float(scene.get('speed', 1) or 1)}", "-i", mat["file"]]
        cat_idx = idx_next
        idx_next += 1

    # ---- 音声 (voice)
    voice_idx = None
    if scene.get("voice"):
        vpath = Path(scene["voice"]).expanduser()
        if not vpath.exists():
            die(f"voice が見つかりません: {vpath}")
        args += ["-i", str(vpath)]
        voice_idx = idx_next
        idx_next += 1

    vlabel = "[bg]"
    if mat:
        cat: list[str] = []
        # 既定は黒帯除去のみ。"auto" にすると被写体の外接矩形まで詰めるので、
        # 素材ごとの「フレーム内で被写体が占める割合」の差を吸収できる
        crop = scene.get("crop", doc.get("crop", mat.get("crop")))
        if crop == "auto":
            crop = mat.get("subject") or mat.get("crop")
        elif crop is False:
            crop = None
        if crop:
            cat.append(crop)
        speed = float(scene.get("speed", 1) or 1)
        if speed != 1:
            cat.append(f"setpts={1 / speed:.6f}*PTS")
        if scene.get("flip"):
            cat.append("hflip")
        cat.append(f"fps={fps}")

        key = scene.get("key", mat.get("key_color"))
        if key is not None and key is not False:
            color = (mat.get("key_color") or "0x00FF00") if key is True else str(key)
            auto_sim, auto_blend = auto_chromakey_params(color)
            sim = scene.get("similarity", doc.get("similarity", auto_sim))
            blend = scene.get("blend", doc.get("blend", auto_blend))
            cat.append(f"chromakey={color}:{sim}:{blend}")
            # 被写体の縁に残る緑かぶりを落とす。グリーンバックなら type=green
            cat.append("despill=type=green:mix=0.5:expand=0.3")

        # scale は「画面幅に対する猫の幅」。ただし横長の画では幅基準だけだと
        # 縦にはみ出すので、高さ上限 (max_height) を併せた箱に収める
        scale = float(scene.get("scale", doc.get("scale", 0.5)))
        max_h = float(scene.get("max_height", doc.get("max_height", 0.82)))
        box_w = max(2, round(w * scale / 2) * 2)
        box_h = max(2, round(h * max_h / 2) * 2)
        cat.append(f"scale={box_w}:{box_h}:force_original_aspect_ratio=decrease")
        cat.append("setsar=1")
        filters.append(f"[{cat_idx}:v]" + ",".join(cat) + "[cat]")
        ox, oy = overlay_position(scene.get("pos", doc.get("pos", "center")), size)
        filters.append(f"[bg][cat]overlay={ox}:{oy}:shortest=0:format=auto[comp]")
        vlabel = "[comp]"

    # ---- テキスト
    text_defaults = dict(doc.get("text_style", {}))
    text_defaults["font"] = font
    step = 0
    for key_name, pos_key, default_pos in (
        ("text", "text_pos", doc.get("text_pos", "top")),
        ("text2", "text2_pos", doc.get("text2_pos", "bottom")),
    ):
        value = scene.get(key_name)
        if not value:
            continue
        cfg = dict(text_defaults)
        cfg.update(scene.get(f"{key_name}_style", {}))
        cfg["pos"] = scene.get(pos_key, default_pos)
        cfg.setdefault("size", scene.get("text_size", doc.get("text_size")))
        flt = drawtext_filter(str(value), cfg, size, workdir, f"{i}-{key_name}")
        filters.append(f"{vlabel}{flt}[txt{step}]")
        vlabel = f"[txt{step}]"
        step += 1

    # ---- フェード
    fade_in = float(scene.get("fade_in", doc.get("fade_in", 0)))
    fade_out = float(scene.get("fade_out", doc.get("fade_out", 0)))
    fades = []
    if fade_in > 0:
        fades.append(f"fade=t=in:st=0:d={fade_in}")
    if fade_out > 0:
        fades.append(f"fade=t=out:st={max(0, dur - fade_out):.3f}:d={fade_out}")
    tail = ",".join(fades + [f"trim=0:{dur:.3f}", "setpts=PTS-STARTPTS", "format=yuv420p"])
    filters.append(f"{vlabel}{tail}[vout]")

    # ---- 音声グラフ
    alabels: list[str] = []
    audio_mode = scene.get("audio", "cat")
    if mat and cat_idx is not None and audio_mode == "cat" and mat.get("has_audio", True):
        vol = float(scene.get("volume", doc.get("volume", 1.0)))
        speed = float(scene.get("speed", 1) or 1)
        chain_a = ["asetpts=PTS-STARTPTS"]
        if speed != 1:
            chain_a.append(f"atempo={min(2.0, max(0.5, speed))}")
        chain_a += [f"volume={vol}", f"apad=whole_dur={dur:.3f}", f"atrim=0:{dur:.3f}"]
        filters.append(f"[{cat_idx}:a]" + ",".join(chain_a) + "[a_cat]")
        alabels.append("[a_cat]")
    elif isinstance(audio_mode, str) and audio_mode not in ("cat", "none"):
        apath = Path(audio_mode).expanduser()
        if not apath.exists():
            die(f"audio が見つかりません: {apath}")
        args += ["-i", str(apath)]
        extra = idx_next
        idx_next += 1
        vol = float(scene.get("volume", doc.get("volume", 1.0)))
        filters.append(f"[{extra}:a]volume={vol},apad=whole_dur={dur:.3f},"
                       f"atrim=0:{dur:.3f}[a_extra]")
        alabels.append("[a_extra]")

    if voice_idx is not None:
        vvol = float(scene.get("voice_volume", doc.get("voice_volume", 1.6)))
        filters.append(f"[{voice_idx}:a]volume={vvol},apad=whole_dur={dur:.3f},"
                       f"atrim=0:{dur:.3f}[a_voice]")
        alabels.append("[a_voice]")

    # シーンを連結すると波形が不連続な箇所でプチッと鳴るので、頭と尻を
    # 数十 ms だけフェードして必ず 0 から始まり 0 で終わるようにする
    declick = float(scene.get("audio_fade", doc.get("audio_fade", 0.04)))
    afade = ""
    if declick > 0 and dur > declick * 2:
        afade = (f",afade=t=in:st=0:d={declick},"
                 f"afade=t=out:st={dur - declick:.3f}:d={declick}")
    aout = (f"aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo"
            f"{afade}[aout]")
    if not alabels:
        args += ["-f", "lavfi", "-t", f"{dur}", "-i", "anullsrc=r=48000:cl=stereo"]
        filters.append(f"[{idx_next}:a]atrim=0:{dur:.3f},{aout}")
        idx_next += 1
    elif len(alabels) == 1:
        filters.append(f"{alabels[0]}{aout}")
    else:
        filters.append("".join(alabels) +
                       f"amix=inputs={len(alabels)}:duration=first:dropout_transition=0,"
                       f"{aout}")

    args += [
        "-filter_complex", ";".join(filters),
        "-map", "[vout]", "-map", "[aout]",
        "-t", f"{dur:.3f}",
        "-c:v", "libx264", "-preset", doc.get("preset", "veryfast"),
        "-crf", str(doc.get("crf", 20)), "-pix_fmt", "yuv420p", "-r", str(fps),
        "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
        "-movflags", "+faststart", str(out),
    ]
    if dry_run:
        print(" ".join(shlex.quote(a) for a in args))
        return
    res = subprocess.run(args, capture_output=True, text=True)
    if res.returncode != 0:
        print(res.stderr, file=sys.stderr)
        die(f"シーン {i} のレンダリングに失敗しました")


# --------------------------------------------------------------------------
# assembly
# --------------------------------------------------------------------------


def concat(parts: list[Path], out: Path, workdir: Path) -> None:
    listfile = workdir / "concat.txt"
    listfile.write_text(
        "".join(f"file '{p.as_posix()}'\n" for p in parts), encoding="utf-8"
    )
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0",
         "-i", str(listfile), "-c", "copy", "-movflags", "+faststart", str(out)],
        check=True,
    )


def normalize_audio(src: Path, out: Path, target_i: float, target_tp: float) -> None:
    """ラウドネス正規化 (2 パス loudnorm).

    猫ミーム素材は録音レベルがバラバラで、そのまま繋ぐと -15 LUFS 前後・
    トゥルーピーク -0.5 dBTP といった「小さいのにピークだけ張り付く」状態になる。
    YouTube は -14 LUFS 基準で自動調整をかけるので、こちらで合わせておくと
    再エンコード時の歪みを避けられる。
    1 パス目で実測してから 2 パス目に渡すのが loudnorm の正しい使い方
    (単発だと動的レンジ圧縮がかかってポンピングする)。
    """
    probe = subprocess.run(
        ["ffmpeg", "-hide_banner", "-i", str(src),
         "-af", f"loudnorm=I={target_i}:TP={target_tp}:LRA=11:print_format=json",
         "-f", "null", "-"],
        capture_output=True, text=True,
    ).stderr
    m = re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", probe, re.S)
    if not m:
        # 実測に失敗したら黙って素通し (正規化なしでも動画としては成立する)
        shutil.copy(src, out)
        return
    st = json.loads(m.group(0))
    # linear=true は「音量を一定倍するだけ」でリミッタが働かないため、
    # 持ち上げた結果ピークが 0 dBFS を超えることがある (実測 +0.9 dBTP)。
    # AAC のエンコード誤差ぶんも見て、目標 TP より 0.5 dB 低いところで頭を抑える。
    ceiling = 10 ** ((target_tp - 0.5) / 20)
    flt = (f"loudnorm=I={target_i}:TP={target_tp}:LRA=11:"
           f"measured_I={st['input_i']}:measured_TP={st['input_tp']}:"
           f"measured_LRA={st['input_lra']}:measured_thresh={st['input_thresh']}:"
           f"offset={st['target_offset']}:linear=true:print_format=summary,"
           f"alimiter=limit={ceiling:.4f}:attack=5:release=50:level=disabled")
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-i", str(src), "-af", flt,
         "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
         "-movflags", "+faststart", str(out)],
        check=True,
    )


def mix_bgm(src: Path, bgm: Path, out: Path, volume: float, fade: float) -> None:
    dur = probe_duration(src) or 0
    filt = (
        f"[1:a]volume={volume},afade=t=in:st=0:d={fade},"
        f"afade=t=out:st={max(0, dur - fade):.3f}:d={fade}[bgm];"
        f"[0:a][bgm]amix=inputs=2:duration=first:dropout_transition=0,"
        f"aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a]"
    )
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-i", str(src),
         "-stream_loop", "-1", "-i", str(bgm),
         "-filter_complex", filt, "-map", "0:v", "-map", "[a]",
         "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
         "-t", f"{dur:.3f}", "-movflags", "+faststart", str(out)],
        check=True,
    )


# --------------------------------------------------------------------------
# commands
# --------------------------------------------------------------------------


TEMPLATE = """\
# 猫ミーム台本。scenes を上から順に連結して 1 本の動画にする。
#
# 使ってよい素材は決まっている。台本を書く前に必ず一覧を見ること:
#   猫  : python3 scripts/nm-fetch.py list
#   背景: python3 scripts/nm-bg.py list --source minchi
#         ← みんちりえ定番 9 素材だけ。生成背景・色・任意パスは不可
# 候補外は --check もビルドも失敗する。
#
# 書けたら必ず検証: python3 scripts/nm-build.py <この台本> --check

title: 月曜の朝
size: landscape       # landscape(1920x1080, 既定) / shorts(1080x1920) / square
fps: 30

# 実写風イラスト背景の上に置くので、テロップはボックス必須
text_style:  { box: true, box_color: "black@0.62", size: 58 }
text2_style: { box: true, box_color: "black@0.62", size: 50 }

crop: auto            # 素材ごとの被写体サイズ差を吸収する
pos: bottom-flush     # 元動画の端で切れている素材の切断面を画面下端に隠す
volume: 0.85

scenes:
  - text: "6:00 起床"
    text2: "アラームは4回鳴った"
    cat: yt-sleeping-cat
    bg: mc-single_room3-4      # 夜・照明OFF
    scale: 0.25
    duration: 5.0

  - text: "上司「あの資料、朝イチでって言ったよね」"
    cat: yt-talking-and-huh    # 2匹入り素材。会話は 1 カットに収める
    bg: mc-medium_office-1     # 日中のオフィス
    scale: 0.54
    duration: 5.5

  - text: "え？"
    text2: "聞いてない"
    cat: yt-cat-huh            # 「え？」は 0.6s/4.2s/7.9s の 3 回鳴る。5 秒で 2 回入る
    bg: mc-medium_office-1
    scale: 0.33
    duration: 5.0

  - text: "会社は今日も元気です"
    cat: yt-laughing-dog
    bg: mc-building_hallway-3  # 夜・照明ON
    scale: 0.27
    duration: 5.0
"""


def cmd_init(path: Path) -> int:
    if path.exists():
        die(f"すでに存在します: {path}")
    path.write_text(TEMPLATE, encoding="utf-8")
    print(f"台本の雛形を書きました: {path}")
    return 0


SKILL_DIR = Path(__file__).resolve().parent.parent


def recommended_ids(catalog_name: str) -> set[str]:
    """カタログの recommended フラグが立っている ID を返す."""
    try:
        with open(SKILL_DIR / "assets" / catalog_name, encoding="utf-8") as fh:
            data = json.load(fh)
    except (FileNotFoundError, json.JSONDecodeError):
        return set()
    return {m["id"] for m in data.get("materials", []) if m.get("recommended")}


def check_allowed(doc: dict) -> list[str]:
    """候補外の猫素材を使っていないか調べる.

    台本に `allowed_materials` があればそれを、無ければカタログの
    `recommended` を既定の候補とする。**台本に何も書かなくても効く**のが肝で、
    こう書いておかないと「全 93 本から自由に選んでよい」と受け取られて
    候補外が混ざる。同じ和名で別動画がある素材
    (眠そうな猫 = yt-sleepy-cat / -2 / -3) は見た目では気付けない。
    `allow_any_material: true` で無効化できる。
    """
    if doc.get("allow_any_material"):
        return []
    allow = set(doc.get("allowed_materials") or recommended_ids("catalog.json"))
    if not allow:
        return []
    used = {str(sc.get("cat") or sc.get("material")) for sc in doc["scenes"]
            if sc.get("cat") or sc.get("material")}
    # ファイルパス直指定はカタログ管理外なので対象にしない
    return sorted(u for u in used
                  if u not in allow and not Path(u).expanduser().exists())


# 旧 nm-bg.py gen の名前。背景はみんちりえのみ使う方針なので、これらは常に不合格。
LEGACY_GEN_BG_NAMES = frozenset({
    "night", "sunset", "mint", "mono", "danger", "office", "spotlight",
    "focus", "focus-red", "rays", "grid", "dots", "noise", "flash", "black",
})


def _is_non_minchi_bg(spec: str) -> bool:
    """みんちりえ ID 以外 (色・グラデ・パス・旧生成背景名) か."""
    if not isinstance(spec, str):
        return True
    if spec in LEGACY_GEN_BG_NAMES:
        return True
    if spec.startswith(("#", "0x", "color:", "gradient:")):
        return True
    if spec.startswith(("/", "./", "../", "~")):
        return True
    # 絶対/相対パスとして実在するファイル (カタログ ID ではない)
    p = Path(spec).expanduser()
    if p.exists() and p.is_file():
        return True
    return False


def check_allowed_bg(doc: dict) -> list[str]:
    """みんちりえ以外の背景を弾く.

    既定の候補は bg-catalog の recommended (定番 9 素材) のみ。
    台本に `allowed_backgrounds` があればその ID に限定 (いずれもみんちりえ想定)。
    生成背景・色・グラデ・任意パスは不合格。
    みんちりえは `<ID>-<何枚目>` なので枚数接尾辞を落として照合する。

    緊急回避だけ `allow_any_background: true` (通常は使わない)。
    """
    if doc.get("allow_any_background"):
        return []

    allow = set(doc.get("allowed_backgrounds") or recommended_ids("bg-catalog.json"))
    if not allow:
        return []

    bad: list[str] = []
    default_bg = doc.get("bg")
    for i, sc in enumerate(doc["scenes"], 1):
        raw = sc.get("bg", default_bg)
        if raw is None or raw == "":
            bad.append(f"(scene {i}: bg未指定)")
            continue
        if isinstance(raw, (list, tuple)):
            bad.append(f"(scene {i}: {raw!r})")
            continue
        spec = str(raw)
        if _is_non_minchi_bg(spec):
            bad.append(spec)
            continue
        base = re.sub(r"-\d+$", "", spec)
        if base not in allow and spec not in allow:
            bad.append(spec)
    return sorted(set(bad))


def cmd_check(doc: dict, index: dict) -> int:
    missing = []
    total = 0.0
    for i, scene in enumerate(doc["scenes"], 1):
        spec = scene.get("cat") or scene.get("material")
        mat = None
        if spec:
            if str(spec) in index:
                mat = index[str(spec)]
            elif Path(str(spec)).expanduser().exists():
                p = Path(str(spec)).expanduser()
                mat = {"duration": probe_duration(p)}
            else:
                missing.append(str(spec))
        dur = scene_duration(scene, mat, doc)
        total += dur
        key = (mat or {}).get("key_color")
        note = "" if key else "  (背景抜きなし)"
        keyed = (mat or {}).get("keyed_range")
        if keyed:
            start = float(scene.get("start", 0))
            span = dur * float(scene.get("speed", 1) or 1)
            if not (keyed[0] <= start and start + span <= keyed[1]):
                note += f"  ⚠ グリーン区間 {keyed[0]}〜{keyed[1]}s から外れています"
        print(f"  {i:>2}. {dur:>5.2f}s  {spec or '(背景のみ)'}{note}")
    print(f"\n合計 {total:.2f}s / {len(doc['scenes'])} シーン")

    used = [str(sc.get("cat") or sc.get("material")) for sc in doc["scenes"]
            if sc.get("cat") or sc.get("material")]
    print(f"使用素材 {len(set(used))} 種 / のべ {len(used)} カット")
    if doc.get("allowed_materials"):
        unused = sorted(set(doc["allowed_materials"]) - set(used))
        if unused:
            print(f"  未使用の候補: {', '.join(unused)}")
    bad_cats = check_allowed(doc)
    bad_bgs = check_allowed_bg(doc)
    if bad_cats:
        print(f"\n候補外の猫素材を使っています: {', '.join(bad_cats)}\n"
              f"  採用対象は  : nm-fetch.py list\n"
              f"  意図的なら  : 台本に allowed_materials で明示するか "
              f"allow_any_material: true", file=sys.stderr)
    if bad_bgs:
        print(f"\nみんちりえ以外の背景 (または候補外) を使っています: "
              f"{', '.join(bad_bgs)}\n"
              f"  使える背景  : nm-bg.py list --source minchi\n"
              f"  指定形式    : mc-<name>-<枚数目> 例 mc-medium_office-1\n"
              f"  生成背景・色・任意パスは不可", file=sys.stderr)
    if bad_cats or bad_bgs:
        return 1
    if missing:
        print("\n未取得の素材があります:", file=sys.stderr)
        print(f"  nm-fetch.py sync --only {','.join(sorted(set(missing)))}", file=sys.stderr)
        return 1
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="台本から猫ミーム動画を生成")
    ap.add_argument("script", nargs="?", help="台本 (.yaml / .yml / .json)")
    ap.add_argument("-o", "--out", default="neko-meme.mp4")
    ap.add_argument("--init", metavar="PATH", help="台本の雛形を書き出して終了")
    ap.add_argument("--check", action="store_true", help="素材と尺の検証のみ")
    ap.add_argument("--scene", type=int, help="このシーンだけレンダリング (1 始まり)")
    ap.add_argument("--dry-run", action="store_true", help="ffmpeg コマンドを表示のみ")
    ap.add_argument("--keep-temp", action="store_true", help="中間ファイルを残す")
    args = ap.parse_args()

    if args.init:
        return cmd_init(Path(args.init))
    for tool in ("ffmpeg", "ffprobe"):
        if shutil.which(tool) is None:
            die(f"{tool} が見つかりません")
    if not args.script:
        ap.error("台本を指定してください (または --init)")

    doc = load_script(Path(args.script))
    index = load_index()

    if args.check:
        return cmd_check(doc, index)

    # 候補外は警告ではなくエラー。黙ってビルドが進むとルールが空文化する。
    bad_cats = check_allowed(doc)
    bad_bgs = check_allowed_bg(doc)
    if bad_cats or bad_bgs:
        print("=" * 68, file=sys.stderr)
        if bad_cats:
            print(f"error: 候補外の猫素材: {', '.join(bad_cats)}", file=sys.stderr)
            print("      採用対象の一覧: nm-fetch.py list", file=sys.stderr)
            print("      意図的なら allowed_materials か allow_any_material: true",
                  file=sys.stderr)
        if bad_bgs:
            print(f"error: みんちりえ以外/候補外の背景: {', '.join(bad_bgs)}",
                  file=sys.stderr)
            print("      使える背景: nm-bg.py list --source minchi", file=sys.stderr)
            print("      形式      : mc-<name>-<n> 例 mc-single_room3-4",
                  file=sys.stderr)
            print("      生成背景・色・任意パスは不可 (背景はみんちりえのみ)",
                  file=sys.stderr)
        print("=" * 68, file=sys.stderr)
        return 1

    scenes = doc["scenes"]
    if args.scene:
        if not 1 <= args.scene <= len(scenes):
            die(f"--scene は 1..{len(scenes)} の範囲で指定してください")
        scenes = [scenes[args.scene - 1]]

    out = Path(args.out).expanduser()
    out.parent.mkdir(parents=True, exist_ok=True)
    workdir = Path(tempfile.mkdtemp(prefix="neko-meme-"))
    try:
        parts = []
        for i, scene in enumerate(scenes, 1):
            part = workdir / f"scene-{i:03d}.mp4"
            if not args.dry_run:
                print(f"[{i}/{len(scenes)}] rendering...", file=sys.stderr)
            build_scene(scene, i, doc, index, workdir, part, args.dry_run)
            parts.append(part)
        if args.dry_run:
            return 0

        # 連結 -> BGM ミックス -> ラウドネス正規化 の順に段を重ねる。
        # 最後の段だけが out に書くので、途中の段は workdir に置く
        bgm = doc.get("bgm")
        loudness = doc.get("loudness", -14.0)
        stages = [s for s, on in (("bgm", bool(bgm)), ("loudnorm", loudness is not False))
                  if on]

        def stage_out(name: str) -> Path:
            return out if stages and stages[-1] == name else workdir / f"{name}.mp4"

        target = workdir / "concat.mp4" if stages else out
        if len(parts) == 1:
            shutil.copy(parts[0], target)
        else:
            concat(parts, target, workdir)

        if bgm:
            bgm_path = Path(str(bgm)).expanduser()
            if not bgm_path.exists():
                die(f"bgm が見つかりません: {bgm_path}")
            dest = stage_out("bgm")
            mix_bgm(target, bgm_path, dest, float(doc.get("bgm_volume", 0.12)),
                    float(doc.get("bgm_fade", 1.0)))
            target = dest
        if loudness is not False:
            print("normalizing loudness...", file=sys.stderr)
            normalize_audio(target, stage_out("loudnorm"), float(loudness),
                            float(doc.get("true_peak", -1.5)))
        dur = probe_duration(out)
        print(f"done: {out} ({dur:.2f}s)" if dur else f"done: {out}")
    finally:
        if args.keep_temp:
            print(f"中間ファイル: {workdir}", file=sys.stderr)
        else:
            shutil.rmtree(workdir, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())

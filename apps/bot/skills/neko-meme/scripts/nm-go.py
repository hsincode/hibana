#!/usr/bin/env python3
"""台本 1 本から不足素材取得 + レンダまでを一気にやる。

本番 Discord ではエージェントが sync / --check / 参照読みを飛ばして
「完成」と書いて終わるので、手順をこの 1 コマンドに閉じ込める。

  python3 nm-go.py script.yaml -o out.mp4
  python3 nm-go.py script.yaml -o out.mp4 --discord   # 8MB 未満・720p
  python3 nm-go.py script.yaml --print-plan           # 取得・サイズだけ表示
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
# Discord 非 Nitro の send_file 上限は 8MB。エンコード誤差を見て少し下に置く。
DISCORD_MAX_BYTES = 7_500_000
DISCORD_CRF = 26
# 既定 size 名 → 720p 相当。1080p CRF20 は 30 秒で 8MB を超える。
DISCORD_SIZE = {
    None: "1280x720",
    "landscape": "1280x720",
    "hd": "1280x720",
    "shorts": "720x1280",
    "vertical": "720x1280",
    "square": "720x720",
}


def die(msg: str, next_cmd: str | None = None) -> None:
    print(f"error: {msg}", file=sys.stderr)
    if next_cmd:
        print(f"次: {next_cmd}", file=sys.stderr)
    raise SystemExit(2)


def load_script(path: Path) -> dict:
    text = path.read_text(encoding="utf-8")
    if path.suffix in (".yaml", ".yml"):
        try:
            import yaml
        except ImportError:
            die("YAML 台本には PyYAML が必要です")
        data = yaml.safe_load(text)
    else:
        data = json.loads(text)
    if not isinstance(data, dict) or "scenes" not in data:
        die("台本には scenes: が必要です")
    return data


def used_cats(doc: dict) -> list[str]:
    seen: list[str] = []
    for sc in doc["scenes"]:
        spec = sc.get("cat") or sc.get("material")
        if not spec:
            continue
        s = str(spec)
        # パス直指定はカタログ外。取得対象にしない。
        if Path(s).expanduser().exists():
            continue
        if s not in seen:
            seen.append(s)
    return seen


def used_bg_bases(doc: dict) -> list[str]:
    """`mc-medium_office-1` → `mc-medium_office`。fetch --only 用。"""
    default_bg = doc.get("bg")
    seen: list[str] = []
    for sc in doc["scenes"]:
        raw = sc.get("bg", default_bg)
        if not raw or isinstance(raw, (list, tuple)):
            continue
        spec = str(raw)
        base = re.sub(r"-\d+$", "", spec)
        if base.startswith(("#", "0x", "color:", "gradient:", "/", "./", "../", "~")):
            continue
        if Path(spec).expanduser().is_file():
            continue
        if base not in seen:
            seen.append(base)
    return seen


def fit_wh(w: int, h: int, max_edge: int = 1280) -> str:
    if max(w, h) <= max_edge:
        return f"{w - w % 2}x{h - h % 2}"
    if w >= h:
        nw = max_edge
        nh = max(2, round(h * max_edge / w) // 2 * 2)
        return f"{nw}x{nh}"
    nh = max_edge
    nw = max(2, round(w * max_edge / h) // 2 * 2)
    return f"{nw}x{nh}"


def discord_size(doc: dict) -> str:
    spec = doc.get("size")
    if spec in DISCORD_SIZE:
        return DISCORD_SIZE[spec]
    if isinstance(spec, str) and "x" in spec:
        w, _, h = spec.partition("x")
        return fit_wh(int(w), int(h))
    if isinstance(spec, (list, tuple)) and len(spec) == 2:
        return fit_wh(int(spec[0]), int(spec[1]))
    return DISCORD_SIZE[None]


def apply_discord(doc: dict) -> dict:
    out = dict(doc)
    out["size"] = discord_size(doc)
    # 台本がより粗い CRF を指定していても、Discord 向けは 26 未満にしない。
    try:
        crf = int(out.get("crf", DISCORD_CRF))
    except (TypeError, ValueError):
        crf = DISCORD_CRF
    out["crf"] = max(crf, DISCORD_CRF)
    out.setdefault("preset", "veryfast")
    return out


def write_script(doc: dict, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.suffix in (".yaml", ".yml"):
        import yaml
        dest.write_text(
            yaml.safe_dump(doc, allow_unicode=True, sort_keys=False),
            encoding="utf-8",
        )
    else:
        dest.write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8")


def run_script(name: str, argv: list[str]) -> int:
    cmd = [sys.executable, str(SCRIPTS / name), *argv]
    print("+", " ".join(cmd), file=sys.stderr)
    return subprocess.call(cmd)


def fetch_missing(cats: list[str], bgs: list[str]) -> None:
    if cats:
        rc = run_script("nm-fetch.py", ["sync", "--only", ",".join(cats)])
        if rc != 0:
            die(
                "猫素材の取得に失敗した",
                "vpn_connect のあと同じ nm-go.py をもう一度（取得済みはスキップ）",
            )
    if bgs:
        rc = run_script(
            "nm-bg.py",
            ["fetch", "--jpg-only", "--only", ",".join(bgs)],
        )
        if rc != 0:
            die(
                "背景の取得に失敗した",
                f"python3 {SCRIPTS / 'nm-bg.py'} fetch --jpg-only --only {','.join(bgs)}",
            )


def probe_duration(path: Path) -> float | None:
    out = subprocess.run(
        [
            "ffprobe", "-v", "error", "-show_entries", "format=duration",
            "-of", "default=nw=1:nk=1", str(path),
        ],
        capture_output=True, text=True,
    ).stdout.strip()
    try:
        return float(out)
    except ValueError:
        return None


def shrink_for_discord(path: Path, max_bytes: int) -> None:
    """8MB 超なら平均ビットレートで再エンコード。まだ超えるなら一度縮小。"""
    if not path.is_file():
        die(f"出力が無い: {path}")
    if path.stat().st_size <= max_bytes:
        return
    dur = probe_duration(path) or 1.0
    audio_bps = 96_000
    video_bps = max(250_000, int(max_bytes * 8 / dur) - audio_bps)
    tmp = path.with_suffix(".shrink.mp4")

    def encode(vf: str | None) -> None:
        cmd = [
            "ffmpeg", "-y", "-i", str(path),
            "-c:v", "libx264", "-preset", "veryfast",
            "-b:v", str(video_bps), "-maxrate", str(video_bps),
            "-bufsize", str(video_bps * 2),
            "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "96k", "-ac", "2",
            "-movflags", "+faststart",
        ]
        if vf:
            cmd += ["-vf", vf]
        cmd.append(str(tmp))
        print("+", " ".join(cmd), file=sys.stderr)
        res = subprocess.run(cmd, capture_output=True, text=True)
        if res.returncode != 0:
            print(res.stderr, file=sys.stderr)
            die("Discord 向け再エンコードに失敗した")
        tmp.replace(path)

    print(
        f"出力 {path.stat().st_size} bytes > {max_bytes}; "
        f"video {video_bps}bps で再エンコード",
        file=sys.stderr,
    )
    encode(None)
    if path.stat().st_size <= max_bytes:
        return
    # ビットレートだけでは足りない尺。面積を 3/4 にしてもう一度。
    print("まだ大きいので 3/4 スケールでもう一度", file=sys.stderr)
    encode("scale=trunc(iw*3/8)*2:trunc(ih*3/8)*2")
    if path.stat().st_size > max_bytes:
        die(
            f"send_file 上限に収まらない ({path.stat().st_size} > {max_bytes})",
            "scenes を減らすか duration を短くして再実行",
        )


def print_plan(doc: dict, discord: bool) -> int:
    cats = used_cats(doc)
    bgs = used_bg_bases(doc)
    print("cats:", ",".join(cats) if cats else "(none)")
    print("bgs:", ",".join(bgs) if bgs else "(none)")
    if discord:
        patched = apply_discord(doc)
        print(f"discord_size: {patched['size']}")
        print(f"discord_crf: {patched['crf']}")
        print(f"discord_max_bytes: {DISCORD_MAX_BYTES}")
    else:
        print(f"size: {doc.get('size', 'landscape')}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="台本から不足取得+レンダを一気に実行")
    ap.add_argument("script", type=Path, help="台本 (.yaml / .yml / .json)")
    ap.add_argument("-o", "--out", default="neko-meme.mp4")
    ap.add_argument(
        "--discord",
        action="store_true",
        help="720p + CRF>=26、出力を 7.5MB 以下に収める（send_file 用）",
    )
    ap.add_argument(
        "--print-plan",
        action="store_true",
        help="取得対象と Discord サイズだけ表示して終了",
    )
    ap.add_argument("--keep-temp", action="store_true")
    args = ap.parse_args()

    script = args.script.expanduser()
    if not script.is_file():
        die(f"台本が無い: {script}", f"write_files で {script.name} を書いてから再実行")

    doc = load_script(script)
    if args.print_plan:
        return print_plan(doc, args.discord)

    for tool in ("ffmpeg", "ffprobe"):
        if shutil.which(tool) is None:
            die(f"{tool} が見つからない")

    cats = used_cats(doc)
    bgs = used_bg_bases(doc)
    fetch_missing(cats, bgs)

    build_src = script
    tmp_script: Path | None = None
    if args.discord:
        patched = apply_discord(doc)
        fd, tmp = tempfile.mkstemp(prefix="nm-go-", suffix=script.suffix or ".yaml")
        os.close(fd)
        tmp_script = Path(tmp)
        write_script(patched, tmp_script)
        build_src = tmp_script
        print(
            f"discord: size={patched['size']} crf={patched['crf']}",
            file=sys.stderr,
        )

    build_argv = [str(build_src), "-o", args.out]
    if args.keep_temp:
        build_argv.append("--keep-temp")
    rc = run_script("nm-build.py", build_argv)
    if tmp_script is not None and not args.keep_temp:
        tmp_script.unlink(missing_ok=True)
    if rc != 0:
        die(
            "レンダに失敗した",
            f"python3 {SCRIPTS / 'nm-build.py'} {script} --check",
        )

    out = Path(args.out).expanduser()
    if args.discord:
        shrink_for_discord(out, DISCORD_MAX_BYTES)
    if out.is_file():
        print(f"done: {out} ({out.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())

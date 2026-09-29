#!/usr/bin/env python3
"""YouTube の字幕を「動画のネイティブ言語」で取得し、読める文字起こしにする.

要約の精度は入力字幕の質でほぼ決まるので、言語選択は次の優先順で固定してある:

  1. 手動字幕 (人間が作成) の原語トラック
  2. 自動字幕の `<lang>-orig`  ← YouTube ASR の原語出力
  3. 自動字幕の `<lang>`

`<lang>` と `<lang>-orig` が両方ある動画では、`<lang>` の方が
「ASR → 機械翻訳 → 元の言語に戻ってきた」経路のトラックであることがある
(日本語動画に ja と ja-orig が両方並ぶのはこのパターン)。原語 ASR の方が
言い回しも固有名詞も原形に近いので、必ず `-orig` を優先する。
また **他言語トラックへは絶対にフォールバックしない**。YouTube の翻訳字幕は
固有名詞と数値が壊れやすく、要約の誤りに直結するため。

サブコマンド:
  list  利用可能な字幕トラックと、自動選択される言語を表示する
  get   字幕を取得して Markdown の文字起こしを書き出す

出力は既定で $YT_SUBS_DIR (既定 /tmp/yt-subs) 配下。中間生成物なので /tmp。
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

# 取得を試みる字幕フォーマットの順。json3 は YouTube 専用だが
# 「1 発話 = 1 イベント」で転がり重複 (rolling duplicate) が無く、
# VTT のような後処理デデュープが要らないので最優先。
SUB_FORMATS = "json3/srv3/vtt/srt/best"

DEFAULT_OUT = Path(os.environ.get("YT_SUBS_DIR", "/tmp/yt-subs"))


# ---------------------------------------------------------------- yt-dlp 呼び出し


def _yt_dlp_base() -> list[str]:
    exe = shutil.which("yt-dlp")
    if not exe:
        sys.exit("yt-dlp が見つからない。インストールしてから再実行する。")
    cmd = [exe, "--no-warnings", "--ignore-config"]
    # Bot チェックに当たる動画があるので、ブラウザの Cookie を使えるようにしておく。
    # 例: YT_SUBS_COOKIES_FROM_BROWSER=firefox
    browser = os.environ.get("YT_SUBS_COOKIES_FROM_BROWSER")
    if browser:
        cmd += ["--cookies-from-browser", browser]
    cookies = os.environ.get("YT_SUBS_COOKIES")
    if cookies:
        cmd += ["--cookies", cookies]
    return cmd


def fetch_meta(url: str, lang: str | None = None) -> dict:
    """動画メタデータ (字幕トラック一覧を含む) を取る.

    lang を渡すと `youtube:lang=` を付ける。これを付けないと YouTube は
    チャプター名やタイトルを閲覧側ロケールへ自動翻訳して返してくることがあり
    (日本語動画のチャプターが英語で返る)、原語で読みたい要約の妨げになる。
    """
    cmd = _yt_dlp_base() + ["--skip-download", "--dump-single-json"]
    if lang:
        cmd += ["--extractor-args", f"youtube:lang={lang}"]
    cmd.append(url)
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        tail = (proc.stderr or "").strip().splitlines()[-5:]
        sys.exit("yt-dlp がメタデータを取得できなかった:\n  " + "\n  ".join(tail))
    return json.loads(proc.stdout)


# ---------------------------------------------------------------- 言語選択


def _norm(lang: str) -> str:
    """`ja-JP` / `ja-orig` → `ja`。地域差や -orig を無視して比較するため."""
    base = lang.split("-")[0].lower()
    return base


def detect_native_lang(meta: dict) -> str | None:
    """動画本来の言語を推定する.

    yt-dlp の `language` が最も信頼できる。無い場合の代替として、自動字幕に
    `xx-orig` があればその `xx` が ASR の原語なのでそれを使う。
    """
    lang = meta.get("language")
    if lang:
        return _norm(lang)

    autos = meta.get("automatic_captions") or {}
    for key in autos:
        if key.endswith("-orig"):
            return _norm(key)

    # 手動字幕が 1 言語しか無いなら、それが原語とみなして概ね外さない。
    manual = meta.get("subtitles") or {}
    keys = [k for k in manual if k != "live_chat"]
    if len(keys) == 1:
        return _norm(keys[0])
    return None


def pick_track(meta: dict, want: str | None) -> tuple[str, str, str]:
    """使う字幕トラックを決める.

    returns: (yt-dlp に渡す言語キー, 種別 'manual'|'auto', 表示用ラベル)
    """
    manual = {k: v for k, v in (meta.get("subtitles") or {}).items() if k != "live_chat"}
    autos = meta.get("automatic_captions") or {}

    lang = want or detect_native_lang(meta)
    if not lang:
        sys.exit(
            "動画の言語を判定できなかった。--lang <code> で明示する。\n"
            f"  手動字幕: {sorted(manual) or 'なし'}\n"
            f"  自動字幕: {len(autos)} 言語"
        )
    base = _norm(lang)

    def match(table: dict, suffix: str | None) -> str | None:
        """base に一致するキーを返す。suffix='orig' なら -orig 付きだけを見る."""
        hits = []
        for key in table:
            if _norm(key) != base:
                continue
            is_orig = key.endswith("-orig")
            if (suffix == "orig") != is_orig:
                continue
            hits.append(key)
        if not hits:
            return None
        # `ja` (完全一致) を `ja-JP` より優先。それ以外は安定のため辞書順。
        hits.sort(key=lambda k: (k.lower() != base, k))
        return hits[0]

    # 手動字幕 > 原語 ASR > 通常 ASR。前述の理由で他言語には落とさない。
    for table, kind, suffix in (
        (manual, "manual", None),
        (manual, "manual", "orig"),
        (autos, "auto", "orig"),
        (autos, "auto", None),
    ):
        key = match(table, suffix)
        if key:
            label = {
                ("manual", None): "手動字幕",
                ("manual", "orig"): "手動字幕 (原語)",
                ("auto", "orig"): "自動字幕 (原語 ASR)",
                ("auto", None): "自動字幕",
            }[(kind, suffix)]
            return key, kind, label

    sys.exit(
        f"言語 '{base}' の字幕が無い (翻訳字幕へのフォールバックはしない)。\n"
        f"  手動字幕: {sorted(manual) or 'なし'}\n"
        f"  自動字幕(原語): {[k for k in autos if k.endswith('-orig')] or 'なし'}\n"
        "  別言語で妥協するなら --lang <code> を明示する。"
    )


# ---------------------------------------------------------------- 字幕パース


def parse_json3(text: str) -> list[tuple[float, str]]:
    """YouTube json3 → [(開始秒, 本文)]."""
    data = json.loads(text)
    out: list[tuple[float, str]] = []
    for ev in data.get("events") or []:
        segs = ev.get("segs")
        if not segs:
            continue  # ウィンドウ定義イベント (segs なし) は無視
        if ev.get("aAppend"):
            continue  # 転がり表示用の改行だけのイベント
        body = "".join(s.get("utf8", "") for s in segs)
        body = body.replace("\n", " ").strip()
        if body:
            out.append((ev.get("tStartMs", 0) / 1000.0, body))
    return out


_TS = re.compile(
    r"(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})"
)
_TAG = re.compile(r"<[^>]+>")


def parse_vtt_srt(text: str) -> list[tuple[float, str]]:
    """VTT / SRT → [(開始秒, 本文)]。YouTube 自動字幕の転がり重複も潰す.

    自動字幕の VTT は「前のキューの末尾行を次のキューの先頭に再掲」する形式なので、
    素直に連結すると同じ文が 2〜3 回並ぶ。直前に出した行と同じものは捨てる。
    """
    out: list[tuple[float, str]] = []
    seen_recent: list[str] = []
    start: float | None = None
    buf: list[str] = []

    def flush() -> None:
        nonlocal start, buf
        if start is None:
            buf = []
            return
        lines = []
        for raw in buf:
            line = _TAG.sub("", raw).strip()
            if not line or line in seen_recent:
                continue
            lines.append(line)
            seen_recent.append(line)
        del seen_recent[:-6]  # 直近数行だけ覚えれば転がり重複は消せる
        body = " ".join(lines).strip()
        if body:
            out.append((start, body))
        start, buf = None, []

    for raw in text.splitlines():
        m = _TS.search(raw)
        if m:
            flush()
            h, mi, s, ms = m.group(1), m.group(2), m.group(3), m.group(4)
            start = int(h) * 3600 + int(mi) * 60 + int(s) + int(ms.ljust(3, "0")) / 1000
            continue
        if raw.strip().upper().startswith(("WEBVTT", "NOTE ", "Kind:", "Language:")):
            continue
        if raw.strip().isdigit() and not buf:
            continue  # SRT の連番
        if raw.strip():
            buf.append(raw)
    flush()
    return out


def parse_sub(path: Path) -> list[tuple[float, str]]:
    text = path.read_text(encoding="utf-8", errors="replace")
    if path.suffix == ".json3" or path.name.endswith(".json3"):
        return parse_json3(text)
    if ".srv" in path.name:
        # srv1/2/3 は XML。json3 が無い環境向けの保険なので最低限だけ拾う。
        cues = re.findall(r'<(?:text|p)[^>]*\b(?:start|t)="([\d.]+)"[^>]*>(.*?)</', text, re.S)
        out = []
        for t, body in cues:
            body = re.sub(r"<[^>]+>", "", body)
            body = (
                body.replace("&amp;", "&")
                .replace("&lt;", "<")
                .replace("&gt;", ">")
                .replace("&#39;", "'")
                .replace("&quot;", '"')
            )
            body = " ".join(body.split())
            sec = float(t)
            if sec > 10000 and "." not in t:
                sec /= 1000.0  # srv3 の t はミリ秒
            if body:
                out.append((sec, body))
        return out
    return parse_vtt_srt(text)


# ---------------------------------------------------------------- 整形


def hhmmss(sec: float) -> str:
    sec = int(sec)
    h, m, s = sec // 3600, (sec % 3600) // 60, sec % 60
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


def join_cues(cues: list[tuple[float, str]], interval: int) -> list[tuple[float, str]]:
    """細切れのキューを interval 秒ごとの段落にまとめる.

    ASR のキューは 2〜4 秒刻みで文の途中で切れる。そのまま LLM に渡すと
    文脈が分断されるので、段落に固めた上で先頭にだけ時刻を振る。
    """
    if interval <= 0:
        return cues
    blocks: list[tuple[float, list[str]]] = []
    for start, body in cues:
        if not blocks or start - blocks[-1][0] >= interval:
            blocks.append((start, [body]))
        else:
            blocks[-1][1].append(body)
    return [(t, _smart_join(parts)) for t, parts in blocks]


_CJK = re.compile(r"[　-ヿ㐀-鿿＀-￯]")


def _smart_join(parts: list[str]) -> str:
    """日本語・中国語は空白を入れずに連結する (単語区切りに空白を使わないため)."""
    out = ""
    for part in parts:
        if not out:
            out = part
            continue
        if _CJK.search(out[-1]) or _CJK.search(part[0]):
            out += part
        else:
            out += " " + part
    return out


def build_markdown(meta: dict, label: str, key: str, cues: list[tuple[float, str]], interval: int) -> str:
    title = meta.get("title") or meta.get("id")
    lines = [f"# {title}", ""]
    info = [
        ("URL", meta.get("webpage_url") or meta.get("original_url") or ""),
        ("チャンネル", meta.get("uploader") or meta.get("channel") or ""),
        ("公開日", _fmt_date(meta.get("upload_date"))),
        ("長さ", hhmmss(meta.get("duration") or 0)),
        ("字幕", f"{key} ({label})"),
    ]
    lines += [f"- {k}: {v}" for k, v in info if v]
    body_chars = sum(len(b) for _, b in cues)
    lines.append(f"- 文字起こし: {body_chars:,} 字 / {len(cues)} 段落")
    lines.append("")

    chapters = meta.get("chapters") or []
    if chapters:
        # チャプターは著者自身が付けた構成なので、要約の見出し設計にそのまま使える。
        lines += ["## チャプター", ""]
        lines += [f"- [{hhmmss(c.get('start_time') or 0)}] {c.get('title', '')}" for c in chapters]
        lines.append("")

    desc = (meta.get("description") or "").strip()
    if desc:
        if len(desc) > 2000:
            desc = desc[:2000].rstrip() + " …(省略)"
        lines += ["## 概要欄", "", desc, ""]

    lines += ["## 文字起こし", ""]
    for start, body in cues:
        lines.append(f"[{hhmmss(start)}] {body}" if interval > 0 else body)
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def _fmt_date(raw: str | None) -> str:
    if not raw or len(raw) != 8:
        return ""
    return f"{raw[:4]}-{raw[4:6]}-{raw[6:]}"


# ---------------------------------------------------------------- サブコマンド


def cmd_list(args: argparse.Namespace) -> None:
    meta = fetch_meta(args.url)
    manual = {k: v for k, v in (meta.get("subtitles") or {}).items() if k != "live_chat"}
    autos = meta.get("automatic_captions") or {}
    native = detect_native_lang(meta)
    print(f"タイトル : {meta.get('title')}")
    print(f"言語(meta): {meta.get('language') or '不明'}  → 採用: {native or '不明'}")
    print(f"長さ     : {hhmmss(meta.get('duration') or 0)}")
    print(f"手動字幕 : {', '.join(sorted(manual)) or 'なし'}")
    origs = sorted(k for k in autos if k.endswith("-orig"))
    print(f"自動字幕 : {len(autos)} 言語 (原語トラック: {', '.join(origs) or 'なし'})")
    try:
        key, _kind, label = pick_track(meta, args.lang)
    except SystemExit as e:
        # list は情報表示が目的なので、選択に失敗しても一覧は出したまま理由を書く。
        print(f"選択     : 不可 — {e}")
        raise
    print(f"選択     : {key} ({label})")


def cmd_get(args: argparse.Namespace) -> None:
    meta = fetch_meta(args.url)
    key, kind, label = pick_track(meta, args.lang)
    vid = meta.get("id") or "video"

    # 原語が分かった時点でメタデータを取り直す。チャプター名が翻訳されて返る
    # ケースがあり、原語のまま欲しいため (fetch_meta の docstring 参照)。
    # 翻訳が起きるのは基本チャプターなので、チャプターがある動画だけ再取得する。
    native = _norm(key)
    if meta.get("chapters"):
        meta = fetch_meta(args.url, native)

    with tempfile.TemporaryDirectory(prefix="yt-subs-") as tmp:
        cmd = _yt_dlp_base() + [
            "--skip-download",
            "--write-auto-subs" if kind == "auto" else "--write-subs",
            "--sub-langs",
            key,
            "--sub-format",
            SUB_FORMATS,
            "-o",
            str(Path(tmp) / "sub.%(ext)s"),
            args.url,
        ]
        proc = subprocess.run(cmd, capture_output=True, text=True)
        files = sorted(Path(tmp).glob("sub.*"))
        if proc.returncode != 0 or not files:
            tail = (proc.stderr or proc.stdout or "").strip().splitlines()[-5:]
            sys.exit("字幕のダウンロードに失敗した:\n  " + "\n  ".join(tail))
        cues = parse_sub(files[0])

    if not cues:
        sys.exit(f"字幕 {key} を取得したが本文が空だった ({files[0].name})。")

    cues = join_cues(cues, args.interval)
    md = build_markdown(meta, label, key, cues, args.interval)

    outdir = Path(args.out).expanduser() if args.out else DEFAULT_OUT
    outdir.mkdir(parents=True, exist_ok=True)
    dest = outdir / f"{vid}.md"
    dest.write_text(md, encoding="utf-8")

    chars = sum(len(b) for _, b in cues)
    print(f"言語   : {key} ({label})")
    print(f"段落   : {len(cues)}  本文: {chars:,} 字")
    print(f"出力   : {dest}")


def main() -> None:
    ap = argparse.ArgumentParser(description="YouTube 字幕を原語で取得して文字起こしにする")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_list = sub.add_parser("list", help="字幕トラック一覧と自動選択結果を表示")
    p_list.add_argument("url")
    p_list.add_argument("--lang", help="言語を明示する (既定: 動画の原語を自動判定)")
    p_list.set_defaults(func=cmd_list)

    p_get = sub.add_parser("get", help="字幕を取得して Markdown を書き出す")
    p_get.add_argument("url")
    p_get.add_argument("--lang", help="言語を明示する (既定: 動画の原語を自動判定)")
    p_get.add_argument("-o", "--out", help=f"出力ディレクトリ (既定: {DEFAULT_OUT})")
    p_get.add_argument(
        "--interval",
        type=int,
        default=60,
        help="段落にまとめる間隔 (秒, 既定 60)。0 でキュー単位のまま",
    )
    p_get.set_defaults(func=cmd_get)

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""猫ミーム素材の収集ツール.

素材は 2 系統ある:
  - memesstyle : Cloudflare R2 に mp4 が直置きされているので curl 相当で直接取得できる
  - neko-meme  : neko-meme-site (猫ミーム情報局) は YouTube へのリンク集なので yt-dlp が必要

サブコマンド:
  list            カタログの素材一覧を表示
  sync            素材をローカルにダウンロードし index.json を更新
  refresh-catalog 配布元サイトを再スクレイプして catalog.json を更新
  index           ローカル素材の index.json を(再)生成

素材の保存先は $NEKO_MEME_DIR (既定 ~/.cache/neko-meme)。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.parse
import urllib.request
import time
import unicodedata
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parent.parent
CATALOG_PATH = SKILL_DIR / "assets" / "catalog.json"

UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) neko-meme-skill/1.0"}

MEMESSTYLE_PAGES = [
    "https://www.memesstyle.com/",
    "https://www.memesstyle.com/cat-meme-list",
]
NEKO_MEME_PAGE = "https://neko-meme-site.vercel.app/sozai-list"


# --------------------------------------------------------------------------
# paths
# --------------------------------------------------------------------------


def root_dir() -> Path:
    return Path(os.environ.get("NEKO_MEME_DIR", Path.home() / ".cache" / "neko-meme"))


def materials_dir() -> Path:
    return root_dir() / "materials"


def index_path() -> Path:
    return root_dir() / "index.json"


def load_catalog() -> dict:
    with open(CATALOG_PATH, encoding="utf-8") as fh:
        return json.load(fh)


def load_index() -> dict:
    try:
        with open(index_path(), encoding="utf-8") as fh:
            return json.load(fh)
    except FileNotFoundError:
        return {"version": 1, "materials": {}}


def save_index(idx: dict) -> None:
    index_path().parent.mkdir(parents=True, exist_ok=True)
    tmp = index_path().with_suffix(".json.tmp")
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(idx, fh, ensure_ascii=False, indent=1, sort_keys=True)
    tmp.replace(index_path())


# --------------------------------------------------------------------------
# media probing
# --------------------------------------------------------------------------


def ffprobe(path: Path) -> dict:
    """duration / 解像度 / fps / 音声有無 をまとめて取る."""
    out = subprocess.run(
        [
            "ffprobe", "-v", "error", "-print_format", "json",
            "-show_format", "-show_streams", str(path),
        ],
        capture_output=True, text=True, check=True,
    ).stdout
    data = json.loads(out)
    info: dict = {"has_audio": False, "duration": None, "width": None,
                  "height": None, "fps": None}
    for st in data.get("streams", []):
        if st.get("codec_type") == "video" and info["width"] is None:
            info["width"] = st.get("width")
            info["height"] = st.get("height")
            rate = st.get("avg_frame_rate") or st.get("r_frame_rate") or "0/1"
            num, _, den = rate.partition("/")
            try:
                info["fps"] = round(float(num) / float(den or 1), 3) if float(den or 1) else None
            except (ValueError, ZeroDivisionError):
                info["fps"] = None
        elif st.get("codec_type") == "audio":
            info["has_audio"] = True
    dur = data.get("format", {}).get("duration")
    if dur:
        info["duration"] = round(float(dur), 3)
    return info


def detect_content_crop(path: Path, ts: float) -> str | None:
    """ピラーボックス/レターボックスの黒帯を除いた領域を crop=w:h:x:y で返す.

    memesstyle の素材には 16:9 の枠に縦動画を貼った黒帯付きが混ざっていて、
    そのまま四隅を見に行くと黒帯を背景色だと誤認する。
    """
    cmd = [
        "ffmpeg", "-v", "info", "-ss", f"{ts}", "-i", str(path),
        "-vf", "cropdetect=limit=24:round=2:reset=0", "-frames:v", "30",
        "-f", "null", "-",
    ]
    res = subprocess.run(cmd, capture_output=True, text=True)
    found = re.findall(r"crop=(\d+:\d+:\d+:\d+)", res.stderr)
    return f"crop={found[-1]}" if found else None


def _corner_rgb(path: Path, ts: float, corner: str, pre: str | None) -> tuple[int, int, int] | None:
    """指定時刻・指定隅の平均色を 1px に潰して取り出す."""
    # 隅から 6% の小領域を平均。ロゴやフチのノイズを避けつつ背景色を拾える幅。
    x = "0" if "l" in corner else "iw*0.94"
    y = "0" if "t" in corner else "ih*0.94"
    chain = ([pre] if pre else []) + [f"crop=iw*0.06:ih*0.06:{x}:{y}", "scale=1:1"]
    cmd = [
        "ffmpeg", "-v", "error", "-ss", f"{ts}", "-i", str(path),
        "-vf", ",".join(chain),
        "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
    ]
    res = subprocess.run(cmd, capture_output=True)
    if res.returncode != 0 or len(res.stdout) < 3:
        return None
    return tuple(res.stdout[:3])  # type: ignore[return-value]


# 背景抜きできる「合成用の背景色」と判定する閾値。
# PURITY: 主色が他 2 チャンネルをどれだけ引き離しているか。芝生や森などの
#         自然物の緑は 40 前後までしか出ないので 60 で弾ける。
# SPREAD: 同じ背景色とみなす許容差。動きの速い被写体の縁では緑が暗く滲むので
#         ±45 程度は許容しつつ、離れすぎた値はクラスタから外す。
# MIN_RATIO: 全サンプル中どれだけが同一色クラスタなら「背景」と認めるか。
#         被写体が大きく四隅に食い込む素材があるので過半数は要求しない。
KEY_PURITY = 60
KEY_SPREAD = 45
KEY_MIN_RATIO = 1 / 3


def detect_key_color(path: Path, duration: float | None) -> str | None:
    """グリーン/ブルーバックを自動判定して 0xRRGGBB を返す.

    素材ごとに緑の濃さがバラつく (撮影・再エンコードのせい) ので、固定の
    0x00FF00 ではなく実測値を chromakey に渡したほうが抜けが安定する。
    """
    dur = duration or 3.0
    stamps = [dur * f for f in (0.15, 0.5, 0.85)]
    pre = detect_content_crop(path, stamps[0])
    greens: list[tuple[int, int, int]] = []
    blues: list[tuple[int, int, int]] = []
    total = 0
    for ts in stamps:
        for corner in ("tl", "tr", "bl", "br"):
            rgb = _corner_rgb(path, ts, corner, pre)
            if rgb is None:
                continue
            total += 1
            r, g, b = rgb
            if g - max(r, b) >= KEY_PURITY:
                greens.append(rgb)
            elif b - max(r, g) >= KEY_PURITY:
                blues.append(rgb)
    if not total:
        return None
    hits = greens if len(greens) >= len(blues) else blues
    if not hits:
        return None
    # 被写体の縁で滲んだ暗い緑が 1 点混ざるだけで平均が崩れるので、
    # 「一番仲間の多いサンプル」を核にクラスタを作り、その平均を採用する
    cluster = max(
        ([t for t in hits if max(abs(t[i] - s[i]) for i in range(3)) <= KEY_SPREAD]
         for s in hits),
        key=len,
    )
    if len(cluster) < total * KEY_MIN_RATIO:
        return None
    n = len(cluster)
    avg = [sum(c[i] for c in cluster) // n for i in range(3)]
    return "0x%02X%02X%02X" % tuple(avg)


# 被写体判定: キー色からこの距離 (RGB ユークリッド) を超えたら被写体とみなす
SUBJECT_THRESHOLD = 90
# グリーン区間の検出パラメータ
KEYED_PROBE_W = 32
KEYED_PROBE_FPS = 2
KEYED_MIN_FRACTION = 0.10


def detect_keyed_range(path: Path, key_color: str | None, width: int | None,
                       height: int | None, duration: float | None) -> list[float] | None:
    """グリーンバックが実際に写っている区間 [開始, 終了] を秒で返す.

    素材によっては元動画の頭や尻にタイトルカード (黒地に "origin" など) が
    焼き込まれている。そこを掴んでしまうと合成結果にカードがそのまま出る。
    実際 yt-goat-talking は 25.9 秒のうちグリーンなのは頭の 8.5 秒だけで、
    start: 4.0 + 5 秒 の指定がカードに突っ込んで事故った。

    fps=2 の 32px サムネイルを 1 パスで読み、キー色が一定割合以上あるフレームが
    連続する最長区間を返す。全編グリーンなら None (制限なし)。
    """
    if not (key_color and width and height):
        return None
    kr, kg, kb = (int(key_color[2:][i:i + 2], 16) for i in (0, 2, 4))
    probe_h = max(2, round(height / width * KEYED_PROBE_W / 2) * 2)
    out = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path),
         "-vf", f"fps={KEYED_PROBE_FPS},scale={KEYED_PROBE_W}:{probe_h}",
         "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        capture_output=True,
    ).stdout
    frame_bytes = KEYED_PROBE_W * probe_h * 3
    total = len(out) // frame_bytes
    if total < 2:
        return None

    keyed: list[bool] = []
    for f in range(total):
        data = out[f * frame_bytes:(f + 1) * frame_bytes]
        hit = sum(1 for p in range(0, len(data), 3)
                  if (data[p] - kr) ** 2 + (data[p + 1] - kg) ** 2
                  + (data[p + 2] - kb) ** 2 < SUBJECT_THRESHOLD ** 2)
        keyed.append(hit / (KEYED_PROBE_W * probe_h) >= KEYED_MIN_FRACTION)

    best = cur = None
    for i, ok in enumerate(keyed + [False]):
        if ok:
            cur = i if cur is None else cur
        elif cur is not None:
            if best is None or (i - cur) > (best[1] - best[0]):
                best = (cur, i)
            cur = None
    if best is None:
        return None
    start = best[0] / KEYED_PROBE_FPS
    end = min(best[1] / KEYED_PROBE_FPS, duration or best[1] / KEYED_PROBE_FPS)
    # 全編グリーンなら制限を付けない (サンプリング誤差で 1 コマ欠けた程度は無視)
    if start <= 0.5 and (duration or 0) - end <= 0.5:
        return None
    return [round(start, 2), round(end, 2)]


# 被写体検出に使う縮小幅。大きくすると精度は上がるがフレーム取得が遅くなる
SUBJECT_PROBE_W = 160


def detect_subject_crop(path: Path, key_color: str | None, duration: float | None,
                        bars: str | None) -> str | None:
    """グリーンバックを除いた被写体の外接矩形を crop=w:h:x:y で返す.

    素材によって被写体がフレームのどれだけを占めるかがバラバラで
    (pot-dog は犬が画面の 1/3、waving-cat は猫が 2/3)、同じ scale を指定しても
    仕上がりの大きさが揃わない。被写体だけを切り出しておけば scale が
    「画面に対する被写体の大きさ」として素直に効く。
    """
    if not key_color:
        return None
    kr, kg, kb = (int(key_color[2:][i:i + 2], 16) for i in (0, 2, 4))
    dur = duration or 3.0
    box = None  # [x0, y0, x1, y1] を 0..1 の相対座標で持つ
    for frac in (0.1, 0.3, 0.5, 0.7, 0.9):
        chain = ([bars] if bars else []) + [f"scale={SUBJECT_PROBE_W}:-1"]
        res = subprocess.run(
            ["ffmpeg", "-v", "error", "-ss", f"{dur * frac}", "-i", str(path),
             "-vf", ",".join(chain), "-frames:v", "1",
             "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
            capture_output=True,
        )
        data = res.stdout
        if res.returncode != 0 or len(data) < 3:
            continue
        w = SUBJECT_PROBE_W
        h = len(data) // (3 * w)
        if h < 2:
            continue
        xs0, ys0, xs1, ys1 = w, h, -1, -1
        for y in range(h):
            row = data[y * w * 3:(y + 1) * w * 3]
            for x in range(w):
                r, g, b = row[x * 3], row[x * 3 + 1], row[x * 3 + 2]
                if (r - kr) ** 2 + (g - kg) ** 2 + (b - kb) ** 2 > SUBJECT_THRESHOLD ** 2:
                    if x < xs0:
                        xs0 = x
                    if x > xs1:
                        xs1 = x
                    if y < ys0:
                        ys0 = y
                    if y > ys1:
                        ys1 = y
        if xs1 < 0:
            continue
        cur = [xs0 / w, ys0 / h, (xs1 + 1) / w, (ys1 + 1) / h]
        box = cur if box is None else [min(box[0], cur[0]), min(box[1], cur[1]),
                                       max(box[2], cur[2]), max(box[3], cur[3])]
    if box is None:
        return None
    # 動きで少しはみ出すぶんの余白
    margin = 0.03
    x0 = max(0.0, box[0] - margin)
    y0 = max(0.0, box[1] - margin)
    x1 = min(1.0, box[2] + margin)
    y1 = min(1.0, box[3] + margin)
    if (x1 - x0) > 0.96 and (y1 - y0) > 0.96:
        return None  # ほぼ全画面 = 切っても意味がない

    # 相対座標を実サイズに戻す。基準は黒帯除去後のサイズ
    src_w, src_h = ffprobe(path)["width"], ffprobe(path)["height"]
    off_x = off_y = 0
    if bars:
        bw, bh, bx, by = (int(v) for v in bars.split("=")[1].split(":"))
        src_w, src_h, off_x, off_y = bw, bh, bx, by
    cw = max(2, int((x1 - x0) * src_w) // 2 * 2)
    ch = max(2, int((y1 - y0) * src_h) // 2 * 2)
    cx = off_x + int(x0 * src_w)
    cy = off_y + int(y0 * src_h)
    return f"crop={cw}:{ch}:{cx}:{cy}"


# --------------------------------------------------------------------------
# download
# --------------------------------------------------------------------------


def http_get(url: str) -> str:
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.read().decode("utf-8", "replace")


def download_direct(url: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    # URL 内の日本語/空白がそのまま入っているので必ず quote してから投げる
    safe = urllib.parse.quote(url, safe=":/?&=%#")
    req = urllib.request.Request(safe, headers=UA)
    with urllib.request.urlopen(req, timeout=180) as resp, open(tmp, "wb") as fh:
        shutil.copyfileobj(resp, fh)
    tmp.replace(dest)


class BotCheckError(RuntimeError):
    """YouTube のボット判定に当たった. 続行しても全部落ちるので即中断する."""


def download_youtube(url: str, dest: Path, cookies: str | None = None,
                     retries: int = 2) -> None:
    if shutil.which("yt-dlp") is None:
        raise RuntimeError("yt-dlp が見つかりません (youtube 素材の取得に必要)")
    dest.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "yt-dlp", "--no-warnings", "--no-playlist", "--quiet", "--no-progress",
        "-f", "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b",
        "--merge-output-format", "mp4",
        "-o", str(dest.with_suffix("")) + ".%(ext)s",
    ]
    if cookies:
        cmd += ["--cookies-from-browser", cookies]
    cmd.append(url)

    last = ""
    for attempt in range(retries + 1):
        res = subprocess.run(cmd, capture_output=True, text=True)
        if res.returncode == 0:
            break
        stderr = res.stderr or ""
        last = (stderr.strip().splitlines() or [f"yt-dlp exit {res.returncode}"])[-1]
        if "Sign in to confirm" in stderr or "not a bot" in stderr:
            raise BotCheckError(last)
        if "Video unavailable" in stderr or "Private video" in stderr:
            raise RuntimeError(last)  # 消えている動画はリトライしても無駄
        if attempt < retries:
            time.sleep(3 * (attempt + 1))  # 一時的な失敗なら少し待って再試行
    else:
        raise RuntimeError(last)

    if not dest.exists():
        # 拡張子が mkv 等になった場合の救済
        for cand in dest.parent.glob(dest.stem + ".*"):
            if cand.suffix in (".mp4", ".mkv", ".webm"):
                cand.rename(dest)
                break


# --------------------------------------------------------------------------
# scraping (catalog refresh)
# --------------------------------------------------------------------------


def slugify(text: str) -> str:
    # 濁点が結合文字で来ることがある (R2 のファイル名が NFD) ので NFC に寄せる
    text = unicodedata.normalize("NFC", text)
    s = re.sub(r"[^\w-]+", "-", text, flags=re.UNICODE).strip("-").lower()
    return s or "material"


def scrape_memesstyle() -> list[dict]:
    """<video src="..r2.dev/..mp4" title="日本語名"> を拾う.

    title 属性に日本語名が入っているので、ファイル名 (英語/中国語混在) より
    こちらを name_ja として採用する。
    """
    seen: dict[str, dict] = {}
    for page in MEMESSTYLE_PAGES:
        html = http_get(page)
        for tag in re.findall(r"<video[^>]*>", html):
            m_src = re.search(r'src="(https://pub-[a-z0-9]+\.r2\.dev/[^"]+\.mp4)"', tag)
            if not m_src:
                continue
            m_title = re.search(r'title="([^"]*)"', tag)
            url = m_src.group(1).rstrip("\\")
            title = m_title.group(1) if m_title else ""
            # 同じファイルが %2F 版と生スラッシュ版で二重に出てくるため、
            # デコード後のパスで正規化してから重複判定する
            decoded = unicodedata.normalize("NFC", urllib.parse.unquote(url))
            name = decoded.rsplit("/", 1)[-1][: -len(".mp4")].strip()
            title = unicodedata.normalize("NFC", title or "").strip()
            if decoded in seen:
                if title and not seen[decoded].get("name_ja"):
                    seen[decoded]["name_ja"] = title
                continue
            entry = {
                "id": slugify(name),
                "name": name,
                "source": "memesstyle",
                "url": url,
                "page": page,
            }
            if title:
                entry["name_ja"] = title
            seen[decoded] = entry
    return list(seen.values())


def scrape_neko_meme() -> list[dict]:
    """猫ミーム情報局の素材リストを全ページ走査する.

    /sozai-list は 20 件ずつのページングで、2 ページ目以降は
    /sozai-list/p/<n> にある。1 ページ目だけ見ると 3/4 を取りこぼす。
    """
    items: list[tuple[str, str]] = []
    seen_ids: set[str] = set()
    page = 1
    while True:
        url = NEKO_MEME_PAGE if page == 1 else f"{NEKO_MEME_PAGE}/p/{page}"
        try:
            html = http_get(url)
        except Exception:  # noqa: BLE001
            break
        found = re.findall(r'videoid="([A-Za-z0-9_-]{11})".*?<p>(.*?)</p>', html, re.S)
        # 空ページが返ってきたら終端。存在しない p/99 も 200 で空が返る
        fresh = [(v, t) for v, t in found if v not in seen_ids]
        if not fresh:
            break
        seen_ids.update(v for v, _ in fresh)
        items += fresh
        page += 1
        if page > 50:  # 無限ループ避け
            break

    out = []
    used: set[str] = set()
    for vid, title in items:
        title = unicodedata.normalize("NFC", re.sub(r"<[^>]+>", "", title)).strip()
        base = slugify(title)
        ident = base
        n = 2
        while ident in used:  # 「眠そうな猫」など同名タイトルが複数ある
            ident = f"{base}-{n}"
            n += 1
        used.add(ident)
        out.append({
            "id": ident,
            "name": title,
            "source": "youtube",
            "url": f"https://youtu.be/{vid}",
            "page": NEKO_MEME_PAGE,
        })
    return out


def cmd_refresh_catalog(args) -> int:
    old = load_catalog()
    mats = scrape_memesstyle() + scrape_neko_meme()
    # id は人手で短く付け直しているので、突き合わせは URL で行う
    old_by_url = {m["url"]: m for m in old.get("materials", [])}
    for m in mats:
        prev = old_by_url.get(m["url"])
        if not prev:
            continue
        m["id"] = prev["id"]
        for key in ("name_ja", "tags", "note", "unavailable", "alt"):
            if key in prev:
                m[key] = prev[key]
    catalog = dict(old)
    catalog["materials"] = sorted(mats, key=lambda m: (m["source"], m["id"]))
    out = Path(args.out) if args.out else CATALOG_PATH
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(catalog, fh, ensure_ascii=False, indent=1)
        fh.write("\n")
    print(f"catalog updated: {out} ({len(mats)} materials)")
    return 0


# --------------------------------------------------------------------------
# commands
# --------------------------------------------------------------------------


def select(catalog: dict, source: str, only: list[str] | None,
           tags: list[str] | None = None, query: str | None = None,
           show_all: bool = False) -> list[dict]:
    mats = catalog["materials"]
    # 既定は「使うと決めた素材」だけ。全 93 本を並べると、そこから自由に
    # 選んでよいと受け取られて候補外が混ざる事故が起きる
    if not show_all and not only:
        rec = [m for m in mats if m.get("recommended")]
        if rec:
            mats = rec
    if source != "all":
        mats = [m for m in mats if m["source"] == source]
    if tags:
        mats = [m for m in mats if set(tags) & set(m.get("tags", []))]
    if query:
        q = query.lower()
        mats = [m for m in mats
                if q in m["id"].lower() or q in m.get("name_ja", "").lower()
                or q in m["name"].lower() or any(q in t.lower() for t in m.get("tags", []))]
    if only:
        wanted = set(only)
        mats = [m for m in mats if m["id"] in wanted]
        missing = wanted - {m["id"] for m in mats}
        if missing:
            raise SystemExit(f"unknown material id: {', '.join(sorted(missing))}")
    return mats


def cmd_list(args) -> int:
    catalog = load_catalog()
    idx = load_index()
    mats = select(catalog, args.source, args.only,
                  getattr(args, "tag", None), getattr(args, "search", None),
                  getattr(args, "all", False))
    if args.json:
        for m in mats:
            m = dict(m)
            m["local"] = idx["materials"].get(m["id"])
        print(json.dumps(mats, ensure_ascii=False, indent=1))
        return 0
    for m in mats:
        local = idx["materials"].get(m["id"])
        mark = "*" if local else ("x" if m.get("unavailable") else " ")
        extra = ""
        if local:
            extra = f"  {local.get('duration')}s {local.get('width')}x{local.get('height')}"
            if local.get("key_color"):
                extra += f" key={local['key_color']}"
        elif m.get("unavailable"):
            extra = "  [配布元で削除済み" + (f" -> {m['alt']} で代用]" if m.get("alt") else "]")
        tags = f"  [{'/'.join(m.get('tags', []))}]" if m.get("tags") else ""
        print(f"{mark} {m['id']:<24} {m['source']:<10} "
              f"{m.get('name_ja') or m['name']}{extra}{tags}")
    total = len(catalog["materials"])
    if not getattr(args, "all", False) and not args.only:
        print(f"\n{len(mats)} materials (採用対象のみ / 全 {total} 本は --all)"
              f"  '*' = 取得済み / 'x' = 配布元で削除済み")
        print("台本の cat: にはこの一覧の ID を使うこと。--all の素材を使うと "
              "nm-build.py が警告します")
    else:
        print(f"\n{len(mats)} materials ('*' = 取得済み / 'x' = 配布元で削除済み)")
    print(f"保存先: {materials_dir()}")
    return 0


def index_entry(mat: dict, path: Path) -> dict:
    info = ffprobe(path)
    entry = {
        "id": mat["id"],
        "file": str(path),
        "source": mat["source"],
        "name": mat.get("name_ja") or mat["name"],
        **info,
    }
    entry["key_color"] = detect_key_color(path, info.get("duration"))
    # 黒帯付き素材は合成時にも帯を切らないと背景の上に黒枠が乗るので保存しておく
    bars = detect_content_crop(path, (info.get("duration") or 3.0) * 0.15)
    if bars:
        w, h, _, _ = (int(v) for v in bars.split("=")[1].split(":"))
        if (w, h) == (info.get("width"), info.get("height")):
            bars = None
    entry["crop"] = bars
    entry["subject"] = detect_subject_crop(path, entry["key_color"],
                                           info.get("duration"), bars)
    # 頭や尻にタイトルカードが焼き込まれている素材があるので、
    # 実際にグリーンバックが写っている区間を記録する
    entry["keyed_range"] = detect_keyed_range(
        path, entry["key_color"], info.get("width"), info.get("height"),
        info.get("duration"))
    return entry


def cmd_sync(args) -> int:
    catalog = load_catalog()
    # 収集は全件が対象。「使う素材を絞る」のと「手元に置く」のは別
    mats = select(catalog, args.source, args.only, show_all=True)
    idx = load_index()
    dest_dir = materials_dir()
    dest_dir.mkdir(parents=True, exist_ok=True)

    ok = skipped = failed = 0
    downloaded_yt = False
    for i, mat in enumerate(mats, 1):
        dest = dest_dir / f"{mat['id']}.mp4"
        if mat.get("unavailable") and not args.include_unavailable:
            skipped += 1
            continue
        if dest.exists() and not args.force:
            if mat["id"] not in idx["materials"]:
                idx["materials"][mat["id"]] = index_entry(mat, dest)
            skipped += 1
            continue
        print(f"[{i}/{len(mats)}] {mat['id']} <- {mat['source']}", file=sys.stderr)
        try:
            if mat["source"] == "youtube":
                # 74 本を無停止で叩くと YouTube のボット判定に引っかかるので、
                # 1 本ごとに間隔を空ける
                if downloaded_yt:
                    time.sleep(args.delay)
                download_youtube(mat["url"], dest, args.cookies_from_browser)
                downloaded_yt = True
            else:
                download_direct(mat["url"], dest)
            idx["materials"][mat["id"]] = index_entry(mat, dest)
            ok += 1
        except BotCheckError as exc:
            save_index(idx)
            print(f"  FAILED: {exc}\n", file=sys.stderr)
            print(
                "YouTube のボット判定に当たりました。以降も全て失敗するので中断します。\n"
                "対処:\n"
                "  1. 数十分〜数時間おいてから再実行する (取得済みはスキップされます)\n"
                "  2. --delay を大きくする (例: --delay 5)\n"
                "  3. ログイン済みブラウザの Cookie を使う:\n"
                "       nm-fetch.py sync --cookies-from-browser firefox\n"
                f"\n途中経過: downloaded={ok} skipped={skipped} failed={failed}",
                file=sys.stderr,
            )
            return 1
        except Exception as exc:  # noqa: BLE001 - 1本失敗しても続行したい
            print(f"  FAILED: {exc}", file=sys.stderr)
            failed += 1
        if ok and ok % 5 == 0:
            save_index(idx)
    save_index(idx)
    print(f"downloaded={ok} skipped={skipped} failed={failed} -> {dest_dir}")
    return 1 if failed and not ok else 0


def cmd_index(args) -> int:
    catalog = load_catalog()
    by_id = {m["id"]: m for m in catalog["materials"]}
    idx = load_index()
    for path in sorted(materials_dir().glob("*.mp4")):
        mat = by_id.get(path.stem, {"id": path.stem, "name": path.stem, "source": "local"})
        idx["materials"][path.stem] = index_entry(mat, path)
        print(f"indexed {path.stem}", file=sys.stderr)
    # ファイルが消えた素材はインデックスから外す
    for mid in [k for k, v in idx["materials"].items() if not Path(v["file"]).exists()]:
        del idx["materials"][mid]
    save_index(idx)
    print(f"{len(idx['materials'])} materials indexed -> {index_path()}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="猫ミーム素材の収集")
    sub = ap.add_subparsers(dest="cmd", required=True)

    def add_common(p):
        p.add_argument("--source", choices=["all", "memesstyle", "youtube"], default="all")
        p.add_argument("--only", type=lambda s: s.split(","), help="素材IDをカンマ区切りで指定")

    p = sub.add_parser("list", help="素材一覧")
    add_common(p)
    p.add_argument("--json", action="store_true")
    p.add_argument("--tag", type=lambda s: s.split(","),
                   help="タグで絞り込み (例: --tag ダンス,オチ)")
    p.add_argument("--search", help="ID/名前/タグの部分一致で絞り込み")
    p.add_argument("--all", action="store_true",
                   help="採用対象以外も含めて全素材を表示する")
    p.set_defaults(func=cmd_list)

    p = sub.add_parser("sync", help="素材をダウンロード")
    add_common(p)
    p.add_argument("--force", action="store_true", help="既存ファイルも再取得")
    p.add_argument("--include-unavailable", action="store_true",
                   help="配布元で削除済みとマークされた素材も試行する")
    p.add_argument("--delay", type=float, default=2.0,
                   help="YouTube 素材のリクエスト間隔 (秒)。既定 2.0。"
                        "ボット判定に当たるなら大きくする")
    p.add_argument("--cookies-from-browser", metavar="BROWSER",
                   help="ログイン済みブラウザの Cookie を使う (firefox / chrome など)。"
                        "ボット判定を回避できる")
    p.set_defaults(func=cmd_sync)

    p = sub.add_parser("refresh-catalog", help="配布元を再スクレイプして catalog.json 更新")
    p.add_argument("--out")
    p.set_defaults(func=cmd_refresh_catalog)

    p = sub.add_parser("index", help="ローカル素材を再スキャンして index.json 更新")
    p.set_defaults(func=cmd_index)

    args = ap.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())

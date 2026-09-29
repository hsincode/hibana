#!/usr/bin/env python3
"""背景素材の収集 (みんちりえ) と、レガシー用の生成コマンド.

スキル方針: 台本の背景は **みんちりえだけ** を使う。
  - minchi : min-chi.material.jp の背景イラスト。1920x1080 JPEG。
             商用利用可・クレジット不要・加工可 (再配布は不可)
  - gen    : 旧・ffmpeg 生成 (単色/グラデ/集中線)。nm-build はこれを拒否する。
             コマンドは互換のため残しているが、台本では使わない。

サブコマンド:
  list            背景の一覧 (既定 --source minchi)
  fetch           みんちりえの背景をダウンロード
  gen             (レガシー) ffmpeg 生成の背景を書き出す
  refresh-catalog みんちりえを再スクレイプして bg-catalog.json を更新

保存先は $NEKO_MEME_DIR/backgrounds (既定 ~/.cache/neko-meme/backgrounds)。
"""

from __future__ import annotations

import argparse
import html
import json
import os
import re
import shutil
import subprocess
import sys
import time
import unicodedata
import urllib.request
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parent.parent
BG_CATALOG = SKILL_DIR / "assets" / "bg-catalog.json"

UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) neko-meme-skill/1.0"}
MINCHI = "https://min-chi.material.jp"
MINCHI_SITEMAP = f"{MINCHI}/sitemap.xml"

SIZE_PRESETS = {"shorts": (1080, 1920), "square": (1080, 1080), "landscape": (1920, 1080)}


def root_dir() -> Path:
    return Path(os.environ.get("NEKO_MEME_DIR", Path.home() / ".cache" / "neko-meme"))


def bg_dir() -> Path:
    return root_dir() / "backgrounds"


# --------------------------------------------------------------------------
# ffmpeg 生成プリセット
# --------------------------------------------------------------------------

# 各背景は (説明, lavfi ソース, 追加フィルタ) で定義する。
# {w}/{h} はサイズに、{d} は対角長 (放射状の計算用) に置換される。
PRESETS: dict[str, tuple[str, str, str]] = {
    # --- 単色・グラデーション: テキストが乗る前提なので彩度は抑えめ ---
    "night": (
        "紺〜藍のグラデ。汎用のベース背景",
        "gradients=s={w}x{h}:c0=#12131a:c1=#2b2f45:x0=0:y0=0:x1={w}:y1={h}",
        "",
    ),
    "sunset": (
        "夕焼け。エモい〆やオチに",
        "gradients=s={w}x{h}:c0=#2b1055:c1=#ff8b3d:x0=0:y0=0:x1=0:y1={h}",
        "",
    ),
    "mint": (
        "明るいミント。ポップな導入に",
        "gradients=s={w}x{h}:c0=#d8f5e8:c1=#6fc7a8:x0=0:y0=0:x1={w}:y1={h}",
        "",
    ),
    "mono": (
        "無彩色グレー。文字を主役にしたいとき",
        "gradients=s={w}x{h}:c0=#e9e9ec:c1=#a9a9b2:x0=0:y0=0:x1=0:y1={h}",
        "",
    ),
    "danger": (
        "暗赤。ヤバい展開・失敗オチに",
        "gradients=s={w}x{h}:c0=#2a0505:c1=#7a1414:x0=0:y0=0:x1={w}:y1={h}",
        "",
    ),
    "office": (
        "冷たい青灰。仕事・会議シーンに",
        "gradients=s={w}x{h}:c0=#1b2431:c1=#48607a:x0=0:y0=0:x1=0:y1={h}",
        "",
    ),
    # --- 演出系 ---
    "spotlight": (
        "中央スポットライト。被写体を目立たせる",
        "color=c=#0d0d12:s={w}x{h}",
        # 中心からの距離で明るさを落とす
        "geq=r='255*clip(1.15-1.4*hypot(X-{w}/2\\,Y-{h}/2)/({d}/2)\\,0.05\\,1)*0.35':"
        "g='255*clip(1.15-1.4*hypot(X-{w}/2\\,Y-{h}/2)/({d}/2)\\,0.05\\,1)*0.35':"
        "b='255*clip(1.15-1.4*hypot(X-{w}/2\\,Y-{h}/2)/({d}/2)\\,0.05\\,1)*0.45'",
    ),
    "focus": (
        "白地に黒の集中線。ツッコミ・オチの一枚",
        "color=c=white:s={w}x{h}",
        # 角度を 48 分割して交互に黒帯。中心付近 (r<0.28) は線を消して被写体を守る
        "geq=r='255*(1-lt(mod(floor((atan2(Y-{h}/2\\,X-{w}/2)+3.14159)/6.28318*48)\\,2)\\,1)"
        "*clip((hypot(X-{w}/2\\,Y-{h}/2)/({d}/2)-0.28)/0.30\\,0\\,1))':"
        "g='255*(1-lt(mod(floor((atan2(Y-{h}/2\\,X-{w}/2)+3.14159)/6.28318*48)\\,2)\\,1)"
        "*clip((hypot(X-{w}/2\\,Y-{h}/2)/({d}/2)-0.28)/0.30\\,0\\,1))':"
        "b='255*(1-lt(mod(floor((atan2(Y-{h}/2\\,X-{w}/2)+3.14159)/6.28318*48)\\,2)\\,1)"
        "*clip((hypot(X-{w}/2\\,Y-{h}/2)/({d}/2)-0.28)/0.30\\,0\\,1))'",
    ),
    "focus-red": (
        "赤の集中線。怒り・絶望の強調に",
        "color=c=#ffd6d6:s={w}x{h}",
        "geq=r='255-100*lt(mod(floor((atan2(Y-{h}/2\\,X-{w}/2)+3.14159)/6.28318*40)\\,2)\\,1)"
        "*clip((hypot(X-{w}/2\\,Y-{h}/2)/({d}/2)-0.28)/0.30\\,0\\,1)':"
        "g='214-190*lt(mod(floor((atan2(Y-{h}/2\\,X-{w}/2)+3.14159)/6.28318*40)\\,2)\\,1)"
        "*clip((hypot(X-{w}/2\\,Y-{h}/2)/({d}/2)-0.28)/0.30\\,0\\,1)':"
        "b='214-190*lt(mod(floor((atan2(Y-{h}/2\\,X-{w}/2)+3.14159)/6.28318*40)\\,2)\\,1)"
        "*clip((hypot(X-{w}/2\\,Y-{h}/2)/({d}/2)-0.28)/0.30\\,0\\,1)'",
    ),
    "rays": (
        "淡い放射。ハッピー・成功オチに",
        "color=c=#fff3c4:s={w}x{h}",
        "geq=r='255-25*lt(mod(floor((atan2(Y-{h}/2\\,X-{w}/2)+3.14159)/6.28318*24)\\,2)\\,1)':"
        "g='243-30*lt(mod(floor((atan2(Y-{h}/2\\,X-{w}/2)+3.14159)/6.28318*24)\\,2)\\,1)':"
        "b='196-45*lt(mod(floor((atan2(Y-{h}/2\\,X-{w}/2)+3.14159)/6.28318*24)\\,2)\\,1)'",
    ),
    "grid": (
        "方眼。説明・回想パートに",
        "color=c=#f4f4f0:s={w}x{h}",
        "geq=r='244-24*(lt(mod(X\\,72)\\,3)+lt(mod(Y\\,72)\\,3))':"
        "g='244-30*(lt(mod(X\\,72)\\,3)+lt(mod(Y\\,72)\\,3))':"
        "b='240-20*(lt(mod(X\\,72)\\,3)+lt(mod(Y\\,72)\\,3))'",
    ),
    "dots": (
        "ドット。かわいい系の導入に",
        "color=c=#ffe9f2:s={w}x{h}",
        "geq=r='255-20*lt(hypot(mod(X\\,80)-40\\,mod(Y\\,80)-40)\\,10)':"
        "g='233-40*lt(hypot(mod(X\\,80)-40\\,mod(Y\\,80)-40)\\,10)':"
        "b='242-25*lt(hypot(mod(X\\,80)-40\\,mod(Y\\,80)-40)\\,10)'",
    ),
    "noise": (
        "紙っぽいざらつき。レトロ・語り調に",
        "color=c=#efe7d8:s={w}x{h}",
        "noise=alls=14:allf=t+u,eq=saturation=0.85",
    ),
    "flash": (
        "白フラッシュ。カットイン用",
        "color=c=white:s={w}x{h}",
        "",
    ),
    "black": (
        "黒ベタ。暗転・間に",
        "color=c=black:s={w}x{h}",
        "",
    ),
}


# --------------------------------------------------------------------------
# みんちりえ
# --------------------------------------------------------------------------


def http_get(url: str) -> str:
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.read().decode("utf-8", "replace")


def load_bg_catalog() -> dict:
    try:
        with open(BG_CATALOG, encoding="utf-8") as fh:
            return json.load(fh)
    except FileNotFoundError:
        return {"version": 1, "materials": []}


def parse_minchi_page(url: str, page: str) -> dict | None:
    """素材ページから DL に必要な情報を取り出す.

    ダウンロードリンクは JS が組み立てているので HTML には出てこない。
    ページ末尾の `var m_dir / m_file_name / m_ext / m_names` から
    /mc/materials/<dir>/<file>/<file>_<n>.<ext> を自前で復元する。
    """
    def var(name: str) -> str | None:
        m = re.search(rf'var\s+{name}\s*=\s*"([^"]*)"', page)
        return m.group(1) if m else None

    directory, file_name = var("m_dir"), var("m_file_name")
    variants: list[dict] = []
    # 新しいページは [名前, 拡張子, 名前, 拡張子, ...] の平坦な配列で、
    # 1 素材の中に jpg (完成絵) と png (レイヤ分け) が混在する
    m_nameexts = re.search(r"var\s+m_nameexts\s*=\s*\[(.*?)\]", page, re.S)
    if m_nameexts:
        flat = [html.unescape(x) for x in re.findall(r'"([^"]*)"', m_nameexts.group(1))]
        variants = [{"name": flat[i], "ext": flat[i + 1]} for i in range(0, len(flat) - 1, 2)]
    else:
        m_names = re.search(r"var\s+m_names\s*=\s*\[(.*?)\]", page, re.S)
        ext = var("m_ext") or "jpg"
        if m_names:
            variants = [{"name": html.unescape(x), "ext": ext}
                        for x in re.findall(r'"([^"]*)"', m_names.group(1))]
    if not (directory and file_name and variants):
        return None

    title = re.search(r"<title>(.*?)</title>", page, re.S)
    title = html.unescape(title.group(1)).split("｜")[0].strip() if title else file_name
    title = re.sub(r"^【[^】]*】\s*|\s*【[^】]*】$", "", title).strip()
    tags = sorted({html.unescape(t).strip() for t in re.findall(r'/tag/[^"]*"[^>]*>([^<]+)<', page)}
                  - {"フリー素材", "背景"})
    return {
        "id": f"mc-{file_name}",
        "title": unicodedata.normalize("NFC", title),
        "kind": "写実系" if directory.endswith("-c") else "抽象系",
        "dir": directory,
        "file": file_name,
        "variants": [{"name": unicodedata.normalize("NFC", v["name"]), "ext": v["ext"]}
                     for v in variants],
        "tags": [unicodedata.normalize("NFC", t) for t in tags],
        "page": url,
    }


def variant_url(mat: dict, index: int) -> str:
    ext = mat["variants"][index - 1]["ext"]
    return f"{MINCHI}/mc/materials/{mat['dir']}/{mat['file']}/{mat['file']}_{index}.{ext}"


def cmd_refresh_catalog(args) -> int:
    index_xml = http_get(MINCHI_SITEMAP)
    pages: list[str] = []
    for sub in re.findall(r"<loc>(.*?)</loc>", index_xml):
        try:
            pages += re.findall(r"<loc>(.*?)</loc>", http_get(sub))
        except Exception as exc:  # noqa: BLE001
            print(f"  sitemap 取得失敗: {sub} ({exc})", file=sys.stderr)
    bg_pages = [u for u in dict.fromkeys(pages) if "/fm/bg" in u]
    print(f"素材ページ {len(bg_pages)} 件を取得中...", file=sys.stderr)

    mats = []
    for i, url in enumerate(bg_pages, 1):
        try:
            mat = parse_minchi_page(url, http_get(url))
        except Exception as exc:  # noqa: BLE001
            print(f"  [{i}] {url} 失敗: {exc}", file=sys.stderr)
            continue
        if mat:
            mats.append(mat)
        else:
            print(f"  [{i}] {url} 解析できず", file=sys.stderr)
        time.sleep(args.delay)  # 個人サイトなので間隔を空ける

    catalog = {
        "version": 1,
        "source": {
            "site": MINCHI,
            "name": "みんちりえ",
            "license": "商用利用OK / 利用報告不要 / クレジット不要 / 加工OK / "
                       "素材としての再配布・販売は不可",
        },
        "materials": sorted(mats, key=lambda m: (m["kind"], m["id"])),
    }
    BG_CATALOG.parent.mkdir(parents=True, exist_ok=True)
    with open(BG_CATALOG, "w", encoding="utf-8") as fh:
        json.dump(catalog, fh, ensure_ascii=False, indent=1)
        fh.write("\n")
    total = sum(len(m["variants"]) for m in mats)
    print(f"bg-catalog 更新: {BG_CATALOG} ({len(mats)} 素材 / {total} 枚)")
    return 0


def select(mats: list[dict], only, tags, query, show_all: bool = False) -> list[dict]:
    # 既定は「猫ミームでよく使われる定番背景」だけ。139 素材を並べると
    # そこから自由に選んでよいと受け取られる
    if not show_all and not only:
        rec = [m for m in mats if m.get("recommended")]
        if rec:
            mats = rec
    if only:
        wanted = set(only)
        mats = [m for m in mats if m["id"] in wanted or m["file"] in wanted]
        missing = wanted - {m["id"] for m in mats} - {m["file"] for m in mats}
        if missing:
            raise SystemExit(f"不明な背景 ID: {', '.join(sorted(missing))}")
    if tags:
        mats = [m for m in mats if set(tags) & set(m["tags"])]
    if query:
        q = query.lower()
        mats = [m for m in mats if q in m["id"].lower() or q in m["title"].lower()
                or any(q in t.lower() for t in m["tags"])
                or any(q in v["name"].lower() for v in m["variants"])]
    return mats


def cmd_fetch(args) -> int:
    catalog = load_bg_catalog()
    mats = select(catalog["materials"], args.only, args.tag, args.search)
    if not mats:
        print("該当する背景がありません。nm-bg.py list --source minchi で確認してください",
              file=sys.stderr)
        return 1
    out_dir = Path(args.dir).expanduser() if args.dir else bg_dir()
    out_dir.mkdir(parents=True, exist_ok=True)

    ok = skipped = failed = 0
    for mat in mats:
        for i, variant in enumerate(mat["variants"], 1):
            if args.variant and i not in args.variant:
                continue
            if args.jpg_only and variant["ext"] != "jpg":
                continue  # png はレイヤ分け素材。背景 1 枚として使うなら jpg で足りる
            dest = out_dir / f"{mat['id']}-{i}.{variant['ext']}"
            if dest.exists() and not args.force:
                skipped += 1
                continue
            url = variant_url(mat, i)
            try:
                req = urllib.request.Request(url, headers=UA)
                with urllib.request.urlopen(req, timeout=120) as resp, open(dest, "wb") as fh:
                    shutil.copyfileobj(resp, fh)
                print(f"  {dest.name}  ({variant['name']})")
                ok += 1
            except Exception as exc:  # noqa: BLE001
                print(f"  FAILED {url}: {exc}", file=sys.stderr)
                failed += 1
            time.sleep(args.delay)
    print(f"\ndownloaded={ok} skipped={skipped} failed={failed} -> {out_dir}")
    print("台本では bg: " + (f"{mats[0]['id']}-1" if mats else "<id>-<n>") + " のように参照します")
    return 1 if failed and not ok else 0


# --------------------------------------------------------------------------
# 生成
# --------------------------------------------------------------------------


def parse_size(spec: str) -> tuple[int, int]:
    if spec in SIZE_PRESETS:
        return SIZE_PRESETS[spec]
    w, _, h = spec.partition("x")
    return int(w), int(h)


def render(name: str, size: tuple[int, int], out: Path) -> None:
    _desc, source, extra = PRESETS[name]
    w, h = size
    subs = {"w": w, "h": h, "d": round((w * w + h * h) ** 0.5)}
    args = ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", source.format(**subs)]
    if extra:
        args += ["-vf", extra.format(**subs)]
    args += ["-frames:v", "1", str(out)]
    res = subprocess.run(args, capture_output=True, text=True)
    if res.returncode != 0:
        print(res.stderr, file=sys.stderr)
        raise SystemExit(f"背景 {name} の生成に失敗しました")


def cmd_gen(args) -> int:
    size = parse_size(args.size)
    out_dir = Path(args.dir).expanduser() if args.dir else bg_dir()
    out_dir.mkdir(parents=True, exist_ok=True)
    names = args.only or list(PRESETS)
    unknown = [n for n in names if n not in PRESETS]
    if unknown:
        raise SystemExit(f"不明な背景: {', '.join(unknown)}")
    for name in names:
        out = out_dir / f"{name}.png"
        render(name, size, out)
        print(f"  {out}")
    print(f"\n{len(names)} 枚を {size[0]}x{size[1]} で生成 -> {out_dir}")
    return 0


# --------------------------------------------------------------------------
# 一覧
# --------------------------------------------------------------------------


def cmd_list(args) -> int:
    have = {p.stem for p in bg_dir().glob("*")} if bg_dir().exists() else set()
    if args.source in ("all", "gen"):
        print("== ffmpeg 生成 (nm-bg.py gen) ==")
        for name, (desc, _, _) in PRESETS.items():
            mark = "*" if name in have else " "
            print(f"{mark} {name:<12} {desc}")
    if args.source in ("all", "minchi"):
        catalog = load_bg_catalog()
        mats = select(catalog["materials"], args.only, args.tag, args.search,
                      getattr(args, "all", False))
        total = len(catalog["materials"])
        scope = ("定番のみ / 全 %d 素材は --all" % total
                 if not getattr(args, "all", False) and not args.only
                 else "全 %d 素材から" % total)
        print(f"\n== みんちりえ (nm-bg.py fetch) / {len(mats)} 素材 ({scope}) ==")
        for m in mats:
            got = sum(1 for i in range(1, len(m["variants"]) + 1)
                      if f"{m['id']}-{i}" in have)
            mark = "*" if got else " "
            tags = f"  [{'/'.join(m['tags'][:6])}]" if m["tags"] else ""
            print(f"{mark} {m['id']:<28} {m['kind']}  {m['title']} "
                  f"({len(m['variants'])}枚{f' / 取得済 {got}' if got else ''}){tags}")
            if args.variants:
                for i, v in enumerate(m["variants"], 1):
                    print(f"      {m['id']}-{i}  {v['name']}  .{v['ext']}")
    print(f"\n保存先: {bg_dir()}  ('*' = 取得済み)")
    if args.source in ("all", "gen"):
        print("注意: gen 背景は nm-build が拒否します。台本はみんちりえ ID のみ。")
    if not getattr(args, "all", False):
        print("台本の bg: はみんちりえ定番の <ID>-<何枚目> のみ "
              "(例: mc-medium_office-1)。--all や gen は使わないこと。")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="猫ミーム用の背景素材の収集 (みんちりえ)")
    sub = ap.add_subparsers(dest="cmd", required=True)

    def add_filters(p):
        p.add_argument("--only", type=lambda s: s.split(","), help="ID をカンマ区切りで指定")
        p.add_argument("--tag", type=lambda s: s.split(","), help="タグで絞り込み")
        p.add_argument("--search", help="ID/名前/タグの部分一致で絞り込み")

    p = sub.add_parser("list", help="背景の一覧 (既定: みんちりえ定番)")
    p.add_argument("--source", choices=["all", "minchi", "gen"], default="minchi",
                   help="既定 minchi。gen/all はレガシー表示用")
    p.add_argument("--variants", action="store_true", help="各素材の枚数を展開して表示")
    p.add_argument("--all", action="store_true", help="定番以外も含めて全素材を表示する")
    add_filters(p)
    p.set_defaults(func=cmd_list)

    p = sub.add_parser("fetch", help="みんちりえの背景をダウンロード")
    add_filters(p)
    p.add_argument("--variant", type=lambda s: [int(x) for x in s.split(",")],
                   help="何枚目を取るか (例: --variant 1,3)。省略時は全部")
    p.add_argument("--dir", help="出力先 (既定 $NEKO_MEME_DIR/backgrounds)")
    p.add_argument("--force", action="store_true", help="既存ファイルも再取得")
    p.add_argument("--jpg-only", action="store_true",
                   help="レイヤ分け png を飛ばして完成絵 (jpg) だけ取る")
    p.add_argument("--delay", type=float, default=0.4, help="リクエスト間隔 (秒)")
    p.set_defaults(func=cmd_fetch)

    p = sub.add_parser("gen", help="(レガシー) ffmpeg 生成背景。台本では使わない")
    p.add_argument("--size", default="shorts", help="shorts / square / landscape / WxH")
    p.add_argument("--only", type=lambda s: s.split(","))
    p.add_argument("--dir", help="出力先 (既定 $NEKO_MEME_DIR/backgrounds)")
    p.set_defaults(func=cmd_gen)

    p = sub.add_parser("refresh-catalog", help="みんちりえを再スクレイプ")
    p.add_argument("--delay", type=float, default=0.3, help="リクエスト間隔 (秒)")
    p.set_defaults(func=cmd_refresh_catalog)

    args = ap.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())

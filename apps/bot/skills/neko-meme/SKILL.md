---
name: neko-meme
description: >
  台本から猫ミーム動画 (cat meme) を ffmpeg で自動生成する。素材の収集
  (memesstyle.com / neko-meme-site の猫ミーム素材、みんちりえの背景イラスト)、
  グリーンバック合成、日本語テロップ焼き込み、BGM/ナレーション合成、
  ラウドネス正規化までを行う。
  「猫ミームを作って」「cat meme 動画」「猫ミーム素材をダウンロード」
  「猫ミームの台本から動画」「/neko-meme」で起動する。
  使ってよい猫素材と背景は決まっており (nm-fetch.py list /
  nm-bg.py list --source minchi)。背景はみんちりえ定番のみ。
  候補外を使うと nm-build.py --check / ビルドが失敗する。
metadata:
  short-description: "台本から猫ミーム動画を生成する"
---

# 猫ミーム動画メーカー

台本 (YAML/JSON) を書いて `nm-build.py` に渡すと、グリーンバックの猫素材を
背景に合成し、テロップを焼き込んだ動画が出る。既定は 16:9 (1920x1080)。
縦型 Shorts にするときだけ台本に `size: shorts` と書く。

## hibana での実行（これだけやる）

sandbox に **マウント済み**。スクリプトもカタログも動画も **workspace にコピーしない**。
参照 (`references/` `assets/`) は **詰まったときだけ** `read_skill_file`。先に全部開かない。

| パス | 中身 |
|------|------|
| `/skills/neko-meme/` | このスキル（`scripts/` `assets/` `references/`）。**読み取り専用** |
| `$NEKO_MEME_DIR`（`/skill-cache/neko-meme`） | ダウンロードした猫動画・背景・`index.json`。**workspace TTL の外** |

**手順は 3 手。途中で完成と言わない。`send_file` が ok になるまで。**

1. `write_files` で `script.yaml`（**8〜15 シーン / 1 テロップ 20 字 / 合計 45 秒以内**。`size` は `landscape` か `shorts`）
2. `bash`（**`timeout_secs=300` 必須**）:

```bash
python3 /skills/neko-meme/scripts/nm-go.py script.yaml -o out.mp4 --discord
```

3. `send_file(path=out.mp4)`。HTML ではない。

`nm-go.py` が未取得の **使用 ID だけ** sync / 背景 fetch し、720p・7.5MB 以下に収めてからレンダする。
切れたら **同じコマンドを再実行**（取得済みはスキップ）。YouTube がボット判定なら `vpn_connect` して再実行。
フォントは sandbox の IPA（`$NEKO_MEME_FONT` 不要）。

## 先に守ること

このスキルは「手元にある全素材から自由に選ぶ」道具ではない。
**使ってよい素材は決まっている。**

1. **猫は `nm-fetch.py list` に出る 24 本だけ**を使う。手元には 93 本あるが、
   残りは候補外 (`--all` で見える)。同じ和名で別動画がある素材が複数あるので
   (「眠そうな猫」= `yt-sleepy-cat` / `-2` / `-3`)、**必ず ID で指定する**。
2. **背景はみんちりえだけ。** `nm-bg.py list --source minchi` に出る定番 9 素材
   (`mc-…-n` 形式) を使う。生成背景 (`mint` / `focus` 等)・色・グラデ・任意
   パス・手持ち画像は**使わない** (チェックで失敗する)。
3. **背景は静止画のまま**。`bg_zoom` は入れない。猫の動きが主役。
4. **書いたら `nm-build.py <台本> --check` を必ず通す。** 候補外の素材・背景、
   素材のグリーン区間からの逸脱、未取得素材をここで検出する。`--check` 失敗は
   ビルドも失敗する。

候補外を意図的に使うなら台本に `allowed_materials` / `allowed_backgrounds` を
明示する (背景はみんちりえ ID に限る)。猫だけ全開放するなら
`allow_any_material: true`。

配役の具体 (どの猫をどの場面に置くか) は `references/casting.md`。

```
/skills/neko-meme/scripts/nm-go.py         不足取得 + レンダ（Discord は --discord）
/skills/neko-meme/scripts/nm-fetch.py      猫素材の収集・カタログ管理
/skills/neko-meme/scripts/nm-bg.py         背景素材の収集 (みんちりえ)
/skills/neko-meme/scripts/nm-build.py      台本 → 動画のレンダリング
/skills/neko-meme/assets/catalog.json      猫素材 93 本のカタログ
/skills/neko-meme/assets/bg-catalog.json   背景カタログ (みんちりえ)
/skills/neko-meme/assets/example.yaml      短いサンプル（手元確認用）
/skills/neko-meme/assets/example-black-company.yaml  手元フル (16:9 / 110秒)。Discord には使わない
/skills/neko-meme/references/              詰まったときだけ読む（先に全部開かない）
```

## 前提

sandbox に入っているもの（足りないと言わない）:

- `ffmpeg` / `ffprobe`
- `yt-dlp`（YouTube 由来の素材）
- `python3` + `PyYAML`（YAML 台本）
- 日本語フォント（IPA Gothic / `fc-match`）

素材と背景は `$NEKO_MEME_DIR`（sandbox では `/skill-cache/neko-meme`）。

## 手順

### 1. 初回セットアップ (素材と背景を用意する)

```bash
S=/skills/neko-meme/scripts
# Discord では nm-go.py が使用 ID だけ取る。全件 sync は手元・温め用。
python3 $S/nm-fetch.py sync            # 猫素材 (約 90MB, 3〜5 分。timeout_secs=300)
python3 $S/nm-bg.py fetch --jpg-only --only \
  mc-medium_office,mc-office,mc-building_hallway,mc-single_room3,mc-living2,\
  mc-inside_train,mc-station_platform,mc-hospital_lobby,mc-machine_room
```

2 行目が定番背景 9 素材 (30 枚)。`nm-bg.py list --source minchi` と同じ内容。
背景はこれだけ。生成背景 (`nm-bg.py gen`) はスキルでは使わない。

`--source memesstyle` だけなら yt-dlp 不要で 10 秒ほどで終わる。
既に取得済みの素材はスキップされるので、何度実行しても安全。

### 2. 使う素材を選ぶ

**台本を書く前に必ず一覧を見ること。** ID を推測で書かない。

```bash
S=/skills/neko-meme/scripts
python3 $S/nm-fetch.py list                  # 採用対象の猫 24 本
python3 $S/nm-fetch.py list --tag オチ,ツッコミ  # タグで絞る
python3 $S/nm-bg.py list --source minchi     # 背景はこれだけ (定番 9)
python3 $S/nm-bg.py list --source minchi --variants --only mc-medium_office
```

`list` は**既定では候補だけ**を出す (`--all` で全件)。`*` が取得済み。
素材の性格とタグは `references/materials.md`、配役は `references/casting.md`。

背景は同じ場所の **日中 / 夕方 / 夜・照明ON / 夜・照明OFF** が揃っている素材が
多い (`--variants` で確認)。時系列どおりに並べるだけで時間の経過が画で伝わる。
台本では `bg: mc-medium_office-1` のように **素材 ID + 枚数目** で指定する。

### 3. 台本を書く

```bash
python3 /skills/neko-meme/scripts/nm-build.py --init script.yaml   # 雛形 → /workspace
```

最小構成:

```yaml
size: landscape        # 省略時も 16:9。縦型 Shorts なら shorts
crop: auto             # 素材ごとの被写体サイズ差を吸収する
pos: bottom-flush      # 元動画の端で切れている素材の切断面を画面下端に隠す
scenes:
  - text: "月曜 6:30"
    cat: yt-sleeping-cat
    bg: mc-single_room3-4
    scale: 0.25
    duration: 5.0
  - text: "上司「今日から出社な」"
    cat: yt-talking-and-huh
    bg: mc-medium_office-1
    scale: 0.54
    duration: 5.5
  - text: "え？"
    cat: yt-cat-huh
    bg: mc-medium_office-1
    scale: 0.33
    duration: 4.0
```

全キーの意味は `references/script-format.md` を読むこと。
完成形は `/skills/neko-meme/assets/example-black-company.yaml` (16:9 / 110秒 / 23シーン)。

### 4. 検証してからレンダリング

```bash
S=/skills/neko-meme/scripts
python3 $S/nm-build.py script.yaml --check
python3 $S/nm-build.py script.yaml --scene 3 -o preview.mp4
# Discord へ送るなら nm-go --discord（8MB 超えの 1080p は send_file が拒否する）
python3 $S/nm-go.py script.yaml -o out.mp4 --discord   # timeout_secs=300
```

`--check` は合計尺に加えて、素材の未取得と「グリーン区間からの逸脱」を報告する。
**書いたら必ず一度は通すこと。** 縦型 Shorts は 60 秒まで。

## 台本を書くときのコツ

- **1 シーン 1 メッセージ**。テロップは 20 文字前後まで。長いと自動折り返しで
  3 行以上になって画面が潰れる。
- **テンポ**。導入 2〜3 秒 → 展開 3 秒 → オチ 1.5〜2 秒。オチは短く切る。
- **オチに強い素材を使う**: `laughing-pointing-cat` (煽り) / `yt-wet-cat` (絶望) /
  `yt-cat-hits-cat` (ツッコミ) / `waving-cat` (締め)。
- **会話シーンは 2 匹入りの素材**を使う: `talking-cats` / `yt-talking-and-huh` /
  `yt-goat-and-huh`。
- **背景で時間を語らせる**: みんちりえの同じ場所の日中/夕方/夜を時系列に並べる。
  感情のカットも場所背景のまま尺を短くする (生成背景は使わない)。
- **写真・イラスト背景には `text_style: {box: true}` を必ず付ける**。白抜き文字
  だけだと明るい背景で読めなくなる。
- **`crop: auto` と `pos: bottom-flush` はほぼ常に入れる**。前者は素材ごとの
  被写体サイズ差を吸収し、後者は元動画の端で切れている素材の切断面を隠す。
- **素材の音が何回鳴るかで尺を決める**。同じ鳴き声を数回繰り返す素材が多く、
  1 回目で切ると言いかけで終わって聞こえる (`yt-cat-huh` の「え？」は
  0.6s / 4.2s / 7.9s の 3 回。5 秒取ると 2 回入る)。
- **背景はそのカットで何をしているかで選ぶ**。自席の作業に応接室を当てない。
- **背景は静止画のままでよい**。猫の動きが主役なので、背景を動かすと視線が散る。
- `duration` を省略すると素材の尺そのまま (上限 8 秒) になる。ミームとしては
  長すぎることが多いので、基本は明示する。

## つまずきやすい点

- **猫が消える / 半透明になる**: `similarity` を明示指定した場合に起きる。既定では
  キー色の彩度から自動計算しているので、まず指定を外して試す。それでも縁に緑が
  残るなら `similarity` を 0.02 刻みで上げる。
- **素材が緑のまま抜けない**: `nm-fetch.py list` に `key=` が出ていない素材は
  グリーンバックではない (`teemo` / `teemo-hit` はゲーム映像)。`key: "0x00FF00"`
  で強制指定はできるが、素材を変えたほうが早い。
- **黒帯が乗る**: ピラーボックス付き素材は `index.json` の `crop` で自動除去して
  いる。素材を手動で足したときは `nm-fetch.py index` を実行して再検出させる。
- **合成結果に黒画面や英字カードが映り込む**: 一部の素材は元動画の尻に
  タイトルカードが焼き込まれている (`yt-goat-talking` は 25.9 秒中グリーンなのは
  頭の 8.5 秒だけ)。`index.json` の `keyed_range` に有効区間があり、`--check` が
  逸脱を警告し、レンダリング時は `start` を自動で区間内に寄せる (警告付き)。
- **YouTube 素材が落とせない**: 6 本は配布元 (YouTube) で削除済み。`list` に
  `x` が付き、`sync` は自動でスキップする。代替素材は catalog の `alt` にある。
- **配布元が更新された**: `nm-fetch.py refresh-catalog` / `nm-bg.py refresh-catalog`
  で再スクレイプする。既存 ID・タグは URL で突き合わせて引き継がれる。
- **音が小さい / 割れる**: 出力は既定で -14 LUFS / -1.5 dBTP に正規化している
  (YouTube の基準)。切りたいときは台本に `loudness: false`。
- **`Sign in to confirm you're not a bot`**: YouTube 素材は 74 本あるので、
  一気に落とすとボット判定に当たる。`sync` は既定で 1 本ごとに 2 秒空けており、
  判定に当たった時点で中断する (以降も全部失敗するため)。取得済みはスキップ
  されるので、時間をおいて再実行すれば続きから進む。急ぐなら `--delay 5`。
  sandbox にブラウザ cookie は無いので `--cookies-from-browser` は使えない。
  VPN 接続中なら出口が変わるので `vpn_connect` してから再 sync してよい。

## ナレーションを付ける

`voice:` に音声ファイルを指定すると、そのシーンの尺は音声長 + 0.4 秒になる。
wav は workspace に置いて相対パスで渡す（`/tmp` はコンテナ終了で消える）。

```yaml
scenes:
  - text: "そして事件は起きた"
    cat: yt-zoning-out
    voice: line1.wav
```

## 素材の出どころと利用範囲

### 猫素材

- **memesstyle.com** — Cloudflare R2 に mp4 直置き。19 本。ほぼ全てグリーンバック。
- **neko-meme-site.vercel.app** (猫ミーム情報局 / @ShariSamon) — YouTube 素材への
  リンク集。**4 ページ・74 本** (うち 6 本は元動画が削除済み)。猫以外 (犬・ヤギ・
  羊・猿) や 2 匹以上の組み合わせ素材も含み、配役の幅はここが一番広い。

いずれも第三者が公開しているミーム素材で、明示された利用規約は無い。
個人利用・SNS 投稿の範囲を想定している。商用利用や再配布をする場合は
各配布元・投稿者に確認すること。

### 背景素材

- **みんちりえ** (https://min-chi.material.jp/) **のみ**使う。
  カタログ上 139 素材あるが、スキル既定の候補は定番 9 素材
  (`nm-bg.py list --source minchi`)。1920x1080 JPEG。
  **商用利用 OK / 利用報告不要 / クレジット不要 / 加工 OK**。
  ただし**素材としての再配布・販売は加工の有無に関わらず不可**なので、
  ダウンロードした画像そのものを配ってはいけない (動画に組み込むのは可)。
  クレジットは不要だが、表記するなら「みんちりえ（https://min-chi.material.jp/）」。
  ニコニコに上げるならコンテンツツリー登録で作者を支援できる (素材ページに ID)。

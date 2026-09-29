# 台本フォーマット

`.yaml` / `.yml` / `.json` のいずれか。トップレベルに `scenes` (配列) が必須。
トップレベルのキーは各シーンの既定値になり、シーン側の同名キーが常に優先される。

## トップレベル

| キー | 既定 | 説明 |
|------|------|------|
| `title` | — | メモ用。出力には影響しない |
| `allowed_materials` | カタログの `recommended` | 使ってよい猫素材 ID のリスト。**省略時もカタログの採用対象が既定で効く** |
| `allowed_backgrounds` | カタログの `recommended` (みんちりえ定番 9) | 使ってよいみんちりえ背景 ID (枚数接尾辞は不要)。これ以外・生成背景・色・パスは不合格 |
| `allow_any_material` | `false` | `true` で猫素材のチェックを無効化 |
| `allow_any_background` | `false` | `true` で背景チェック無効化 (**通常使わない**。背景はみんちりえのみ) |
| `size` | `landscape` | `landscape`(1920x1080, 既定) / `shorts`(1080x1920) / `square`(1080x1080) / `"1080x1920"` / `[1080, 1920]` |
| `fps` | `30` | 出力フレームレート |
| `font` | 自動 | 日本語 TTF/TTC のパス。省略時は `$NEKO_MEME_FONT` → `fc-match` の順で解決 |
| `bg` | 暗い紺グラデ | 全シーン共通の背景 (後述) |
| `bg_fit` | `cover` | `cover` / `contain` / `blur` |
| `bg_zoom` | `none` | `in` / `out` で静止画背景にゆっくりズームを掛ける |
| `bg_zoom_amount` | `0.08` | ズーム量 (0.08 = 8%) |
| `crop` | — | `auto` で猫素材を被写体の外接矩形まで詰める (`scale` が揃う) |
| `scale` | `0.5` | 猫素材の幅 (画面幅比)。`max_height` の箱にも収まるよう縮む |
| `max_height` | `0.82` | 猫素材の高さ上限 (画面高比) |
| `pos` | `center` | 猫素材の位置 |
| `text_pos` | `top` | `text` の既定位置 |
| `text2_pos` | `bottom` | `text2` の既定位置 |
| `text_size` | 自動 | テロップのフォントサイズ。既定は `min(幅/16, 高さ/19)` |
| `text_style` | `{}` | テロップ既定スタイル (後述) |
| `similarity` / `blend` | 自動 | chromakey の閾値。**通常は指定しない** |
| `volume` | `1.0` | 猫素材の音量 |
| `voice_volume` | `1.6` | ナレーションの音量 |
| `voice_padding` | `0.4` | ナレーション末尾に足す余白 (秒) |
| `max_scene_duration` | `8.0` | `duration` 省略時の上限 (秒) |
| `default_duration` | `3.0` | 猫素材もナレーションも無いシーンの尺 |
| `fade_in` / `fade_out` | `0` | 全シーンのフェード (秒) |
| `bgm` | — | BGM ファイル。全体に被せる。足りなければループ |
| `bgm_volume` | `0.12` | BGM 音量 |
| `bgm_fade` | `1.0` | BGM の頭と尻のフェード (秒) |
| `loudness` | `-14` | 出力全体のラウドネス目標 (LUFS)。`false` で無効 |
| `true_peak` | `-1.5` | トゥルーピーク上限 (dBTP) |
| `audio_fade` | `0.04` | 各シーン音声の頭と尻のフェード (秒)。連結時のプチノイズ対策 |
| `preset` / `crf` | `veryfast` / `20` | x264 のエンコード設定 |

## シーン

| キー | 説明 |
|------|------|
| `cat` (別名 `material`) | 素材 ID (`nm-fetch.py list`) かファイルパス。省略すると背景+テロップだけのシーン |
| `text` / `text2` | テロップ。`\n` で改行。幅を超えたら自動折り返し |
| `text_pos` / `text2_pos` | `top` / `center` / `bottom`、または ffmpeg の y 式 |
| `text_style` / `text2_style` | このシーンだけのスタイル上書き |
| `bg` | このシーンの背景 |
| `bg_fit` | `cover` (既定・はみ出しを切る) / `contain` (全体を収めて余白) / `blur` (余白をぼかし背景で埋める) |
| `bg_zoom` / `bg_zoom_amount` | このシーンのズーム。`none` で無効 |
| `duration` | 尺 (秒)。省略時の決まり方は下記 |
| `start` | 素材の再生開始位置 (秒)。素材の `keyed_range` から外れる場合は自動で区間内に寄せ、警告を出す |
| `speed` | 再生速度。`1.2` で 1.2 倍。音声も追従する (0.5〜2.0) |
| `loop` | 素材が尺より短いときループするか (既定 `true`) |
| `scale` | 猫の幅 (画面幅比) |
| `pos` | `center` / `top` / `bottom` / `left` / `right` の組み合わせ (`bottom-left` など)、`[x, y]` (px または ffmpeg 式)。`-flush` を足すと余白なしで画面の端に密着し、元動画で切れている被写体の切断面を隠せる (`bottom-flush`, `bottom-left-flush`) |
| `max_height` | このシーンの高さ上限 (画面高比) |
| `flip` | `true` で左右反転 |
| `key` | `false` で背景抜き無効、`"0x00FF00"` でキー色を強制指定。既定は自動検出値 |
| `similarity` / `blend` | chromakey の閾値を手で指定する |
| `crop` | `auto` で被写体の外接矩形まで詰める / `"crop=w:h:x:y"` で明示 / `false` で無効 |
| `audio` | `cat` (既定・素材の音) / `none` / ファイルパス |
| `volume` | このシーンの音量 |
| `voice` | ナレーション音声ファイル。素材音とミックスされる |
| `voice_volume` | ナレーション音量 |
| `fade_in` / `fade_out` | このシーンのフェード (秒) |

### `duration` を省略したときの尺

1. `voice` があれば **ナレーション長 + `voice_padding`**
2. なければ **素材の残り長 ÷ `speed`** (ただし `max_scene_duration` で頭打ち)
3. 素材も無ければ `default_duration`

## 背景の指定方法

**みんちりえだけ。** `nm-bg.py list --source minchi` の ID に枚数目を付けて書く。

| 書き方 | 例 | 意味 |
|--------|-----|------|
| みんちりえ | `bg: mc-medium_office-2` | 定番素材の 2 枚目 (例: 夕方)。`nm-bg.py fetch` で取得 |

使わない (チェックで失敗する):

- 生成背景 (`night` / `focus` / `mint` 等)
- 色・グラデ (`#1e1e2e` / `gradient:…`)
- 任意ファイルパス / 猫素材 ID を背景に敷く

## テロップのスタイル

`text_style` / `text_style` (シーン側) に入れられるキー:

| キー | 既定 | 説明 |
|------|------|------|
| `size` | 自動 | フォントサイズ。既定は `min(幅/16, 高さ/19)` |
| `color` | `white` | 文字色 |
| `border` | サイズ*0.09 | 縁取りの太さ。`0` で無効 |
| `border_color` | `black` | 縁取り色 |
| `box` | `false` | `true` で背景ボックスを敷く |
| `box_color` | `black@0.55` | ボックス色 |
| `box_padding` | サイズ*0.35 | ボックスの余白 |
| `shadow` | `true` | 影 |
| `margin` | `0.10` | 上下マージン (画面高比) |
| `width_ratio` | `0.90` | 折り返し幅 (画面幅比) |
| `line_spacing` | サイズ*0.25 | 行間 |

## 完成例

`assets/example-black-company.yaml` が動作確認済みの完成台本
(16:9 / 110秒 / 23シーン)。書き出しはこう:

```yaml
title: ブラック企業の一日
size: landscape
fps: 30

text_style:  { box: true, box_color: "black@0.62", size: 58 }
text2_style: { box: true, box_color: "black@0.62", size: 50 }

crop: auto           # 素材ごとの被写体サイズ差を吸収
pos: bottom-flush    # 元動画の端で切れている切断面を画面下端に隠す
volume: 0.85

scenes:
  - text: "ブラック企業の一日"
    text2: "※フィクションです"
    text_style: { size: 84 }
    cat: yt-maxwell
    bg: mc-medium_office-1
    scale: 0.46
    duration: 4.5
    fade_in: 0.5

  - text: "6:00"
    text2: "アラームは4回鳴った"
    cat: yt-sleeping-cat
    bg: mc-single_room3-4      # 夜・照明OFF
    scale: 0.25
    duration: 5.0

  - text: "上司「あの資料、朝イチでって言ったよね」"
    cat: yt-talking-and-huh    # 2匹入り素材で会話を1カットに収める
    bg: mc-medium_office-1
    scale: 0.54
    duration: 5.5
```

配役とサイズの決め方は `casting.md` を参照。

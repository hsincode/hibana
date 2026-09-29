# 素材カタログ

`nm-fetch.py list` / `nm-bg.py list` の内容を表にしたもの。ID は台本の `cat:` /
`bg:` にそのまま書く。最新の状態は必ずコマンドで確認すること
(このファイルは 2026-07-29 時点のスナップショット)。

- **採用**: ◎ = この動画シリーズで使うと決めた素材 (`nm-fetch.py list` の既定表示)。
  空欄の素材を台本で使うと `nm-build.py --check` が失敗する。
- **抜き**: ○ = グリーン/ブルーバックを自動検出済み。合成でそのまま背景が抜ける。
  `-` = 背景抜き不可 (ゲーム映像など)。
- **尺**: 素材の全長。台本で `duration` を省略するとこの長さ (上限 8 秒) になる。
- 一部の素材は元動画の尻にタイトルカードが入っている。有効区間は `index.json` の
  `keyed_range` にあり、`nm-build.py --check` が逸脱を警告する。
  現在の該当素材: `yt-goat-talking` (0〜8.5s) / `yt-monkey-cart` (0〜40.5s) /
  `yt-demanding-monkey` (0〜24.0s)。

## neko-meme-site (猫ミーム情報局) 由来 — 74 本

YouTube 素材へのリンク集。取得に yt-dlp が必要。**猫以外 (犬・ヤギ・羊・猿) や
2 匹以上の組み合わせ素材も含む**ので、配役の幅はここが一番広い。

| 採用 | ID | 名前 | タグ | 尺 | 抜き |
|----|----|------|------|----|------|
| ◎ | `yt-angry-cat` | 怒っている猫 | 怒り/不機嫌/ツッコミ | 6.9s | ○ |
| ◎ | `yt-big-eyes-cat` | 大きな目の猫 | 驚き/凝視/かわいい/リアクション | 11.3s | ○ |
| ◎ | `yt-cat-hits-cat` | 猫が別の猫を攻撃 | 攻撃/叩く/ツッコミ/オチ | 7.1s | ○ |
| ◎ | `yt-cat-huh` | 猫「え？」 | 驚き/聞き返し/ツッコミ/定番 | 9.8s | ○ |
| ◎ | `yt-chipi-chipi` | チピチピチャパチャパ | ダンス/定番/ノリノリ/首振り | 13.2s | ○ |
| ◎ | `yt-crunchy-cat` | カリカリ猫が食べる | 食べる/カリカリ/無視 | 13.9s | ○ |
| ◎ | `yt-dj-cat` | DJ猫 | DJ/音楽/ノリノリ/登場 | 10.0s | ○ |
| ◎ | `yt-dog-and-zoning-cat` | 笑う犬と黒猫のゾーンアウト | 組み合わせ/煽り/放心/掛け合い | 6.9s | ○ |
| ◎ | `yt-goat-and-huh` | 無知な猫と話すヤギ | 会話/ヤギ/掛け合い/無知 | 9.1s | ○ |
| ◎ | `yt-goat-talking` | 何も知らずに話すヤギ | ヤギ/会話/無知/説明 | 25.9s | ○ |
| ◎ | `yt-know-nothing` | 何も知らない猫 | 無知/とぼける/定番/ボケ | 7.3s | ○ |
| ◎ | `yt-laughing-dog` | 笑う犬 | 犬/笑う/煽り/オチ | 9.8s | ○ |
| ◎ | `yt-maxwell` | Maxwell The Cat | ダンス/定番/回る/ノリノリ | 14.5s | ○ |
| ◎ | `yt-mr-fresh` | Mr. Fresh猫 | ダンス/ノリノリ/登場 | 6.8s | ○ |
| ◎ | `yt-nail-file-cat` | 猫の爪やすり | 作業/爪/のんき/日常 | 13.4s | ○ |
| ◎ | `yt-popcat` | ポップキャット | 驚き/口パク/定番/リアクション | 15.7s | ○ |
| ◎ | `yt-screaming-cat` | 叫ぶ猫 | 叫ぶ/驚き/絶叫/ツッコミ | 6.0s | ○ |
| ◎ | `yt-sleeping-cat` | 眠っている猫 | 寝る/睡眠/平和 | 7.5s | ○ |
| ◎ | `yt-sleepy-cat` | 眠そうな猫 | 眠い/だるい/疲れ | 8.0s | ○ |
| ◎ | `yt-talking-and-huh` | しゃべる猫と無知な猫 | 会話/掛け合い/無知/定番 | 11.8s | ○ |
| ◎ | `yt-talking-cat` | しゃべる猫 | 会話/説明/定番 | 13.0s | ○ |
| ◎ | `yt-typing-cat` | 猫のタイピング | 仕事/PC/作業/タイピング | 5.7s | ○ |
| ◎ | `yt-wet-cat` | カメラを見つめる濡れた猫 | 絶望/濡れる/無表情/オチ | 15.1s | ○ |
| ◎ | `yt-zoning-out` | 猫のゾーンアウト | 放心/無表情/遠い目/絶望 | 7.1s | ○ |
|  | `yt-bike-kitten` | 自転車に乗る子猫 | 移動/自転車/かわいい | 8.0s | ○ |
|  | `yt-black-face-sheep` | 黒い顔の羊 | 羊/のんき | 12.0s | ○ |
|  | `yt-cat-and-dog` | 猫と犬 | 組み合わせ/掛け合い/犬 | 15.7s | ○ |
|  | `yt-cat-fight` | 猫の戦い | 攻撃/喧嘩/カオス | 9.7s | ○ |
|  | `yt-cat-leaves` | 猫が家を出る | 退場/出発/移動 | 12.0s | ○ |
|  | `yt-chips-cat` | チップスを食べる猫 | 食べる/間食 | 8.9s | ○ |
|  | `yt-corgi-smile` | 笑顔のコーギー犬 | 犬/笑顔/かわいい | 11.8s | ○ |
|  | `yt-corn-cat` | 猫がコーンを食べる | 食べる/コーン | 10.2s | ○ |
|  | `yt-dancing-cat` | 猫のダンス | ダンス/ノリノリ | 8.6s | ○ |
|  | `yt-dancing-cat-2` | 踊る猫 | ダンス/ノリノリ | 5.9s | ○ |
|  | `yt-dancing-dog` | 踊る犬 | 犬/ダンス/ノリノリ | 12.8s | ○ |
|  | `yt-dancing-dog-2` | 踊る犬 | 犬/ダンス/ノリノリ | 12.4s | ○ |
|  | `yt-dancing-dog-3` | 踊る犬 | 犬/ダンス/ノリノリ | 13.4s | ○ |
|  | `yt-dancing-girlfriend` | 猫はガールフレンドに合わせて踊る | ダンス/嬉しい/ノリノリ | - | 削除済 (代替 `dancing-girlfriend`) |
|  | `yt-demanding-monkey` | 要求の厳しい猿 | 猿/要求/催促 | 33.2s | ○ |
|  | `yt-dog-at-pc` | パソコンを見つめる犬 | 犬/PC/仕事/凝視 | 6.4s | ○ |
|  | `yt-door-cat` | 猫はドアを開けてほしい | 催促/要求/ドア | 12.2s | ○ |
|  | `yt-driving-cat` | 猫の運転 | 移動/運転/出発 | - | 削除済 (代替 `yt-bike-kitten`) |
|  | `yt-edm-dance` | EDMに合わせて踊る猫 | ダンス/EDM/ノリノリ | - | 削除済 (代替 `hodomoe-cat`) |
|  | `yt-emo-cat` | エモ猫ヘアフリップ | エモ/ドヤ顔/登場 | 7.5s | ○ |
|  | `yt-gagging-cat` | えずく猫 | 嫌悪/拒否/オチ | 6.2s | ○ |
|  | `yt-happy-cat` | ハッピーハッピーハッピー猫 | 嬉しい/ハッピー/ダンス | - | 削除済 (代替 `chipi-chipi`) |
|  | `yt-head-bob-cat` | リズムに合わせて首を振る猫 | ダンス/首振り/ノリノリ | 29.5s | ○ |
|  | `yt-hungry-cat` | お腹を空かせた猫 | 空腹/催促/食べる | 15.8s | ○ |
|  | `yt-keyboard-dog` | キーボードを弾く犬 | 犬/演奏/仕事 | 8.2s | ○ |
|  | `yt-lookup-cat` | 食事をしてから見上げる猫 | 食べる/見上げる/期待 | 7.5s | ○ |
|  | `yt-meowing-cat` | 鳴く猫 | 鳴く/訴え | 2.5s | ○ |
|  | `yt-meowing-cat-2` | 鳴く猫 | 鳴く/訴え | 8.0s | ○ |
|  | `yt-monkey-cart` | ゴルフカートを運転する猿 | 猿/移動/カオス | 49.3s | ○ |
|  | `yt-no-cat` | ノーと叫ぶ猫 | 拒否/叫ぶ/ツッコミ | 7.3s | ○ |
|  | `yt-nostalgic-cat` | 昔の思い出を思い出す猫 | 回想/思い出/しんみり | 5.1s | ○ |
|  | `yt-porcupine-dance` | ヤマアラシダンス | ダンス/カオス | 6.8s | ○ |
|  | `yt-real-sheep` | 本物の羊 | 羊/のんき | 13.0s | ○ |
|  | `yt-rizz-cat` | 猫 Rizz | ドヤ顔/自信/登場 | 8.5s | ○ |
|  | `yt-sad-dog` | 悲しい黒い犬 | 犬/悲しい/しょんぼり | 7.8s | ○ |
|  | `yt-screaming-cat-2` | 叫ぶ猫 | 叫ぶ/驚き/絶叫/ツッコミ | 5.2s | ○ |
|  | `yt-shivering-dog` | 震える犬 | 犬/恐怖/震え | 5.0s | ○ |
|  | `yt-shooting-cat` | シューティング猫 | 攻撃/撃つ/オチ | 4.9s | ○ |
|  | `yt-sleeping-cat-2` | 眠っている猫 | 寝る/睡眠/平和 | 13.8s | ○ |
|  | `yt-sleepy-cat-2` | 眠そうな猫 | 眠い/だるい/疲れ | 11.2s | ○ |
|  | `yt-sleepy-cat-3` | 眠そうな猫 | 眠い/だるい/疲れ | 5.2s | ○ |
|  | `yt-snoring-dog` | いびきをかく犬 | 犬/寝る/いびき | 8.1s | ○ |
|  | `yt-spinning-cat` | くるくる回る猫 | 回る/ダンス/混乱 | 6.2s | ○ |
|  | `yt-stretching-cat` | 伸びる猫 | 伸び/だるい/起床 | - | 削除済 (代替 `yt-sleepy-cat`) |
|  | `yt-sync-dance-cat` | 合わせて踊る猫 | ダンス/ノリノリ | - | 削除済 (代替 `yt-head-bob-cat`) |
|  | `yt-talking-cats-group` | しゃべる猫達 | 会話/複数/掛け合い | 9.8s | ○ |
|  | `yt-talking-goat` | おしゃべりヤギ | ヤギ/会話/説明 | 5.0s | ○ |
|  | `yt-trend-cat` | 猫とトレンド | ダンス/トレンド/ノリノリ | 7.5s | ○ |
|  | `yt-two-cats-face` | 二匹の猫が向かい合う | 会話/掛け合い/対峙 | 8.4s | ○ |
|  | `yt-what-now-cat` | どうなる猫 | 困惑/不安 | 5.2s | ○ |

## memesstyle.com 由来 — 19 本

Cloudflare R2 に mp4 直置き。yt-dlp 不要。

| 採用 | ID | 名前 | タグ | 尺 | 抜き |
|----|----|------|------|----|------|
|  | `biker-cat` | 前乗りバイク猫 | 移動/バイク/出発 | 19.6s | ○ |
|  | `cat-person` | 人が扮する猫 | 人間/コスプレ/ボケ | 5.7s | ○ |
|  | `chipi-chipi` | チピチピチャパチャパ猫 | ダンス/定番/ノリノリ/首振り | 13.1s | ○ |
|  | `crunchy-cat` | 物をかむ猫 | 食べる/カリカリ/無視 | 13.8s | ○ |
|  | `dancing-girlfriend` | Girlfriendを踊る猫 | ダンス/嬉しい/ノリノリ | 12.1s | ○ |
|  | `goat-person` | 人が扮するヤギ | ヤギ/人間/コスプレ/ツッコミ | 8.9s | ○ |
|  | `gojo-cat` | 五条悟のコスプレをした猫 | コスプレ/五条悟/登場 | 11.3s | ○ |
|  | `hodomoe-cat` | ホドモエシティ猫 | ダンス/ポケモン/ノリノリ | 13.5s | ○ |
|  | `kitten-butt` | 子猫のお尻のお尻 | かわいい/子猫/お尻 | 10.3s | ○ |
|  | `laughing-pointing-cat` | 笑っている猫に指を向けてください | 爆笑/指差し/煽り/オチ | 5.1s | ○ |
|  | `pause-button` | ポーズボタンエフェクト グリーンスクリーン | エフェクト/一時停止/演出 | 7.1s | ○ |
|  | `popcat` | 口をパクパクする猫（POPCAT | 驚き/定番/口パク/リアクション | 15.7s | ○ |
|  | `pot-dog` | 鍋をたたく犬 | 犬/催促/ごはん/騒ぐ | 12.1s | ○ |
|  | `support-cat` | 顧客サービスの役割を果たす猫 | 仕事/接客/対応/困惑 | 14.1s | ○ |
|  | `swinging-cat` | 揺れる猫 (Yureru Neko) | 揺れる/のんき/待ち | 13.5s | ○ |
|  | `talking-cats` | 会話してる猫 | 会話/定番/説明/掛け合い | 11.7s | ○ |
|  | `teemo` | ティーモ スペースグルーヴ スキン 素材 | ダンス/LoL/ティーモ | 1.6s | - |
|  | `teemo-hit` | ツボに入る - ティーモ スペースグルーヴ スキン | ツボ/LoL/ティーモ | 3.2s | - |
|  | `waving-cat` | 招き猫 (Maneki Neko) | 招き猫/挨拶/登場/オチ | 6.3s | ○ |

## 用途別の早見

| 使いどころ | おすすめ素材 |
|------------|--------------|
| つかみ・登場 | `yt-maxwell`, `yt-mr-fresh`, `yt-rizz-cat`, `yt-emo-cat` |
| 会話・掛け合い | `yt-talking-and-huh`, `yt-goat-and-huh`, `yt-two-cats-face`, `yt-talking-cats-group` |
| 一方的に喋る役 | `yt-goat-talking`, `yt-talking-goat`, `yt-talking-cat` |
| ボケ・とぼける | `yt-know-nothing`, `yt-what-now-cat` |
| 驚き・聞き返し | `yt-cat-huh`, `yt-popcat`, `yt-big-eyes-cat` |
| 怒り・拒否 | `yt-angry-cat`, `yt-no-cat`, `yt-gagging-cat` |
| 絶叫 | `yt-screaming-cat`, `yt-screaming-cat-2` |
| ツッコミ・攻撃 | `yt-cat-hits-cat`, `yt-cat-fight`, `yt-shooting-cat` |
| 盛り上げ・ダンス | `yt-dj-cat`, `yt-head-bob-cat`, `yt-maxwell`, `yt-spinning-cat` |
| 疲れ・眠気 | `yt-sleepy-cat`, `yt-sleeping-cat`, `yt-snoring-dog` |
| 絶望・放心 | `yt-wet-cat`, `yt-zoning-out`, `yt-sad-dog` |
| 煽り・オチ | `yt-laughing-dog`, `yt-dog-and-zoning-cat`, `yt-corgi-smile` |
| 仕事・作業 | `yt-typing-cat`, `yt-dog-at-pc`, `yt-keyboard-dog`, `yt-nail-file-cat` |
| 食事 | `yt-crunchy-cat`, `yt-chips-cat`, `yt-corn-cat`, `yt-hungry-cat`, `yt-lookup-cat` |
| 催促・要求 | `yt-door-cat`, `yt-meowing-cat`, `yt-demanding-monkey`, `pot-dog` |
| 移動・出発 | `yt-bike-kitten`, `yt-cat-leaves`, `biker-cat` |
| 回想・しんみり | `yt-nostalgic-cat` |
| 演出エフェクト | `pause-button` (一時停止) |

## 背景素材 (みんちりえのみ)

**背景はみんちりえ以外使わない。** 生成背景・色・任意パスは
`nm-build.py --check` / ビルドで失敗する。

### みんちりえ (min-chi.material.jp) — 定番 9 素材

`nm-bg.py list --source minchi` で一覧、`--variants` で各素材の枚目が見られる。
写実系は同じ場所の **日中 / 夕方 / 夜・照明ON / 夜・照明OFF** が揃っているものが
多く、時系列そのままに並べると時間経過が画で伝わる。台本では
`bg: mc-medium_office-1` のように書く。

商用利用 OK / 利用報告不要 / クレジット不要 / 加工 OK。
**素材としての再配布・販売は不可** (動画に組み込むのは可)。

| ID | 内容 | 枚数 | バリエーション |
|----|------|------|----------------|
| `mc-medium_office` | 会社のオフィス | 4 | 日中 / 夕方 / 夜ON / 夜OFF |
| `mc-office` | 事務所 | 2 | 通常 / 消灯 |
| `mc-building_hallway` | ビルの廊下 | 4 | 日中 / 夕方 / 夜ON / 夜OFF |
| `mc-single_room3` | 一人部屋３ (寝室として使える) | 4 | 日中 / 夕方 / 夜ON / 夜OFF |
| `mc-living2` | リビング２ | 4 | 日中 / 夕方 / 夜ON / 夜OFF |
| `mc-inside_train` | 電車の車内 | 3 | 日中 / 夕方 / 夜 |
| `mc-station_platform` | 駅のホーム | 4 | 日中 / 夕方 / 夜ON / 夜OFF |
| `mc-hospital_lobby` | 病院のロビー・受付 | 3 | 照明ON / 照明OFF / 停電 |
| `mc-machine_room` | 機械室 | 2 | 照明ON / 照明OFF |

```bash
python3 scripts/nm-bg.py fetch --jpg-only --only \
  mc-medium_office,mc-office,mc-building_hallway,mc-single_room3,mc-living2,\
  mc-inside_train,mc-station_platform,mc-hospital_lobby,mc-machine_room
```

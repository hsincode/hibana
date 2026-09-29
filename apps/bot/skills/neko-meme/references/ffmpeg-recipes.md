# ffmpeg レシピ

`nm-build.py` が内部で組み立てているフィルタと、台本の外で手を入れたいときの
断片集。`nm-build.py script.yaml --dry-run` で実際のコマンドを丸ごと表示できる。

## グリーンバック合成の中身

```
[0:v] scale=1080:1920:force_original_aspect_ratio=increase,
      crop=1080:1920,fps=30,setsar=1                        [bg];
[1:v] fps=30,
      chromakey=0x00FF00:0.209:0.063,
      despill=type=green:mix=0.5:expand=0.3,
      scale=994:-2,setsar=1                                  [cat];
[bg][cat] overlay=(W-w)/2:(H-h)/2:shortest=0:format=auto     [comp]
```

### similarity は固定値にしない

`chromakey` は **UV 平面上の距離**で判定する。閾値を定番の `0.2` に固定すると、
彩度の低いグリーンバック素材では「無彩色に近い被写体」まで一緒に消える。

実例: `yt-sleeping-cat` のキー色は `#55C150` (くすんだ緑)。`0.2` だとクリーム色の
猫の UV 距離が閾値内に入ってしまい、猫が半透明になって消し飛ぶ。

`nm-build.py` はキー色自身の UV 距離から閾値を出している (`auto_chromakey_params`):

```
Y = 0.299R + 0.587G + 0.114B
U = 0.492(B - Y),  V = 0.877(R - Y)
similarity = clamp(0.06, 0.5 * hypot(U, V) / (255 * √2), 0.28)
blend      = similarity * 0.3
```

鮮やかな `0x00FF00` なら 0.209 (従来の定番値とほぼ同じ)、くすんだ `#55C150` なら
0.089 になる。

### キー色そのものも実測する

素材ごとに緑の濃さがバラバラ (撮影条件と再エンコードのせい) なので、
`nm-fetch.py` が四隅を 3 時点サンプリングして実測値を `index.json` に入れている。
黒帯付き素材は先に `cropdetect` で帯を落としてからサンプリングする。

手動で調べるなら:

```bash
ffmpeg -v error -ss 2 -i mat.mp4 -vf "crop=iw*0.06:ih*0.06:0:0,scale=1:1" \
       -frames:v 1 -f rawvideo -pix_fmt rgb24 - | xxd -p
```

## 日本語テロップ

`drawtext` に日本語を直接書くと `:` `'` `%` のエスケープで詰むので、
必ず `textfile=` を使う。

```bash
ffmpeg -i in.mp4 -vf "drawtext=\
fontfile=/usr/share/fonts/noto/NotoSansCJK-Bold.ttc:\
textfile=/tmp/line.txt:\
fontsize=68:fontcolor=white:line_spacing=17:\
x=(w-tw)/2:y=192:\
borderw=6:bordercolor=black:shadowx=3:shadowy=3:shadowcolor=black@0.6" out.mp4
```

折り返しは ffmpeg 側では出来ないので、`nm-build.py` が
`unicodedata.east_asian_width` で全角=2/半角=1 として数えて改行を入れている。

## 背景の敷き方

```bash
# はみ出しを切って埋める (cover)
scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920

# 全体を収める (contain)
scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2

# 余白をぼかし背景で埋める (blur)
split=2[a][b];
[a]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,gblur=sigma=27[bg];
[b]scale=1080:1920:force_original_aspect_ratio=decrease[fg];
[bg][fg]overlay=(W-w)/2:(H-h)/2
```

静止画背景は `-loop 1 -t <尺>`、動画背景は `-stream_loop -1 -t <尺>` で入力する。

## 集中線を生成する

`geq` で角度を分割して交互に塗る。中心付近は線を消して被写体を守る。

```bash
ffmpeg -f lavfi -i color=c=white:s=1080x1920 -vf "geq=\
r='255*(1-lt(mod(floor((atan2(Y-960,X-540)+3.14159)/6.28318*48),2),1)\
*clip((hypot(X-540,Y-960)/1102-0.28)/0.30,0,1))':g='...':b='...'" \
-frames:v 1 focus.png
```

`48` が線の本数、`0.28` が中心の空白半径 (対角比)、`0.30` がフェード幅。

## シーンの連結

全シーンを同一パラメータ (解像度・fps・pix_fmt・音声レート) で書き出してから
concat demuxer で無劣化結合する。

```bash
printf "file '/tmp/s1.mp4'\nfile '/tmp/s2.mp4'\n" > list.txt
ffmpeg -f concat -safe 0 -i list.txt -c copy -movflags +faststart out.mp4
```

パラメータが 1 つでもズレると音ズレや黒フレームが出るので、シーン側で
`-r`, `-pix_fmt yuv420p`, `-ar 48000 -ac 2` を必ず固定すること。

## 音声

```bash
# 素材音を尺ぴったりに揃える (短ければ無音で埋める)
[1:a]asetpts=PTS-STARTPTS,volume=1.0,apad=whole_dur=3.0,atrim=0:3.0[a]

# 素材音 + ナレーションを混ぜる
[a_cat][a_voice]amix=inputs=2:duration=first:dropout_transition=0[a]

# BGM を全体に被せる (足りなければループ)
ffmpeg -i video.mp4 -stream_loop -1 -i bgm.mp3 -filter_complex \
  "[1:a]volume=0.12,afade=t=in:st=0:d=1,afade=t=out:st=14:d=1[bgm];
   [0:a][bgm]amix=inputs=2:duration=first[a]" \
  -map 0:v -map "[a]" -c:v copy -c:a aac out.mp4
```

`speed` を変えるときは映像 `setpts=1/speed*PTS` と音声 `atempo=speed` を
セットで入れる。`atempo` は 0.5〜2.0 の範囲しか受け付けない。

## 素材の確認に便利なワンライナー

```bash
# 全素材をマゼンタ背景に合成してコンタクトシートを作る (抜けの確認)
python3 scripts/nm-build.py qa.json -o qa.mp4   # 各素材 1 秒で並べた台本を用意して

# 1 フレームだけ抜き出す
ffmpeg -v error -ss 2 -i mat.mp4 -frames:v 1 -vf scale=320:-1 check.png

# 尺・解像度・音声の有無
ffprobe -v error -show_entries stream=codec_type,width,height:format=duration mat.mp4
```

# 同梱フォント

欧文と数字に使う書体（Outfit）を、外部への通信なしで配るために同梱している（判断記録: #61）。日本語は端末の書体で表示する。

等幅の Red Hat Mono も #61 から同梱していたが、英字をすべて Outfit にしたので外した（判断記録: #142）。

| ファイル                  | 書体           | ウェイト | 大きさ        | SHA-256                                                            |
| ------------------------- | -------------- | -------- | ------------- | ------------------------------------------------------------------ |
| `outfit-latin-wght.woff2` | Outfit（可変） | 300〜600 | 28,532 バイト | `73e8f95ff8b51b481d549854d8220bd96e3fef828cf0a91b46cdbcef914b49ad` |

## 出所

[google/fonts](https://github.com/google/fonts) のコミット `bd8f81ddb5c74d5c8897b36ad88b440266245103`（2026-10-10 に取得）。

| 元ファイル                    | SHA-256                                                            | 上流のリポジトリ                         |
| ----------------------------- | ------------------------------------------------------------------ | ---------------------------------------- |
| `ofl/outfit/Outfit[wght].ttf` | `fc7287273e66929776e2ba54f144fe699080bec29f61bf649d70d871468aeade` | https://github.com/Outfitio/Outfit-Fonts |

## ライセンス

SIL Open Font License 1.1。全文は `OFL-Outfit.txt`（元ファイルと同じディレクトリの `OFL.txt` をそのまま置いたもの）。著作権表示に Reserved Font Name の指定は無い。

配る WOFF2 には、元ファイルの name テーブルの項目（著作権表示、ライセンスの説明、ライセンスの URL を含む）を残してある。文字とウェイトを絞ったので、OFL の上では「Modified Version」にあたる。

## 生成方法

元ファイルから、使うウェイトの範囲と文字（Google Fonts の「latin」と同じ範囲）だけを残して WOFF2 にした。fonttools 4.66.1 と brotli 1.2.0 で、同じコマンドを 2 回実行して同じバイト列になることを確かめた。

```sh
U="U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD"

python -m fontTools.varLib.instancer "Outfit[wght].ttf" wght=300:600 --no-recalc-timestamp -o outfit.ttf
python -m fontTools.subset outfit.ttf --unicodes="$U" --name-IDs='*' --flavor=woff2 --no-recalc-timestamp --output-file=outfit-latin-wght.woff2
```

範囲に無い文字（日本語、矢印の一部、⌘ など）は、`styles/tokens.css` の `--font-ui` に並べた端末の書体で表示される。

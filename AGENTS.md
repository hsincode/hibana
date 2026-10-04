# AGENTS.md

このリポジトリは、本人（リポジトリの持ち主）が判断し、AI が実装を手伝う形で開発している。開発の過程そのものを、本人の判断・検証の記録として残すことが目的の一つ。

## 本人が決めること（AI が決めない）

- 仕様・スコープ・やらないこと、受入条件
- 技術・構成の採否、トレードオフの判断
- テストの観点、計測の目的・判定基準・条件
- マージするかどうかと順番、リリース、切り戻し（マージの操作は、本人が指示したときに AI が行う。#2）
- 費用が発生するクラウド資源の作成、外部サービスへの登録・公開

上のどれかが必要になったら、選択肢を比較表（効果・不利益・根拠）で示して止まり、本人の判断を待つ。判断は Issue の「判断記録」テンプレートで残す。

- 本人の判断・確認・再実行として書いてよいのは、本人から確認できた内容だけ。確認できていなければ「本人未確認」と書く
- `decision:human` ラベルは、本人の判断が Issue に記録された後に付ける
- 本人の確認結果は、対象の commit と対応付けて書く。判断が変わったら、上書きせず日時と理由を追記する

## 作業の規則

- 実装を始める前に、対応する Issue（判断記録・調査記録・計測記録）があることを確かめ、PR からリンクする
- 調査・計測の途中経過は、Issue のコメントに追記する。本文を上書きして過程を消さない
- PR は `.github/pull_request_template.md` を埋める。AI が生成・変更した範囲と、本人に確かめてほしい箇所を分けて書く。マージは、本人が指示したものだけを、マージコミットで行う。マージしたら、実行の結果を確かめて PR に追記する
- バグを直すときは、先に「修正前に失敗するテスト」を書き、修正後に成功することを示す
- 計測は、改善前の版を残してから始める。環境・版・条件を計測記録に書く。数値を推測で書かない。本人が再実行するまで結果を確定扱いにしない
- 本人に誤りを指摘されたら、`ai:corrected` ラベルで「提案した内容 → 誤りの根拠 → 修正 → 修正前後の検証」を残す
- 図（状態遷移図・構成図など）は PlantUML か Mermaid で `docs/` に置く。実装やスキーマから自動生成した図を、手で描いた図として扱わない
- コミットは Conventional Commits。AI が書いたコミットには `Co-Authored-By:` を付ける
- Issue・PR・ドキュメントは日本語で書く

## 持ち込まないもの

- 本人の勤務先の業務データ・プロンプト・設計・ソースコード・社内情報
- 秘密情報（API キー、トークン、パスワード）。Git・Issue・CI のログ・IaC に残さない。環境変数かシークレットストアを使う
- 出所が分からないデータ。データを使うときは出所・生成方法・ライセンスを記録する

## 費用

- 本人が決めた費用の上限を超える構成・設定を作らない。API の呼び出し回数・同時実行数・入力長に上限を設ける

## Hibana

Bun + TypeScript monorepo: `apps/bot` (Discord agent), `apps/api` (Elysia settings API), `apps/web` (React dashboard).

- Secrets belong in environment variables only; never commit `.env` or runtime data.
- Every change goes through an Issue and a pull request. The owner decides whether and in what order to merge; the agent performs the merge, with a merge commit, when the owner says so (decision record: #2). Do not push to `main`.
- Run `make test` after logic changes and `make ci` before pushing.
- Preserve guild / DM isolation, permission checks, bounded Docker sandboxes and independent provider credentials.
- Advisor, automatic model routing, answer verification (`verify`), and Codex fast mode (`fast`) are intentionally removed. OpenRouter provider and React navigation remain supported.
- Bot API and dashboard share the settings and model catalog in `packages/shared`.
- Explain non-obvious behavior in comments. Keep migration documentation honest about validation limits.

- For VPS operations, read `.local/deployment.json` first for the SSH target, service and paths. This machine-local file is gitignored; reuse it instead of asking for the connection details again. Never copy credentials into tracked files.

# AGENTS.md

このリポジトリは、本人（リポジトリの持ち主）が判断し、AI が実装を手伝う形で開発している。開発の過程そのものを、判断と検証の記録として残すことが目的の一つ。

## 本人が決めること（AI が決めない）

- 仕様・スコープ・やらないこと、受入条件
- 技術・構成の採否、トレードオフの判断
- テストの観点、計測の目的・判定基準・条件
- マージするかどうかと順番、リリース、切り戻し（マージの操作は、本人が指示したときに AI が行う。#2）
- 費用が発生するクラウド資源の作成、外部サービスへの登録・公開

上のどれかが必要になったら、選択肢を比較表（効果・不利益・根拠）で示して止まり、本人の判断を待つ。判断は Issue の「判断記録」テンプレートで残す。

- 記録（Issue・PR・コメント・ADR・docs・コード内のコメント）には、判断・仕様・事実・検証の結果だけを書く。誰が書いた・提案した・確認したか（「AI の案」「本人未確認」など）と、依頼の原文は書かない
- していない判断・確認・再実行を、したと書かない。まだ選んでいない点は「未決」と書き、実装した値は仕様として書く
- 記録の種類はラベルで表す（`判断`・`調査`・`計測`・`訓練`・`運用`）。タイトルに `[判断]` などの接頭辞を付けない
- `確定` ラベルは、判断が確定して Issue に記録された後に付ける
- 検証の結果は、対象の commit と対応付けて書く。判断が変わったら、上書きせず日時と理由を追記する

## 作業の規則

- 実装を始める前に、対応する Issue（判断記録・調査記録・計測記録）があることを確かめ、PR からリンクする
- 調査・計測の途中経過は、Issue のコメントに追記する。本文を上書きして過程を消さない
- PR は `.github/pull_request_template.md` を埋める。マージは、本人が指示したものだけを、マージコミットで行う。マージしたら、実行の結果を確かめて PR に追記する
- バグを直すときは、先に「修正前に失敗するテスト」を書き、修正後に成功することを示す
- 計測は、改善前の版を残してから始める。環境・版・条件を計測記録に書く。数値を推測で書かない。再実行したかどうかを書く
- 誤りが見つかったら、`誤りの修正` ラベルで「誤っていた内容 → 誤りの根拠 → 修正 → 修正前後の検証」を残す
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
- Run `make test` after logic changes and `make ci` before pushing. Format with `bun fmt` (`make fmt`); `make ci` and CI fail on unformatted files. Prompts and skills under `apps/bot/prompts` and `apps/bot/skills` are excluded in `.prettierignore` because they are model input (decision record: #99).
- Preserve guild / DM isolation, permission checks, bounded Docker sandboxes and independent provider credentials.
- Anthropic Workspace turns have no Docker sandbox: each channel works in a container in Anthropic's cloud. They are bounded by money, time and concurrency instead: a budget per turn, a daily and a monthly budget that a resumed turn is held to as well, a time limit per turn and a limit on turns running at once (decision record: #76). Keep those bounds, keep one turn at a time per channel, and keep `ANTHROPIC_WORKSPACE_API_KEY` apart from `ANTHROPIC_API_KEY`: neither falls back to the other.
- Advisor, the old automatic model router, answer verification (`verify`), the Jev completion check at the end of a turn (decision record: #50), and Codex fast mode (`fast`) are intentionally removed. OpenRouter provider and React navigation remain supported.
- Turns of the `anthropic_workspace` provider (Anthropic Workspace) are messages to a Managed Agents session, one session per channel: the loop, the conversation and the workspace are Anthropic's, and Hibana supplies the prompt, its Discord and settings tools as custom tools, and the limits (decision record: #76, ADR-0011, `docs/anthropic-workspace.md`). The official SDK (`@anthropic-ai/sdk`, pinned to 0.133.0) is used by this path only. A change to it must not change a request, a tool list or a prompt of any other provider's turns. Against the real API it has only been run from a workstation, on Haiku 5.5 and before it was ported onto `main`: every check without Ultra, and one Haiku Ultra turn of the bot (2026-10-12). `bun run workspace-smoke` is billed, so do not run it without the owner's approval, each time.
- Prompt and tool text for the Anthropic Workspace path is written from public documentation, with the source recorded in `docs/anthropic-workspace.md`. Do not copy Claude Code's own prompt or tool descriptions.
- The one automatic routing that exists is the `anthropic-auto` preset: Jev picks an Anthropic model and effort per conversation, never `max`, and Anthropic turns run without subagents (decision record: #35, `docs/jev.md`). Do not extend it to other providers, Anthropic Workspace included, without a new decision. Anthropic Workspace has none of Hibana's own delegation. With Ultra stored and Claude Haiku 5.5 selected, and only then, its session may start dynamic workflow runs of the official Managed Agents API under the turn's budget ("Haiku Ultra", decision record: #76); every other model and mode there runs without delegation.
- When this month's Anthropic budget, today's estimate taken off, goes below the budget threshold (default $10), the settings API rewrites, once a billing month, every stored choice of the `anthropic` and `anthropic_workspace` providers to the budget fallback model (default Haiku 5.5 High; any preset but Auto and Workspace, decision record: #146): servers and personal settings, fixed subagent and role models, and Text Generation Models when the fallback is an Anthropic API preset; a Workspace choice takes Ultra off and the fallback's model on Workspace, or the fallback itself when that is not an Anthropic API preset (decision record: #121, #146). Nothing swaps a request afterwards, so settings picked after the switch run as picked, and they are not put back when the budget recovers; the budget going back above the threshold and below it again in the same billing month does not switch again (decision record: #128). The fallback and threshold are set on the dashboard's 利用料 page, by an Administrator only (decision record: #95). The settings API decides from the Admin API reports and the stored threshold (`/internal/budget`, meta `budget_fallback_switched`); the bot polls it and keeps its last answer for the Discord notice. Other providers are not switched (decision record: #89).
- Meeting recording (`/recording`, decision record #118, `docs/recording.md`) transcribes a voice channel with xAI's streaming Speech to Text and summarizes it with the server's Text Generation Model (`text_model`: Anthropic API presets only, Haiku 5.5 medium by default). Keep its bounds: three hours a recording, two at once, one per server (held until the bot has left the voice channel), eight speakers and sixteen xAI streams at once, no retry of a stream xAI refused, summary requests in parts of about 60,000 estimated tokens and at most twelve parts, and the result sent to at most 25 participants' direct messages (decision record #152; the command channel gets it only when none could be sent it). It never answers, and it shares no voice connection with `/join`. Its audio (decision record #138), when static sites are served, is kept as Discord sent it, never re-encoded on the VPS, and published with the transcript as an artifact for three days (`RECORDING_AUDIO_TTL_HOURS`) that can be neither extended nor made permanent; the page mixes and encodes in the browser. Keep the room for that audio bounded over every recording, the one in progress included (1 GB, `RECORDING_AUDIO_MAX_BYTES`), removing the oldest recording first and then refusing the audio; recordings do not count against `publish_site`'s limits. `/join` keeps no audio. Remove the transcript file and the audio from `HIBANA_DATA_DIR/recordings` once delivered. It has not been run against the real Discord or xAI, and the page has been run in Chromium only.
- On the `anthropic` provider, with a model in Anthropic's tool search table, integration tools outside `LOADED_TOOLS` are sent with `defer_loading` and Anthropic's BM25 tool search is added (decision record: #126, `docs/prompt-cache.md`). Claude Max, Anthropic Workspace and every other provider keep their full tool list. It has not been run against the real API.
- Bot API and dashboard share the settings and model catalog in `packages/shared`.
- Explain non-obvious behavior in comments. Keep migration documentation honest about validation limits.

- For VPS operations, read `.local/deployment.json` first for the SSH target, service and paths. This machine-local file is gitignored; reuse it instead of asking for the connection details again. Never copy credentials into tracked files.

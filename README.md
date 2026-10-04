# Hibana

Discord AI bot・設定API・WebダッシュボードをまとめたBun / TypeScriptモノレポ。

| パス | 内容 |
| --- | --- |
| `apps/bot` | Discord gateway、LLM / ツールループ、履歴・再開、Docker sandbox、スキル、通話 |
| `apps/api` | Elysia、Discord OAuth、ロール管理、Neon Postgres、設定のSSE同期 |
| `apps/web` | React / Viteの設定ダッシュボード |
| `packages/shared` | 設定スキーマ・モデルカタログ・トリガー |

Advisor、自動モデルRouter、品質検証（verify）、速度優先（fast）は削除済みです。モデルは明示的な選択（ユーザー → サーバー → 移行済み既定値 / 環境変数）で決まります。OpenRouterプロバイダー、サブエージェント、Reactの画面遷移は引き続き利用できます。

## 開発

Bun 1.4以降、Docker（sandboxを使う場合）が必要です。

```sh
bun install --frozen-lockfile
cp apps/bot/.env.example apps/bot/.env
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env
# .envのトークン・OAuth・APIキーを設定
bun run dev:api
bun run dev:web  # 別ターミナル
bun run dev:bot  # 別ターミナル
```

botだけなら `WEB_API_URL` を空にして起動できます。APIの `DATABASE_URL` が空の場合はメモリ保存です。本番ではPostgres接続を設定してください。botとAPIの `WEB_INTERNAL_TOKEN` は同じ値にします。

Discord Developer PortalでMessage Content Intentを有効にしてください。メンバー検索にはServer Members Intent、通話にはVoice関連のBot権限も必要です。

```sh
make ci                  # 型検査・テスト・bot / Webビルド
bun run test:ui          # Chromiumによる画面テスト
make sandbox-image      # amd64。言語処理系・ブラウザ・メディア処理を含む大きなイメージ
make sandbox-smoke      # Docker隔離・ファイル操作の確認
```

## 主な機能

- メンション、Hibana / ひばな / ヒバナ / 火花、旧トリガー、スレッド・フォーラム名で応答。
- `/switch`、`/temperature`、`/exa`、`/verify`、`/fast`、`/clear`、`/context`、`/retry`。
- Chat Completions / Responses / Anthropic Messages。プロバイダーの認証情報を分離。
- [Jev 判定と行動選択モード](docs/jev.md)。根拠照合・分類・終了時の完了チェックと、Jev がファイル操作・検索などの各行動を選ぶ実行モードを別々に ON / OFF。
- Discord操作、ファイル編集・配信、Exa検索、外部MCP、スキルCRUD、静的サイト公開。
- 制限付きDockerでのbash・メディア処理・ブラウザ・動画レンダリング。Python製の既存メディアスキルは資産として引き継ぎ。
- GitHub device login、Surfshark / VPN Gate、xAI STT / S2S通話（オプトイン）。
- サーバー／個人の設定、OAuth・ロール・利用停止、成果物・スキル管理のWeb画面。

## 運用・移行

稼働先・更新手順は[本番環境](docs/production.md)を参照してください。

[移行手順](docs/migration.md)に、Git履歴・旧データの扱い、Vercel / systemd設定と検証範囲を記載しています。

リポジトリ: <https://github.com/hsincode/hibana>

MIT。元リポジトリの著作権表示と履歴を保持しています。

設定画面のサブエージェントは off（無効）/ on（明示的な委譲要求時）/ ultra（Claude Code の Ultracode：xhigh とワークフローの常時編成）/ multi（役割分担・並列の Multi-Agent）から選択できます。保存済みの effort・Jev 判定とは独立しています（ultra の間だけ xhigh で動きます）。既存の Ultra 設定はそのまま ultra として引き継ぎ、Ultracode として動きます。on / ultra / multi ではメッセージにキーワード `ultracode` を書くと、その回だけワークフローで実行します。multi では Jev 行動選択モードを使いません。保存済みの個人設定はサーバー設定から独立します。仕組みと Claude Code との違いは [Ultra（Claude Code の Ultracode）](docs/ultracode.md) を参照してください。
Service Tier は auto / default / priority / flex / ultrafast を設定でき、OpenAI・Codex Plus/Pro・ChatGPT の親・子エージェントのリクエストに適用します。auto はフィールドを省略して接続先の既定値を使い、他プロバイダーには送信しません。モデル・接続先・アカウントによって利用可否や料金が異なります。ultrafast は対応モデルと権限のあるアカウント（API の対象顧客、Codex では Enterprise / Pro 500 など）に限られ、API 料金は標準の約 6 倍です。権限がない場合はエラーにならず、レスポンスの `service_tier` が default などに落ちることがあります。旧 fast フラグは復活させません。
送信値は [OpenAI API Reference](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create/) に準拠しています。設定保存・HTTPリクエスト生成・子への継承は自動テスト対象ですが、各ゲートウェイやChatGPTでの全Tierの受付・速度・課金は実測していません。
協調ツール、サブエージェントのモデル・effort 設定、履歴継承と検証範囲は
[Multi-Agent V2](docs/multi-agent.md) を参照してください。

PCの画像生成連携とサービス操作は [local-image-generation.md](docs/local-image-generation.md) を参照してください。

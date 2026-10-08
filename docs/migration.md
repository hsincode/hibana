# Deepseeker → Hibana

## ソースと履歴

3つのローカルリポジトリを統合しました。botのGit履歴を土台に、APIとWebの履歴を `git subtree` で取り込みました。移行元のコミットと未コミット変更の一覧は [migration-sources.json](migration-sources.json) にあります。APIとWebの未コミット変更も移行後のソースに含め、元の作業ツリーは変更していません。

- `codeberg.org/xuanling/deepseeker` → `apps/bot`
- `codeberg.org/xuanling/deepseeker-api` → `apps/api`
- `codeberg.org/xuanling/deepseeker-app` → `apps/web`

RustのアプリケーションをBun / TypeScriptへ置き換えました。APIとWebは既存のTypeScript実装を統合・更新しています。Pythonのメディア生成スキル、Dockerfile、ブラウザのJSヘルパーは既存資産として保持しています。

Advisorと自動モデルRouterのコマンド、ツール、設定、UIを削除しました。旧DB内の該当キーは読み込み時に除外され、PATCHでは拒否されます。OpenRouter等のプロバイダー名やReact Routerは別用途なので保持しています。モデルの切り替えは明示的に行います。2026-10 に追加した「Anthropic / Auto (Jev)」プリセットは、削除した Router の復活ではなく別の実装です（#35、[jev.md](jev.md#anthropic-の-auto-routing)）。

## 設定とデータ

設定画面・Discord コマンドから、サーバー設定の「継承」を削除しました。新規サーバーはデフォルト値を直接保存します。既存サーバーの空欄や `null` は API 起動時に具体値へ変換し、Bot 単独運用では状態ファイルの読み込み時に変換して保存します。サーバーの「デフォルトに戻す」も具体値を書き込み、その後の環境変数変更には追従しません。

マイ設定はこれと別です。各項目の `null` はデフォルトで、話しているサーバーの値に従います（DM はプロセスの初期値）。利用者がその項目を変えたときだけ上書きします。API の初回起動で、それまでに全項目が埋まっていた個人設定は一度すべてデフォルトへ戻し、ダッシュボードの利用者に個人設定の行がなければ同じ空の行を作ります。この初期化は meta `personal_inherit_v1` がある間は繰り返さないので、その後に保存した上書きは残ります。

API の初期値には `PROVIDER` / `LLM_MODEL` / `LLM_EFFORT`、`ULTRA_MODE`、`MULTI_AGENT`、`JEV_ENABLED` / `JEV_TASK_ENABLED`、`LLM_TEMPERATURE`、`EXA_ENABLED`、`DISCORD_SUPPRESS_EMBEDS`、`THREAD_HISTORY_MAX_AGE_SECS`、`EXTRA_TRIGGERS` を使います。API と Bot を別環境で動かす場合は、更新前にこれらの非秘密設定を一致させてください。品質検証（`verify_enabled` / `VERIFY_ENABLED`）と速度優先（`fast_enabled` / `FAST_MODE`）は廃止しました。保存済みのキーは読み込み時に捨て、PATCH では未知のフィールドとして拒否されます。Discord の `/verify` と `/fast`、Codex への `speed=fast`、回答後の再採点もありません。資格情報は各プロセスで独立して管理します。2026-09-21 に本番の既存17設定行を具体値へ移行し、明示済みのモデルと主要な設定値の保持を確認しました。今回の変更だけを取り出したソースで `make ci`（240テスト）と画面テスト（13件）を実行し、Web/API の HTTP 200、Bot の正常起動と `sandbox:true` を確認済みです。Discord OAuth の実ログイン操作は今回の検証に含みません。

Ultra（`ultra_mode`）は、Codex の Effort: Ultra を再現した積極的な委譲から、Claude Code の Ultracode に置き換えました（[Ultra（Claude Code の Ultracode）](ultracode.md)）。
- 保存形式は変えていないので、設定の移行はありません。
- 既存の ultra の行は、次のメッセージから xhigh とワークフローの常時編成で動きます。
- multi の行は従来どおりの動作です。
- bot に `quickjs-emscripten-core` と `@jitl/quickjs-wasmfile-release-sync` を追加したので、更新時に `bun install --frozen-lockfile` が必要です（[本番環境](production.md)の VPS 更新手順に含まれています）。
- 新しい環境変数（`WORKFLOWS_ENABLED` など）は省略でき、省略時は Claude Code と同じ既定値を使います。

この変更は自動テストでのみ検証しています。本番への反映と実モデルでの確認はまだです。

1. 移行先で `bun install --frozen-lockfile` を実行します。
2. 各アプリの `.env.example` から新しい `.env` を作り、既存のトークン・APIキー・DB接続・OAuth設定を秘密情報ストアから設定します。`.env` はGitに追加しません。
3. botの `HIBANA_DATA_DIR` を新しい永続領域に設定します。旧botを停止し、旧状態ファイルのバックアップから次のコマンドで変換します。

```sh
bun scripts/migrate-state.ts /backup/runtime_state.json /var/lib/hibana/runtime_state.json
```

変換先が存在すると停止します。旧ファイルは上書きしません。サーバー・個人設定とプロセス既定値を保持し、廃止した設定を除外します。環境変数より保存済み既定値が優先され、ユーザー・サーバーの明示指定はさらに優先されます。`WEB_API_URL` 利用時、サーバー・個人設定はAPI側のスナップショットが正となるので、既存DBを継続するかDBをバックアップから移行してください。実際のDBに対する移行はこのリポジトリ作成時には行っていません。

旧Rustの会話メモリ・再開チェックポイント・公開サイトメタデータは新形式と互換性がありません。進行中の作業を完了してから切り替えてください。必要な成果物・カスタムスキル・動画プロジェクトは旧データを残したうえで新しいディレクトリ構成にコピーし、サイトは再公開してください。既存URLを残す場合は旧静的サイト配信を移行期間中維持します。

`RUNTIME_STATE_PATH`、`WEB_API_URL`、`WEB_INTERNAL_TOKEN`、各 `*_API_KEY` / `*_BASE_URL`、主要LLM・履歴設定は継続します。保存先は `HIBANA_DATA_DIR` を起点とします。旧 `ADVISOR_*` / `ROUTER_*` は削除してください。履歴の `HISTORY_LIMIT` / `HISTORY_MAX_AGE_SECS` / `HISTORY_CACHE_IDLE_SECS` は廃止し、`HISTORY_MAX_TOKENS` / `HISTORY_KEEP_TOKENS`（推定トークン数による上限と、削った後に残す量）に置き換えました。個別の旧sandboxリソース変数はそのまま使わず、[現行の制限](../apps/bot/sandbox/README.md)と `config.ts` を確認してください。`SANDBOX_TTL_HOURS` と公開サイトのTTL・容量・件数設定は引き継げます。

OAuth Cookieは `hibana_session` に変更しました。利用者は再ログインが必要です。Discord Developer PortalのリダイレクトURLと、Web/APIの許可オリジンを新URLに合わせて変更します。

## 起動と配置

botは常時稼働するLinuxホストに配置します。DiscordのMessage Content / Server Members Intentを有効にし、Bun 1.4以降とDockerを導入してください。リポジトリ直下で `make sandbox-image` を実行します。動画/VPNを利用するときは `make video-image` / `make vpn-image` も実行します。

- systemd: `/opt/hibana` にコード、`/etc/hibana/bot.env` に環境変数を配置し、`deploy/hibana.service` のユーザー・Bunパスをホストに合わせます。`hibana` ユーザーに `/var/lib/hibana` の書き込み権限とDocker利用権限を与えます。
- Docker Compose: `apps/bot/.env` を用意し、`HIBANA_HOST_SKILLS_DIR` をホスト側の `apps/bot/skills` の絶対パスに設定して `docker compose up -d --build` を実行します。Linuxのhostネットワークを使います。Docker bind mountのため、永続領域とスキルはホストとbotコンテナ内で同じ絶対パスにします。Composeはbot用です。
- API: `bun run dev:api`（開発）または `bun run --cwd apps/api start`（設定済みのホスト）。VercelではRoot Directoryを `apps/api` にします。
- Web: `bun run dev:web`（開発）またはVercelでRoot Directoryを `apps/web`、Build Commandを `bun run build`、Output Directoryを `dist` にします。

Vercelの両プロジェクトではRoot Directory外のソースをビルド対象に含め、モノレポルートのlockfileと `packages/shared` を参照できるようにします。APIの環境変数とWebの `VITE_API_URL` は各プロジェクトに設定します。APIがクロスサイトの場合はHTTPSとCookie設定を合わせてください。

静的サイトは `STATIC_SITE_ENABLED=true` と `STATIC_SITE_BASE_URL`、公開用リバースプロキシが必要です。`/s/` をAPIやダッシュボードと別オリジンで配信します。botログは日付ごとに保存し、14日で回収します。

## 検証範囲

- TypeScript型検査、API・bot・共有設定の自動テスト、bot/Webビルド。
- ローカルHTTPモックでLLM応答 → ツール実行 → Discord送信アダプター、および実際の設定APIへの更新。
- Playwrightでレスポンシブ画面、保存操作、テーマ、ダイアログ、Advisor/Router表示の除去。
- Docker実行で秘密情報・Docker socketの非注入、read-only root、スキルマウント、ファイル操作、スレッド隔離、タイムアウト後のコンテナ回収。ローカル検証は既存sandboxイメージへ変更層を加えた `hibana-sandbox:verification` を使用しました。
- bot用Dockerfileのビルドと、ネットワークを無効にしたコンテナでの `--check` 起動。
- ローカルCONNECTプロキシでVPN通信経路とプライベート宛先の拒否。

初回リライト時点では、実Discordへの送信、実LLM呼び出し、Neonへの書き込み、OAuth本番ログイン、Surfshark接続、xAI通話、VPSの切り替えは未実施でした。その後の配置状況は[本番環境](production.md)を参照してください。既存のカスタムゲートウェイとモデルカタログは保持していますが、各モデルの現在の利用可否は契約先で確認が必要です。旧botの全挙動を実サービスで比較したものではありません。

OpenCode Go はプロバイダーごと削除済みです。未指定時の既定は Codex Plus / GPT-6 Luna（`PROVIDER=CODEX_PLUS`、`LLM_MODEL=gpt-6-luna`、`CODEX_PLUS_API_KEY`）です。保存済みの `opencode_go` 選択はデフォルトのモデルへ変換して保存します。Codex Plus / Pro / ChatGPT に保存された `gpt-5.6-sol`・`gpt-6-sol`・`gpt-5.6-luna` は読み出し時に `gpt-6.1-sol` / `gpt-6-luna` へ、Claude Max の `claude-fable-5` は `claude-fable-5-1` へ書き換えます。同じ値の `LLM_MODEL` も起動時に読み替えます。それ以外の環境変数は自動書き換えしません。OpenRouter はプロバイダー接続として残していますが、モデルプリセットは無いため `LLM_MODEL` の明示が必要です。

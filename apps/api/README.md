# Hibana API

Bun / Elysiaの設定マスタ。Discord OAuth、ユーザーロール、サーバー・個人設定、成果物・スキル管理、bot向けSSEを提供します。設定スキーマは `@hibana/shared` を利用します。

リポジトリルートで `bun install` 後、`bun run dev:api`。環境変数は `.env.example` を参照してください。`DATABASE_URL` 未設定時はメモリストア、設定時はNeon Postgresを使用します。

Vercelではこのモノレポの `apps/api` をRoot Directoryにし、ルートのworkspace依存もビルドへ含めます。APIの公開URLを `WEB_PUBLIC_BASE_URL`、WebのURLを `FRONTEND_ORIGIN`、botと共通の内部認証を `WEB_INTERNAL_TOKEN` に設定します。OAuth redirectは `${WEB_PUBLIC_BASE_URL}/auth/discord/callback` です。

詳細は[移行手順](../../docs/migration.md)。

# Hibana Web

React / Viteの設定ダッシュボード。モデル、ハーネス、検索、人格、スキル、成果物、ユーザー権限を管理します。

リポジトリルートで `bun run dev:web`。ローカルでは `/api` と `/auth` を `127.0.0.1:3000` に転送します。VercelではRoot Directoryを `apps/web` に指定し、`VITE_API_BASE_URL` と `VITE_SITE_URL` を設定してください。

Advisorと自動モデルRouterの設定画面はありません。

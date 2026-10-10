# Hibana Web

React / Viteの設定ダッシュボード。モデル、ハーネス、検索、人格、スキル、成果物、ユーザー権限、利用停止、サーバー単位の停止を管理し、会話ログを読めます。

リポジトリルートで `bun run dev:web`。ローカルでは `/api` と `/auth` を `127.0.0.1:3000` に転送します。VercelではRoot Directoryを `apps/web` に指定し、`VITE_API_BASE_URL` と `VITE_SITE_URL` を設定してください。

Advisorと自動モデルRouterの設定画面はありません。

## 画面の構成と見た目

ページの分け方、保存の見せ方、色・書体・動きの決まりは [docs/web-dashboard.md](../../docs/web-dashboard.md) にまとめてあります。

- `src/nav.ts`: ページとコマンドパレットの項目の一覧
- `src/Shell.tsx`: 上部バーとサイドバー。`src/Palette.tsx`: コマンドパレット
- `src/Guild.tsx`: サーバー設定の 5 ページと、サーバー単位の停止。`src/Me.tsx`: マイ設定
- `src/Users.tsx`: ロールの変更と利用停止。`src/Logs.tsx`: 会話ログ
- `src/Agent.tsx`: モデル・サブエージェント・Jev の設定行と「実際の動作」
- `src/settings.tsx`: 保存（楽観更新と巻き戻し）とコンテキストの設定行。`src/save.tsx`: 保存の印と設定行
- `src/styles/`: スタイル。`src/fonts/`: 同梱している書体（出所とライセンスは同じディレクトリの README）

## 画面テスト

```sh
bun run test:ui
```

API は模擬し、fixture の値だけを使います。全ページの画像は `CAPTURE_GALLERY=1 bun run test:ui -g gallery` で `test-results/gallery` に書き出せます。

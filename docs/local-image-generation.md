# PCのQwen Image 2.1をボットから使う

ボットの組み込みツールとして `mcp__workspace__image_generation_status`、`mcp__workspace__generate_image`、`mcp__workspace__edit_image` を公開します。既存の外部MCP URLとは独立した機能です。汎用MCPサーバーではなく、HibanaのMCP形式のツール名から、専用HTTPブリッジを呼び出します。

PC上のサービスがComfyUI、認証付きブリッジ、SSH転送をまとめて管理します。PCからVPSへ接続し、VPSの `127.0.0.1:18190` のみで受け付けます。PCの電源が切れているときやサービス停止中は利用不可になります。ボットからの起動、Wake-on-LAN、代替プロバイダーへの切り替え、自動再試行は行いません。電源断の検出にはSSHのkeepalive分だけ遅れがあり、状態確認は最大約3秒で返ります。

## このPCでの操作

```bash
~/AI/qwen-image-2.1/service.sh status
~/AI/qwen-image-2.1/service.sh stop
~/AI/qwen-image-2.1/service.sh start
~/AI/qwen-image-2.1/service.sh logs
```

DockerはこのPCのrunitで起動済みです。コンテナの `restart: unless-stopped` により、稼働中にPCを終了した場合は次回起動時に自動復帰し、`stop` で停止した場合はPCを再起動しても停止を維持します。ログインは不要です。再び自動起動を有効にする操作は `start` です。`docker compose up -d` は明示的に起動するので、停止を維持したいときは実行しないでください。

ブラウザからの利用は http://127.0.0.1:8188 。サービス停止時はブラウザ側も停止します。ComfyUIを別に手動起動するとポートが競合するため、このサービスを使って起動してください。

## ボット側

VPSの環境変数に以下を設定します。トークンはPCの `service/secrets/token` と一致させます。秘密値はGitに含めません。

```dotenv
IMAGE_WORKER_URL=http://127.0.0.1:18190
IMAGE_WORKER_TOKEN=<ランダムな32文字以上の秘密値>
```

サンドボックスが利用可能な場合にツールが有効になります。通常の「画像を生成して」という依頼から呼び出せます。画像はサーバー／DM単位の作業領域に保存され、既存の `send_file` で送信します。ブロック済みユーザー・ボット無効設定・ディスク容量制限も適用されます。外部MCP設定のURL変更は不要です。

トリガーになるメッセージの本文が `/image ` で始まるときは、モデルを呼ばず、その後ろの文をプロンプトとして生成して返信します。Discordのスラッシュコマンドにはしていません。コマンド補完が入力の邪魔になるため、本文の文字として検出します。`@Hibana /image …` のようにメンションが先頭に付いていても同じです。トリガーにならないメッセージや、プロンプトが空のメッセージは生成しません。添付画像の編集はこの近道を使わず、通常の会話で `edit_image` に任せます。

同時生成は1件です。縦横256〜1024（32の倍数）、1〜50ステップ、プロンプト8000文字までを受け付けます。初期値は1024×1024・25ステップです。既定の上限は16GB GPUで確認した設定に合わせています。10分以内に応答がなければ失敗を返します。ブリッジの制限は570秒で、時間切れ・通信切断時はそのリクエストの生成だけをキャンセルします。

## 添付画像・生成済み画像の編集

Discordで画像を添付（または画像のあるメッセージへ返信）して、「この画像の背景を夕焼けに変えて」のように依頼します。`edit_image` はこのターンの最初の画像を既定で使います。複数添付時は `image_index`（0始まり）で1枚選びます。生成済み画像などは、この会話の作業領域内の `image_path` でも指定できます。

```json
{"prompt":"ティーポットだけを青くして。他の部分はそのまま。","image_index":0}
```

- 入力: 静止PNG/JPEG/WebP、1枚16MiB・1600万画素まで、縦横比1:4〜4:1。
- `resolution`: 512 / 768 / 1024（既定）。縦横比を保ち、およそ resolution² 画素に調整します。新規生成用のwidth/heightは編集には指定しません。
- `steps`: 1〜50（既定25）、`seed`: 0〜4294967295（既定42）。
- 元画像は上書きせず、新しいPNGを作業領域に保存します。PCへ渡した一時入力は成功・失敗とも削除します。

添付画像はVPSで既存の外部アクセス検証を通して取得し、画像データだけをPCへ転送します。PCはモデルから渡されたURLを取得しません。編集は公式の参照画像条件付けを使用し、元画像と同じ比率のlatentを使います。

## 構成・再構築

- `devices/image-worker/worker.py`: 認証、入力制限、1件ずつの生成、PC側プロセス管理。
- `devices/image-worker/workflow.json`: 新規生成の基準グラフ。編集時は入力画像とVAEをエンコーダーに接続します。
- `devices/image-worker/Dockerfile`: AMD用Python環境をホストからマウントする実行イメージ。
- `devices/image-worker/compose.example.yaml`: 移設用テンプレート。実機の設定は `~/AI/qwen-image-2.1/service/compose.yaml`。
- `service/secrets/`: SSH専用鍵、確認済みVPSホスト鍵、HTTP認証トークン。ディレクトリ700、秘密ファイル600。

```bash
docker build -t hibana-image-worker:local devices/image-worker
docker compose -f ~/AI/qwen-image-2.1/service/compose.yaml up -d
```

専用SSHユーザーはログインシェルを無効化し、`AllowTcpForwarding remote`、`PermitListen 127.0.0.1:18190`、`MaxSessions 0` に制限します。公開鍵にも `restrict,port-forwarding,permitlisten="127.0.0.1:18190"` を付けます。一般ユーザーのSSH鍵やroot鍵をコンテナへ渡しません。

## 検証

```bash
make ci
cd devices/image-worker
~/AI/qwen-image-2.1/.venv/bin/python -m unittest -v test_worker.py
```

ユニットテストは認証拒否、入力検証、停止中、同時実行拒否、タイムアウト時の対象限定キャンセル、作業領域の分離、容量制限、リダイレクト拒否、無効化設定を確認します。2026-09-21にVPSの実ツール経路から1024×1024・25ステップの画像生成と受け取り（52.5秒）、手動停止後の `online: false` と転送ポート消失、再開後の `online: true` を確認済みです。画像編集追加後の `make ci` とブリッジのテスト結果は下記の確認記録を参照してください。PCそのものの再起動や実Discordへの送信は検証に含めません。

画像編集の確認記録（2026-09-21）:

- `make ci`: 型チェック・211テスト・全アプリのビルド成功。
- Pythonブリッジ: 7テスト成功。画像入力検証、編集グラフ、成功／時間切れ時の一時画像削除を含む。
- 実GPUで1024×1024・25ステップの編集成功（約87秒）。レッサーパンダと構図を保ち、ティーポットを赤から青へ変更した出力を目視確認。

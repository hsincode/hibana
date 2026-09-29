# Hibana sandbox

Hibanaのbash・ファイル操作・ブラウザが使うDockerイメージです。リポジトリ直下でビルドします。

```sh
make sandbox-image
make sandbox-smoke
make video-image
make vpn-image
```

イメージ名は `hibana-sandbox:latest`、`hibana-video:latest`、`hibana-vpn:latest`。レジストリへのイメージ配信は設定していません。

bash、ripgrep、curl、git、gh、Bun、Go、Python、Node、Chromium / Playwright CLI、ffmpeg、ImageMagick、Blender、yt-dlp、pandoc、WeasyPrint、日本語フォントなどを同梱しています。詳しいバージョンと依存関係は各Dockerfileを参照してください。現在のsandboxはamd64向けです。

通常の実行はread-only rootfs、cap-drop、no-new-privileges、512 MiB RAM（swap込み768 MiB）、1 CPU、128 PID、256 MiBのtmpfsです。`/workspace` だけを書き込み可能な作業領域としてマウントし、内蔵スキルは `/skills` に読み取り専用で渡します。APIキーやDockerソケットを作業コンテナへ渡しません。GitHubログイン済みの場合に限り、スコープ別の認証設定を読み取り専用で渡します。

作業領域は通常チャンネルではサーバー共有、スレッドとDMでは独立しています。既定12時間の未使用領域を1時間ごとに回収し、実行中のターンとブラウザは対象から外します。1領域3 GiB、全体8 GiBの書き込み前チェックがあります。Dockerのブロックデバイス割当制限ではないため、ホスト側でも空き容量を監視してください。

ブラウザは専用のコンテナを1つ起動し、同じユーザー・チャンネルだけが継続利用できます。384 MiB RAM、0.5 CPU、128 PIDで、keeperがアイドル10分・最長1時間の寿命を管理します。終了時にCookieを破棄します。ブラウザと動画ワーカーの同時起動を拒否します。

通常の外向き通信はDocker bridge、VPN接続中は `hibana-vpn` のネットワークを使います（`VPN_PROVIDER=surfshark` または `vpngate`）。ホスト側のダウンロード・Exa・MCPもローカルVPNプロキシを使い、接続前のパブリックIP検査とDNS固定を維持します。モデルAPIとDiscordは通常のホスト回線を使います。VPN Gate は公開ボランティア中継なので、アカウントパスワードは通しません。

`BROWSER_PROXY_URL` と `BROWSER_PROXY_USERNAME` は自宅経路ツールを有効にする設定です。通常は接続せず、管理者の作業で `home_vpn_connect` を呼んだ場合だけ、そのタスクのブラウザ・yt-dlp・bash HTTP(S) がDocker bridgeからESP32中継へ接続します。状態確認は `home_vpn_status`、終了時は `home_vpn_disconnect`。切り替えでブラウザを閉じるためCookieは破棄されます。作業終了・エラー・15分間の未操作でも接続を解除し、VPSの端末待受も停止します。作業中のツール操作がある限り最長時間の上限はありません。構成と検証範囲は [home-egress](../../../devices/home-egress/README.md) を参照してください。

動画の保存プロジェクト、カスタムスキル、GitHub認証、公開サイトは作業領域TTLとは別に保持します。旧イメージを使う場合、ブラウザのパスとripgrepが異なるため再ビルドが必要です。

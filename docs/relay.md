# デプロイ中継サーバー（relay）

`apps/relay` はVPS上で動く小さなHTTPサーバーです。APIキーで認証し、botを最新の `main` へ更新する処理とログの返却を行います。GitHub Actionsは `main` へのpush時、CIが成功した後にこのサーバーを呼び出して自動更新します。

対象はbotだけです。APIとWebは引き続きVercelへデプロイします。

## 動作

| エンドポイント | 必要なスコープ | 内容 |
| --- | --- | --- |
| `GET /healthz` | なし | 死活確認 |
| `GET /status` | 任意の有効なキー | 稼働中のコミットと直近のデプロイ |
| `POST /deploy` `{"sha": "<40桁>"}` | `deploy` | デプロイを開始し、202とIDを返す |
| `GET /deploys`、`GET /deploys/:id` | 任意の有効なキー | 各ステップの結果と出力 |
| `GET /logs?lines=200&since=<epoch秒 or ISO 8601>` | `logs` | `hibana.service` のjournal（最大2000行） |

認証は `Authorization: Bearer hbr_...` で行います。

デプロイは次の順に進みます。同時に実行できるのは1件だけで、実行中の要求には409を返します。

1. `git fetch origin main` を実行し、要求されたSHAが `origin/main` と一致するか確認します。
   - 一致しない場合は何も変更しません。
   - SHAが `main` の祖先であれば `superseded`（新しいpushのCIが後から更新します）、それ以外は `failed` になります。
   - このため、`deploy` キーが漏れても、古いコミットや `main` 以外のコミットへは戻せません。
2. `git checkout --force --detach <sha>` を実行します。追跡対象ファイルへの手動の変更は破棄されます。`node_modules` などの追跡対象外ファイルは残ります。
3. `bun install --frozen-lockfile` を実行します。
4. `systemctl restart hibana` を実行し、journalに `Hibana ready` が出るまで最大90秒待ちます。
5. 途中で失敗した場合は直前のコミットで2〜4を実行し、`rolled_back` になります。ロールバックも失敗した場合は `failed` です。

relayは更新対象と同じ `/opt/hibana` から起動します。`apps/relay`・`package.json`・`bun.lock` が変わったデプロイの後は、relay自身が終了し、systemdが新しいコードで再起動します。そのため、CIのポーリングが数秒間つながらないことがあります。デプロイ履歴は `/var/lib/hibana-relay/deployments.json` に保存され、再起動後も残ります。

APIキーはsha256ハッシュだけを `/var/lib/hibana-relay/keys.json`（0600）に保存します。トークンは発行時に一度だけ表示されます。ファイルはリクエストごとに読み直すため、発行や失効はrelayを再起動しなくても反映されます。

`logs` スコープのキーでは、Discordの発言内容を含むログを読めます。CIに登録するキーには `deploy` スコープだけを付けてください。

## 権限の構成

- relayは専用ユーザー `hibana-deploy` で動き、`/opt/hibana` の所有者になります。botを動かす `hibana` ユーザーには読み取り権限だけがあります（`UMask=0022`）。
- botの再起動は `deploy/50-hibana-relay.rules`（polkit）で許可します。許可するのは `hibana.service` の `restart` だけです。sudoを使わないため、`NoNewPrivileges=true` を維持できます。
- journalは `systemd-journal` グループとして読みます。
- GitHubからの取得には、`hibana-deploy` だけが持つ読み取り専用のDeploy keyを使います。
- relayは `127.0.0.1:8790` で待ち受け、HTTPSは既存のCaddyがLet's Encryptで終端します。Cloudflare Tunnelを使う場合は、`cloudflared` の転送先を `http://127.0.0.1:8790` にすればCaddyの設定は不要です。

## 初回セットアップ（VPS）

以下は未実施の手順です。現在の `/opt/hibana` はrsyncで配置したもので、`.git` がありません。そのため、git checkoutへ置き換える移行が必要です。

```sh
# 1. ユーザーとDeploy key
useradd --system --home-dir /var/lib/hibana-relay --shell /usr/sbin/nologin hibana-deploy
install -d -o hibana-deploy -g hibana-deploy -m 0700 /var/lib/hibana-relay /var/lib/hibana-relay/.ssh
sudo -u hibana-deploy ssh-keygen -t ed25519 -N '' -C hibana-relay -f /var/lib/hibana-relay/.ssh/id_ed25519
sudo -u hibana-deploy sh -c 'ssh-keyscan github.com >> ~/.ssh/known_hosts'
# 公開鍵を読み取り専用のDeploy keyとして登録（手元で実行）
#   gh repo deploy-key add id_ed25519.pub --repo hsincode/hibana --title hibana-relay

# 2. git checkoutへ置き換え（稼働中のコミットに合わせる）
commit=$(cat /opt/hibana/DEPLOYED_COMMIT)
install -d -o hibana-deploy -g hibana-deploy /opt/hibana.new
sudo -u hibana-deploy HOME=/var/lib/hibana-relay git clone -q git@github.com:hsincode/hibana.git /opt/hibana.new
sudo -u hibana-deploy git -C /opt/hibana.new checkout -q --detach "$commit"
sudo -u hibana-deploy HOME=/var/lib/hibana-relay sh -c 'cd /opt/hibana.new && /usr/local/bin/bun install --frozen-lockfile'
systemctl stop hibana
mv /opt/hibana /opt/hibana.rsync-backup && mv /opt/hibana.new /opt/hibana
systemctl start hibana   # journalctl -u hibana で Hibana ready を確認

# 3. relay本体
install -m 0644 /opt/hibana/deploy/hibana-relay.service /etc/systemd/system/
install -m 0644 /opt/hibana/deploy/50-hibana-relay.rules /etc/polkit-1/rules.d/
usermod -aG systemd-journal hibana-deploy
systemctl daemon-reload && systemctl enable --now hibana-relay
install -m 0644 /opt/hibana/deploy/relay.Caddyfile /etc/caddy/Caddyfile.d/hibana-relay
systemctl reload caddy

# 4. キー発行
sudo -u hibana-deploy /usr/local/bin/bun /opt/hibana/apps/relay/src/cli.ts key create --name github-ci --scope deploy
sudo -u hibana-deploy /usr/local/bin/bun /opt/hibana/apps/relay/src/cli.ts key create --name ops --scope logs
```

旧ディレクトリにあった追跡対象外のファイル（`.local/` の検証用ファイルなど）は自動では移しません。必要なものだけ `/opt/hibana.rsync-backup` からコピーしてください。`/etc/hibana/bot.env` は移行の影響を受けません。

`relay-bot.hsincode.com` は1階層下のサブドメインなので、Cloudflare Universal SSL（`*.hsincode.com`）の対象です。プロキシ済み（オレンジ雲）で使えます。

1. CloudflareのDNSで `relay-bot` のAレコードをVPSへ向けます。最初はDNS only（グレー雲）にします。こうするとCaddyがLet's Encryptの証明書を直接取得できます。
2. `.local/relay-setup.sh public` を実行します。HTTPSで `/healthz` が応答した場合だけ `RELAY_URL` を設定します。
3. レコードをプロキシ済みに切り替えます。このホストのSSL/TLSモードは Full (strict) にします。ゾーン全体がFlexibleの場合は、このホスト名だけに適用するConfiguration Ruleを作ります。FlexibleではCloudflareがVPSへHTTPで接続し、CaddyのHTTPSへのリダイレクトでループします。

プロキシ済みで証明書を更新するときは、HTTP-01チャレンジがCloudflare経由になります。更新に失敗する場合は、Cloudflare Origin CA証明書を発行し、Caddyの `tls <cert> <key>` で指定してください。GitHub ActionsからのリクエストがBot Fight ModeやWAFのチャレンジで止められる場合（`relay-deploy.sh` がHTTP 403で失敗します）は、このホストだけWAFのスキップルールを作ってください。

## GitHubの設定

```sh
gh variable set RELAY_URL --body https://relay-bot.hsincode.com --repo hsincode/hibana
gh secret set RELAY_DEPLOY_TOKEN --repo hsincode/hibana   # deploy スコープのトークンを貼り付け
```

`RELAY_URL` が未設定の間、CIの `deploy` ジョブはスキップされます。`checks` と `container` が成功した `main` へのpushだけが `scripts/relay-deploy.sh` を実行します。このスクリプトは手元からも使えます。

```sh
RELAY_URL=https://relay-bot.hsincode.com RELAY_TOKEN=hbr_... scripts/relay-deploy.sh "$(git rev-parse origin/main)"
curl -H "Authorization: Bearer $LOGS_TOKEN" 'https://relay-bot.hsincode.com/logs?lines=100'
```

## 検証の範囲

- 単体テスト（`apps/relay/src/relay.test.ts`）では、git・systemctl・journalctlを模擬して次の動作を確認しています: キー認証、スコープの判定、SHAの検証、`superseded`、ロールバック、同時実行の拒否、relay自身の再起動判定。
- ローカルの結合確認では、一時的なbareリポジトリに対してrelayを実際に起動し、`scripts/relay-deploy.sh` から次の結果を確認しました: 開始、`superseded`、再起動失敗時のロールバック、不正なキーでの401。
- 実際のsystemd・polkit・Caddy上の動作は、VPSでセットアップした後に確認が必要です。

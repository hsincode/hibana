# 本番環境

2026-09-19にTypeScript版Hibanaへ切り替えました。

| 対象 | 配置 |
| --- | --- |
| Web | https://bot.hsincode.com （Vercel `hsincode/hibana-web`、Root Directory `apps/web`。既定URLは https://hibana-web-mu.vercel.app） |
| API | https://api.bot.hsincode.com （Vercel `hsincode/hibana-api`、Root Directory `apps/api`。既定URLは https://hibana-api.vercel.app） |
| bot | 既存VPSの `/opt/hibana`、`hibana.service` |
| bot設定 | `/etc/hibana/bot.env` |
| botデータ | `/var/lib/hibana` |
| 退避データ | `/var/backups/hibana-migration`、旧 `/opt/deepseeker`・`/var/lib/deepseeker` |

`api.bot.hsincode.com` はCloudflare Universal SSL（`*.hsincode.com`）の対象外です。CloudflareではCNAME `api.bot` → `d9916215ed191ef6.vercel-dns-017.com` をDNS only（グレー雲）に設定し、Vercelの証明書で配信します。

両アプリの `vercel.json` は旧カスタムドメインと、そのプロジェクトへ到達する `*.vercel.app` を新ドメインへ308リダイレクトします。例外として、保護バイパスのヘッダー（`x-vercel-protection-bypass`）が付いたリクエストは `*.vercel.app` でもリダイレクトしません。配信のjobが、ドメインを切り替える前のデプロイを確かめるためです（[ADR-0005](adr/0005-verify-before-promote.md)）。パス・クエリとHTTPメソッドを維持するため、APIにも恒久リダイレクトを使用します。プレビューURLも本番へ転送されます（VercelのDeployment Protectionが有効なURLでは認証が先に適用されます）。OAuthのstate Cookieはホストごとのため、切り替え中のログインは新Webからやり直してください。

旧botは停止し、自動起動を無効にしました。Hibanaは専用ユーザー `hibana` で稼働し、Dockerグループに所属します。公開サイトは既存のCaddy経由で `127.0.0.1:8787` に接続します。旧VPNコンテナを `hibana-vpn` に改名し、既存接続を継続しています。VOICEVOXサービスは既存のものを利用します。公開サイト3件はVPS内の配信でHTTP 200を確認しましたが、旧ドメイン `artifacts.xuanling.me` 経由の外部アクセスはHTTP 403のため、旧ドメイン側の確認が別途必要です。

APIには新しいNeon DBを使用し、VPSに残っていた16サーバー分の設定・個人設定を取り込みました。旧APIはHTTP 402で取得できず、旧DB固有のユーザーロール・セッション・利用停止リスト・監査ログはこの取り込みに含まれません。管理者にはDiscordアプリ所有者を設定しています。ユーザーは新Webで再ログインしてください。

Discord OAuth2 Redirectsには `https://api.bot.hsincode.com/auth/discord/callback` を登録します。VPSのSSH接続先・サービス名・設定パスはgit管理対象外の `.local/deployment.json` を参照します。Botはリダイレクトを拒否するため、VPSの `/etc/hibana/bot.env` の `WEB_API_URL` も `https://api.bot.hsincode.com` に合わせます。APIの `WEB_PUBLIC_BASE_URL` / `FRONTEND_ORIGIN` と Webの `VITE_API_BASE_URL` / `VITE_SITE_URL` は上記カスタムドメインに合わせます。

## ドメイン移行の検証（2026-09-20）

新Webの `/` と新APIの `/healthz` は本番でHTTP 200、両プロジェクトの既定 `vercel.app` URLはパス・クエリを保持した308を確認しました。旧Webドメインも308です。旧APIドメインはCloudflare側のTLS失敗が残っており、通常のアクセスでは転送まで到達しません。デプロイ固有URLにはDeployment Protectionが先に適用され、未認証ではVercel認証へ転送されます。OAuth開始時の `redirect_uri` は新APIを指すことを確認しましたが、Discordで認証を完了する操作は未検証です。VPSの `WEB_API_URL` も新APIへ更新して再起動し、`Hibana ready`（`sandbox:true`）、`NRestarts=0`、VPSから認証付き `/internal/snapshot` のHTTP 200を確認しました。

## ESP32自宅回線のブラウザ中継（2026-09-20）

ESP32-S3（Flash 8 MB / PSRAM 8 MB）を自宅回線のブラウザ中継に使用します。
常時接続方式を廃止し、通常は切断状態です。管理者の親タスクにだけ
`home_vpn_status`、`home_vpn_connect`、`home_vpn_disconnect` を提供し、
サイトが通常経路を拒否した場合に接続します。設定値の存在やサービスの
起動だけでは接続しません。

接続ごとに短命な認証情報を発行し、作業完了・エラー・キャンセル・ブラウザ終了・
15分間の未操作で接続を解除します。所有タスクのブラウザ・yt-dlp・bash HTTP
がある限り最長時間の上限はありません。状態確認やページのバックグラウンド通信は
有効期限を延長しません。切断時は既存ソケットと
VPSのTCP 18443待受を閉じます。ESP32はWi-Fiには接続したまま約10秒間隔で
待受を確認しますが、切断中はVPSとの常設トンネルを保持しません。
別のタスクやサブエージェントへの接続の継承は拒否します。

`hibana-home-egress.service` はホスト専用Unixソケット
`/run/hibana-home-egress/control.sock`（0600、親ディレクトリ0700）で制御します。
ブラウザ用プロキシはDocker bridge上の18118で待受し、切断中や古い認証情報での
接続を拒否します。制御ソケットはブラウザコンテナへ公開しません。
`BROWSER_PROXY_URL` と `BROWSER_PROXY_USERNAME` は本番botのツールを有効にする
設定で、古い固定パスワードは使用しません。秘密鍵はGit管理外の環境ファイルで
管理し、CA秘密鍵はVPSへ配置していません。

初回実機検証では出口IPv4が自宅回線と一致し、にじげんカノジョ案内ページを
国外制限なしで表示、画像8件を取得しました。ESP32のハードリセット後の復帰も
確認しています。本編プレイ・長時間運転・USB電源アダプターへの付け替えは
未検証です。元のESP32 Flash全体はPCのGit管理外ディレクトリに保存しています。

切り替え方式の本番検証では、実際の `Media.browserCommand` を使い、通常経路が
自宅IPを使用しないこと、接続ツールの実行後だけ自宅IPになることを確認しました。
手動切断・作業終了時の解除・未操作による自動切断も実機で確認しました。
検証後は切断状態に戻しています。`make test` / `make ci` は115テスト成功です。

本番コードと環境の初回バックアップは `/var/backups/hibana-home-egress/91a5d38/`、
切り替え前の環境は `/var/backups/hibana-home-egress/bot-before-on-demand.env` です。
古い常時接続設定をそのまま復元せず、無効化する場合は `BROWSER_PROXY_URL` を
削除してbotを再起動し、中継サービスを停止してください。
設定と検証手順は [home-egress](../devices/home-egress/README.md) を参照してください。

## 更新

botは `main` へのpush時に、botの動作に関わるパスが本番のコミットから変わっている場合だけ、GitHub Actionsからデプロイ中継サーバー経由で自動更新します。対象は `apps/bot/`・`apps/relay/` と共通の `packages/shared/`・`package.json`・`bun.lock` です（`scripts/deploy-changes.ts` の `BOT_PATHS`）。文書やAPI・Webだけの変更、テストのファイル（`*.test.ts`・`__tests__/`）だけの変更ではbotを再起動しません。比較の相手は直近のCI実行ではなく、relayの `/status` が返す稼働中のコミットです。relayに問い合わせできない場合や、稼働中のコミットが `main` の履歴にない場合はデプロイします。判断の経緯は [ADR-0001](adr/0001-deploy-bot-only-when-affected.md) にあります。構成とセットアップは [relay](relay.md) を参照してください。

APIとWebも `main` へのpush時、CIのチェック成功後にGitHub ActionsからVercel CLIでデプロイします。デプロイは3段階です。まず本番用のビルドを、ドメインを向けない状態で作ります（`vercel deploy --prod --skip-domain`）。次に `scripts/verify-deployment.ts` が、そのデプロイ固有のURLで起動とコミットを確かめます（APIは `/healthz` と `/version`、Webはページの `hibana-commit` とスクリプトの取得）。確認に通った場合だけ `vercel promote` で本番のドメインを切り替えます。確認に失敗すると実行は失敗し、本番は前の版のままです（[ADR-0005](adr/0005-verify-before-promote.md)）。デプロイ固有のURLにはDeployment Protectionがかかるため、各プロジェクトのProtection Bypass for Automationのsecretを、リポジトリのSecret `VERCEL_BYPASS_API`・`VERCEL_BYPASS_WEB` に登録します。`scripts/deploy-changes.ts` が直近で成功した `main` のCI実行のコミットとの差分を調べ、`apps/api/`・`apps/web/` と共通の `packages/shared/`・`package.json`・`bun.lock` に変更があるアプリだけを対象にします。前回のpushではなく成功した実行を基準にするため、キャンセルやデプロイ失敗で漏れた変更も次のpushで反映されます。基準が見つからない場合やforce pushの後は両方をデプロイします。順序はローカルと同じくAPIが先で、botとWebはAPIのデプロイ成功（または不要）後に進みます。Actionsの「Run workflow」（`workflow_dispatch`）で `main` を実行すると、変更に関係なく全体をデプロイします。

VercelのデプロイはリポジトリのSecret `VERCEL_TOKEN`（Vercelのアカウント設定で作成したトークン）があるときだけ実行し、未設定の間はスキップします。チームIDとプロジェクトIDは秘密情報ではないため `.github/workflows/ci.yml` に記載しています。Secretを設定した直後は、それ以前の成功した実行が基準になるため、一度 `workflow_dispatch` で全体をデプロイしてください。GitHubのVercel Appはこのリポジトリへの権限がなく、Vercel側のGit連携は使用していません。

配信の記録はGitHubのDeploymentsに残ります。配信のjobは `production-api`・`production-web`・`production-bot` のEnvironmentを指定していて、配信先・コミット・成否・実行のURLがリポジトリの「Deployments」とコミットの画面から辿れます（[ADR-0004](adr/0004-record-deployments.md)）。

デプロイ後は `notify` jobが `scripts/deploy-notify.sh` でDiscordのwebhookに報告します（失敗したデプロイも含みます）。報告内容は api / web / bot ごとの結果、基準コミットからのコミット一覧、Actions runと差分へのリンクです。送信者名は「Hibana」、アイコンは崩壊：スターレイルの火花です（StarRailRes の画像をコミット固定で参照し、リポジトリには含めません）。基準がない場合（`workflow_dispatch`・force push）は、HEADのコミットだけを「全体を再デプロイ」として載せます。webhook URLはリポジトリのSecret `DISCORD_DEPLOY_WEBHOOK` に置き、未設定の間は何も送りません。通知に失敗してもwarningを出すだけで、runは失敗させません。

手動でデプロイする場合:

```sh
make ci
(cd tools/vercel && bun install --frozen-lockfile)
tools/vercel/node_modules/.bin/vercel deploy --prod --yes --project hibana-api
tools/vercel/node_modules/.bin/vercel deploy --prod --yes --project hibana-web
```

この手動の手順は、確認を挟まずに本番のドメインを切り替えます。CIと同じ手順にする場合は `--skip-domain` を付けてデプロイし、表示されたURLを `VERCEL_BYPASS=... bun scripts/verify-deployment.ts <api|web> <URL> <コミット>` で確かめてから `vercel promote <URL>` を実行します（コミットは `--env HIBANA_COMMIT=...`、Webは `--build-env` で渡します）。

CIが使うactionはcommit SHAで、Vercel CLIは `tools/vercel/bun.lock` で固定しています。更新はDependabotのPRで行います（[ADR-0002](adr/0002-pin-actions-and-vercel-cli.md)）。

モノレポのルートから実行します。プロジェクト設定のRoot Directoryを変更しないでください。`VERCEL_TOKEN` に失効した値がある場合は削除し、CLIのログイン情報を使用してください。

Vercelの既定Bunはlockfile v2を読めなかったため、各 `vercel.json` でBun 1.4.2によるインストールを指定しています。共有パッケージはpostinstallでJavaScriptへビルドし、Vercel Functionsにも解決可能なexportsを使います。Vercelでは依存の配置をhoistedに固定しています。

VPSでは新コードを `/opt/hibana` に配置した後、`bun install --frozen-lockfile`、`systemctl restart hibana` を実行します。`journalctl -u hibana` の `Hibana ready`、`sandbox:true` と `systemctl show hibana -p NRestarts` を確認します。秘密情報やデータディレクトリはリポジトリから上書きしません。

## ロールバック

botのデプロイが失敗すると、relayがbotだけを前のコミットに戻します。APIとWebは戻しません。そのため、APIは1つ前の版のbot・Webと互換に保ち、DBのスキーマ変更は追加だけにします。規則と、項目や列を削るときの手順は [ADR-0006](adr/0006-roll-back-the-bot-alone.md) にあります。APIの契約の一覧は `apps/api/src/contract.json` で、項目を足したら `bun apps/api/src/contract.ts --write` で更新します。

以下は、TypeScript版への切り替え（2026-09-19）を旧実装へ戻す場合の手順です。

botを旧実装へ戻す場合は、まず `systemctl stop hibana`。新旧botを同じトークンで同時稼働させないでください。VPNコンテナが稼働していれば `docker rename hibana-vpn deepseeker-vpn` で旧名に戻し、`systemctl enable --now deepseeker`、`systemctl disable hibana` を実行します。旧APIはHTTP 402のため、旧botでもAPI接続を無効にするか正常なAPIを別途設定する必要があります。

新旧の状態ファイル・チェックポイントは異なる形式です。切り替え後の変更を旧データへ無条件に上書きしないでください。必要な設定はバックアップと比較して移してください。

## ブラウザとJevの操作ログ

`Browser operation started/finished` と `Browser command started/finished` は
`operation_id`、チャンネル、元メッセージIDで対応付けます。Jev経由の場合は
`jev_run_id` で `Jev plan started/finished`、`Jev action started/finished` と結び付きます。
既存のjournalと日次ログに残るため、正常応答後にチェックポイントが消えても調査できます。

- `command_timeout`: ブラウザコマンドの上限（既定60秒、最大120秒）。
- `plan_timeout`: Jev計画全体の120秒上限。判断待ちや操作時間も含みます。
- `parent_abort`: 親処理からの中断。Jev経由では計画ログの終了理由と照合します。
- `signal` / `process_error` / `exit`: プロセスのシグナル終了、起動等のエラー、通常の終了。
  終了コードも合わせて確認してください。`exit` は操作成功を保証しません。

`queue_ms`、`elapsed_ms`、`remaining_ms` / `jev_remaining_ms` と処理段階を記録します。
`output_reports_timeout` はCLI出力に既知のタイムアウト表現が含まれたかを示す補助情報で、
原因の確定値ではありません。引数、URL、スクリプト、ページ内容、標準出力・標準エラー、
モデルの説明文は保存しません。そのためページ内のどの要素待ちで失敗したかまでは
このログだけでは特定できません。過去の操作ログを復元する変更ではありません。

## Ultra と Jev の併用（2026-09-21）

この節の Ultra は、Claude Code の Ultracode に置き換える前の Codex 由来のモードです。現在の仕組みは [Ultra（Claude Code の Ultracode）](ultracode.md) を参照してください。

Ultra のモード指示を HsinCLI fork の `multi_agent_mode_instructions.rs` と一致させ、
Jev への指示を分離しました。エージェントの起動・連絡・待機は直接行い、親自身の
操作だけを Jev の計画へ渡します。子の開始通知は親の進捗更新後も残ります。
`Agent collaboration started/finished` はツール名・深さ・Ultra の状態・所要時間を、
`Jev decision finished` は候補数・判断待ち時間を記録し、本文や操作引数は保存しません。

同じ本番設定で、ツール定義の JSON は133,154文字から77,807文字、別の設定では
135,050文字から78,783文字へ減りました。Jev の説明へ直接公開済みのツール定義を
重複添付していた分を除いています。文字数の比較であり、実応答時間や品質の改善率を
測った値ではありません。Ultra・Jev 判定・Jev 行動選択の8通りを全カタログモデルで
検証し、モデルの切り替え・effort・権限・独立した認証情報を保ちます。

`(40回目)` などの通知は進捗更新の通算で、API 呼び出し数や失敗数ではありません。
22:32:17 JST の計画中断はデプロイ時の再起動による `parent_abort` でした。
同じタスクはチェックポイントから再開し、22:35のシェル `SyntaxError` 後も
再計画して22:36の操作は成功しました。再計画は画像の親レビューでも起こるため、
表示だけで操作失敗とは判断できません。

Exa は本番で専用キー未設定のため公開 MCP を使用しており、無料枠の上限通知を
確認しました。この通知は `isError:false` で返るため、検索結果として後続操作へ
進まないよう失敗に分類します。利用上限の解消には bot の `EXA_API_KEY` 設定か
別の取得経路が必要です。Jev・チャット用のキーを流用しません。

`make ci` は243テスト・型チェック・ビルドに成功しました。模擬 provider での
Ultra＋Jev の同時実行に加え、本番でも通常サブエージェントの起動成功をログで確認しました。
全モデルの実 API による比較試験や、生成するコード・ツール引数の正確性の保証は含みません。

同じ調査の後段では22:49・22:50・22:54 JST に DeepSeek の HTTP 402 が発生して
応答が停止しました。[DeepSeek の公式説明](https://api-docs.deepseek.com/quick_start/error_codes)
では残高不足です。再開には対象アカウントの残高確認・補充、またはユーザーによる
モデル変更が必要です。失敗後もチェックポイントは残るため、ファイルの存在だけでは
実行中とは判定できません。追加の Exa 判定修正は、この失敗による停止をログで確認し、
新しい作業によるチェックポイント更新がないことを確認してから反映しました。

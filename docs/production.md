# 本番環境

2026-09-19にTypeScript版Hibanaへ切り替えました。

| 対象 | 配置 |
| --- | --- |
| Web | https://bot.hsincode.com （Vercel `hsincode/hibana-web`、Root Directory `apps/web`。既定URLは https://hibana-web-mu.vercel.app） |
| API | https://api.bot.hsincode.com （Vercel `hsincode/hibana-api`、Root Directory `apps/api`。既定URLは https://hibana-api.vercel.app） |
| bot | 既存VPSの `/opt/hibana`、`hibana.service` |
| bot設定 | `/etc/hibana/bot.env` |
| botデータ | `/var/lib/hibana` |
| botの会話履歴・Auto Routing の経路 | `/var/lib/hibana/conversations.db`（SQLite。[ADR-0008](adr/0008-keep-conversations-across-restarts.md)） |
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

Vercelの既定Bunはlockfile v2を読めなかったため、各 `vercel.json` でBun 1.4.3によるインストールを指定しています。共有パッケージはpostinstallでJavaScriptへビルドし、Vercel Functionsにも解決可能なexportsを使います。Vercelでは依存の配置をhoistedに固定しています。

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

## botとAPIの設定同期（2026-10-08）

botは30秒ごとに `GET /internal/snapshot` を `If-None-Match` 付きで呼び、変更がなければ304を受け取ります（`apps/bot/src/sync.ts` の `SNAPSHOT_POLL_MS`）。ダッシュボードでの変更がbotに届くまで、最大で30秒かかります。

以前は `/internal/events`（SSE）へ常時接続していました。Vercelは応答が開いている間、関数のインスタンスのメモリに課金するため、Hobbyの上限を超えてAPIとWebが停止しました（[#27](https://github.com/hsincode/hibana/issues/27)）。APIの `/internal/events` は、SSEを使う版のbotへ切り戻せるように残しています。

APIに届かない間、botは待ち時間を倍にしながら再試行します（最長5分）。起動時にAPIへ届かなくても、`runtime_state.json` に保存済みのスナップショットがあれば、その内容で起動します。保存済みのスナップショットがない初回の起動では、利用停止リストとロールを取得できないため、これまでどおり起動しません。

スキルのカタログと公開サイトの一覧は、APIが前回受け取った内容から変わったときだけ送ります。botを再起動すると、一度送り直します。

検証は手元のテスト（`apps/bot/src/__tests__/sync.test.ts`）までです。本番でのVercelの使用量は、配信後にUsage画面で確かめる必要があります。

## 利用料ページ（2026-10-09）

Webの `/analytics` は、APIの `GET /api/analytics/cost` を通して Anthropic の Admin API の cost report（`GET /v1/organizations/cost_report`）を表示します（[#48](https://github.com/hsincode/hibana/issues/48)）。見られるのは administrator（`WEB_ADMIN_IDS`）だけです。

APIのVercelプロジェクト（`hibana-api`）の環境変数に `ANTHROPIC_ADMIN_API_KEY` を設定します。botが使う `ANTHROPIC_API_KEY`（Anthropic Console の workspace に属するキー。プロバイダー「Anthropic Workspace」とは別の話です）とは別のもので、使えるのは次のどちらかです（[公式ドキュメント](https://platform.claude.com/docs/en/manage-claude/admin-api)）。

- Admin API キー（`sk-ant-admin...`）。組織の admin ロールのメンバーだけが Claude Console で作成できます
- workspace に紐づかない個人キー（`sk-ant-usr-...`）。権限はキーを発行したアカウントと同じです。アカウントに権限がないと、cost report は403（`permission_error`）を返し、ページにその旨が表示されます

どちらも1つの workspace を超えて使えるキーなので、APIの環境変数以外には置きません。未設定の間、ページには「未設定」と表示されます。

Admin API は個人アカウントでは使えません。Console の組織が Individual Org の間は、設定に Admin keys の項目が出ず、個人キーで cost report を呼んでも403になります。「組織」のページでチーム組織に変換すると、Admin keys でキーを作成できます（2026-10-09に、この手順で作成したキーで取得できました）。

- 日付は UTC 区切りです（cost report が UTC の日単位でしか返さないため）。日本時間では 9:00 に切り替わります
- 載るのは終わった日（UTC）までです。cost report は進行中の日の行を返さないため、当日ぶんは次の 9:00（日本時間）を過ぎてから表示されます。「今月の残り」も、前日までの確定分で計算した値です
- 月の1日目（UTC）は、終わった日がないため Anthropic へ問い合わせず、空の月を表示します。範囲に終わった日がない問い合わせに、cost report は400を返すためです
- 月の予算 $200 は `apps/api/src/analytics.ts` の `MONTHLY_BUDGET_USD` です。1日の目安はこれをその月の日数で割った額です
- APIは同じ月の結果を、インスタンスごとに1分間メモリに保持します。Anthropic が継続的な取得を1分に1回までとしているためです
- Priority Tier の費用は cost report に含まれません

検証の範囲（2026-10-09）:

- 手元のテスト（`apps/api/src/analytics.test.ts`、`apps/web/tests/analytics.spec.ts`）。上の2点（当日の行が返らない・1日目の400）は、実際の応答に合わせた代用の応答で再現しています
- Admin API キーで実際の cost report を手元から呼び、応答の形（`data`・`has_more`・`next_page`、`amount` はセントの文字列、通貨は USD）が公式ドキュメントのとおりであること、APIのルートを通した結果を画面に描画できることを確かめました
- Individual Org の個人キーでは403（`permission_error: Missing permissions`）でした（同じキーで `GET /v1/organizations/me` は200）
- 未確認: Console の Cost の表示との照合、本番（Vercel）での動作、日付が変わってから前日の行が載るまでの時間

## 会話履歴と Auto Routing の経路の保存（2026-10-10）

bot は、会話履歴と Auto Routing の経路を `/var/lib/hibana/conversations.db`（SQLite）に保存します（[#59](https://github.com/hsincode/hibana/issues/59)、[ADR-0008](adr/0008-keep-conversations-across-restarts.md)）。デプロイなどで bot が再起動しても、会話は続きから始まり、Auto Routing のチャンネルは同じモデルと effort を使います。以前はどちらもプロセスのメモリにしかなく、再起動のたびに消えていました。

- 起動すると、ログに `Conversation store opened` と、保存済みのチャンネル数・ターン数・経路数が出ます。この行が無く `Hibana operation failed` が出ている場合は、ファイルを開けておらず、メモリだけで動いています（会話は再起動で消えます）
- 保存した会話が消えるのは、`/clear`、チャンネルやスレッドの削除、モデルの変更、guild の設定変更、スレッドの期限切れです。通常のチャンネルに期限はありません
- 会話の本文（ツールの結果を含む）がこのファイルに残ります。モードは 0600 です。バックアップは取っていません
- すべて消すには、bot を止めて `conversations.db`・`conversations.db-wal`・`conversations.db-shm` を削除します。保存をやめるには、`/etc/hibana/bot.env` に `CONVERSATION_DB_PATH=`（空）を書いて再起動します
- 中身は `sqlite3 /var/lib/hibana/conversations.db` で見られます（表は `history_channels`・`history_turns`・`routes`。Anthropic Workspace を入れた版からは `workspace_sessions`・`workspace_disposals` も。この 2 つの表に後から足した列 `lease_settled`・`allowed_cents` は、列の無いファイルを開いたときに bot が `ALTER TABLE … ADD COLUMN` で足します）
- bot を前の版に切り戻している間、前の版はこのファイルを使いません。その間の会話は保存されず、新しい版に戻ると、切り戻す前の履歴の続きになります

検証は手元のテスト（`apps/bot/src/__tests__/conversation-store.test.ts`、`sync.test.ts`）までです。本番での動作、実際の会話でのファイルの大きさ、キャッシュのヒット率の変化は、配信後に確かめる必要があります。

## Anthropic Workspace（2026-10-12）

プロバイダー「Anthropic Workspace」（`anthropic_workspace`）のターンは、Claude Managed Agents のセッションで動きます（[#76](https://github.com/hsincode/hibana/issues/76)、[ADR-0011](adr/0011-add-anthropic-workspace-provider.md)、[Anthropic Workspace の説明](anthropic-workspace.md)）。作業領域は VPS の Docker ではなく、Anthropic のクラウドのコンテナです。**実際の API では、手元から、Haiku 5.5 のセッションで確かめただけです**（2026-10-12。`main` に載せ替える前のコードで、Ultra なしの全項目と、Haiku Ultra の bot 自身のターン 1 回。この節の最後）。本番では、鍵を置いてプリセットを公開するまで、誰も選べません。この節の手順と値は AI の案で、本人未確認です。

### 使えるようにするまで

プリセットが非公開か、鍵が無い間は、配信しても誰も新しく選べません。

1. （勧め）Anthropic Console に、Workspace 専用の workspace を作り、その spend limit を設定します。bot が壊れても効く歯止めになります。Files API のファイルは同じ workspace のどの鍵からも読めるので、`ANTHROPIC_API_KEY` と同じ workspace に置くと、ファイルが分かれません（[spend limit](https://platform.claude.com/docs/en/api/rate-limits)、[Files API](https://platform.claude.com/docs/en/build-with-claude/files)。workspace の spend limit がセッションの稼働時間の料金にも効くかは未確認です）
2. その workspace の API キーを、`/etc/hibana/bot.env` に `ANTHROPIC_WORKSPACE_API_KEY=` として置き、`systemctl restart hibana` します。`ANTHROPIC_API_KEY` は代わりになりません
3. 対応した版の bot が動いていることを確かめてから、Web の `/models` で 3 つのプリセット（Anthropic Workspace / Claude Haiku 5.5・Sonnet 5.5・Opus 5.5）を公開します

- エージェント 2 つと environment 1 つは、最初のターンで作り、ID を `/var/lib/hibana/anthropic_workspace_resources.json` に保存します。起動時には作りません
- 設定 API を使わない bot（`WEB_API_URL` なし）には、手順 3 の公開の手段がありません。その構成では、3 つのプリセットは常に非公開・Premium 以上として扱われ、`runtime_state.json` を手で書き換えて公開しても、起動のたびに非公開へ戻ります（Web の構成で公開済みだった bot を、`WEB_API_URL` なしに切り替えた場合も同じです）。Workspace を使えるのは、`PROVIDER=anthropic_workspace` を bot の既定にしたときだけです。本番の構成（`WEB_API_URL` あり）は変わりません
- 公開する前でも、`/usage` と `/switch` の `ultra` の説明文には「Workspace」の語が出ます（スラッシュコマンドの説明は全員に見えます）

### 環境変数

既定値と範囲は AI の案で、本人未確認です（#76）。範囲の外の値は、起動時にエラーになります。

| 変数 | 既定 | 中身 |
|---|---|---|
| `ANTHROPIC_WORKSPACE_API_KEY` | なし | 鍵。無ければ、Workspace のターンは認証エラーになる |
| `ANTHROPIC_WORKSPACE_BASE_URL` | `https://api.anthropic.com` | 接続先。末尾の `/v1` は付けても付けなくてもよい |
| `ANTHROPIC_WORKSPACE_TURN_BUDGET_USD` | 1 | 1 ターンがセッションに足せる額（USD。0.05〜100） |
| `ANTHROPIC_WORKSPACE_ULTRA_TURN_BUDGET_USD` | 3 | 同、Haiku Ultra のターン（0.05〜100） |
| `ANTHROPIC_WORKSPACE_DAILY_BUDGET_USD` | 5 | bot 全体の 1 日の額（UTC。0.01〜10000） |
| `ANTHROPIC_WORKSPACE_MONTHLY_BUDGET_USD` | 50 | bot 全体の月の額（UTC。0.01〜100000） |
| `ANTHROPIC_WORKSPACE_TURN_TIMEOUT_MS` | 1200000 | 1 ターンの時間（20 分） |
| `ANTHROPIC_WORKSPACE_ULTRA_TURN_TIMEOUT_MS` | 3600000 | 同、Haiku Ultra のターン（60 分） |
| `ANTHROPIC_WORKSPACE_MAX_CONCURRENT` | 2 | bot 全体で同時に動く Workspace のターン（1〜64） |
| `ANTHROPIC_WORKSPACE_INPUT_MAX_CHARS` | 60000 | 1 回の発言の長さ。いちばん新しい発言 1 件が超えると断る。まだ送っていない発言と合わせて超えるときは、新しいものから収まるだけを送る（下の「データとログ」の再開の項） |
| `ANTHROPIC_WORKSPACE_NETWORKING` | `unrestricted` | コンテナのネットワーク。`limited` にすると、下の一覧とパッケージの配布元だけになる |
| `ANTHROPIC_WORKSPACE_ALLOWED_HOSTS` | 空 | `limited` のときに許すホスト名（カンマ区切り。スキーム・ポート・パスは書かない）。`limited` 以外で指定すると起動時にエラー |
| `ANTHROPIC_WORKSPACE_WEB_ENABLED` | `true` | コンテナの web 検索と web 取得 |

- 金額は、セッションが報告する list cost（公開単価での額）で数えます。請求額とは一致しないことがあります
- 1 ターンの 2 つの上限は、0.05 未満にできません（枠が 5 セント未満のターンは始めないため）。**`bot.env` に 0.05 未満の値があると、bot は起動時のエラーで止まります。** 配信の前に確かめてください（実際の `bot.env` の値は、AI は確かめていません）。1 日と月の上限は 0.01 まで下げられます
- 1 日と月の上限の判定は、報告された額より多めに数えます。セッションを 1 つ作るたびに 1 セントと、トークンや稼働秒数などの使用量が増えたのに額が報告されなかった区間の、渡していた枠の全額を、判定にだけ足します（報告は 1 セント単位の四捨五入で、短いセッションは 0 と報告されるため）。`/usage` に出る額は変わりません。`/usage` の額が上限より少ないのに「上限に達している」と断られるときは、この分か、実行中のターンに渡している枠の分です
  - 枠を足すのは、「使用量の報告があるのに、額の報告が無い」区間だけで、1 つの枠につき 1 回です。その使用量を最初に読んだ処理（ターンの精算、ターンの後の掃除、会話が終わった後の片付けのどれか）が足します。足し終えた枠は、実行中のターンに渡している枠（予約）としては、もう引きません
  - 使用量の報告がまったく無かったターンには、枠を足しません（何も使っていないものとして扱います）。発言が取り上げられる前に、`/clear` された、同じ人が言い直した、時間切れになった、というターンです。そのセッションが後から使用量（額なし）を報告したときは、次の掃除（60 秒ごと）か、その前の片付けが読んで、枠を 1 回足します。掃除が 1 回読んだ後で初めて出た使用量には、足しません
  - `/usage` の「額の報告が無かったターン」の件数には、使用量の報告が無かったターンも入ります。掃除や片付けが、額の無い使用量を記録したときも 1 増えます（判定に足したかどうかも、ターンの数も、この件数からは分かりません）
- 「プロバイダとの通信を再試行しましたが、応答を完了できませんでした。（送信時・list_cost_missing）」で失敗するターンは、セッションが、使用済みなのに額（list cost）を報告していないものです（トークンや稼働秒数の報告がある、bot が以前に使用量を数えている、処理済みの発言がある、のどれか）。上限を「使った額 + 枠」で置けないので、発言を送る前に止めています。取り上げ前の発言がキューにあるだけのセッションは、これに当たりません（`docs/anthropic-workspace.md` の「上限と費用」）。処理済みの発言があるかは、発言の一覧を、見つかるか尽きるまで読んで確かめます（額も使用量も報告しておらず、bot が使用量を数えたこともないセッションだけ。取り上げ前の発言だけが何ページも並ぶと、その分、ターンの開始前のリクエストが増えます）。10,000 件読んでも決まらないセッションも、この失敗になります
- ネットワークと web の設定は、**新しく作るセッションにだけ**効きます。既にあるセッションは、作ったときの設定のままです。ネットワークを変えると、新しい environment が作られます
- `limited` にするときは、Discord の CDN（`cdn.discordapp.com`・`media.discordapp.net`）を一覧に入れないと、添付を取得できません。web 検索と web 取得も、同じ一覧で絞られます
- `WORKFLOWS_ENABLED`・`SUBAGENT_ENABLED`・`TOOLS_ENABLED` のどれかを `false` にすると、Haiku Ultra は働きません（委譲なしのセッションになります）
- bot の環境に `ANTHROPIC_CUSTOM_HEADERS` を置くと、公式 SDK がそれを読み、Workspace のリクエストにもヘッダーが付きます。鍵（`x-api-key`）と `Authorization` は、この変数に書いてあっても置き換わりません（Workspace の鍵のまま送り、`Authorization` は送りません。同じ名前を、大文字と小文字を変えて何回書いても同じです。送信の直前に固定しています）。それ以外のヘッダーは、そのまま付きます。Workspace に送りたくないヘッダーがあるなら、この変数を置かないでください
  - Workspace のリクエストがすべて送信前に失敗する書き方が、確かめた範囲で 1 つあります。`X-Api-Key: …` と `Authorization: …` を書いたうえで、その両方を、別の綴りの値なしの行（`x-api-key:`、`authorization:`）でもう一度書いた場合です。鍵は送られません（`docs/anthropic-workspace.md` の「限界」）

### データとログ

- `/var/lib/hibana/anthropic_workspace_usage.json`: 利用額の台帳（日 × モデル。約 400 日分）。1 日と月の上限は、これで判定します。判定にだけ足す額は、`limit_extra_cents` という項目に入ります（この項目の無い台帳は、0 として読みます）
  - **読めないとき（ファイルが壊れているなど）は、Workspace のターンを、新しい発言も再開（`/retry`、起動時の自動の再開）も断ります**（「利用額の記録を読み込めていないため、実行しませんでした」）
  - 読めない間、残ったセッションの片付けは、budget を下げるだけになります。額の記録、渡した枠の返却、セッションの delete / archive は進みません。台帳を直して（または消して）再起動すると、その起動の最初の片付けが、残りを数えて進めます
- `/var/lib/hibana/anthropic_workspace_resources.json`: エージェントと environment の ID。消しても、同じ名前のものを Anthropic 側から探して使います
- `conversations.db` の `workspace_sessions`（チャンネルとセッションの対応）と `workspace_disposals`（片付け待ち）。会話の本文は入りません。`workspace_sessions` の `lease_ceiling_cents` が入っている行は、ターンに渡した枠（lease）が残っているセッションです。`lease_settled` が空なら、ターンが実行中か、budget が上がったまま終わっていて、次の掃除（60 秒ごと）が下げるものです。`counted` は、budget は上がったままで、枠を判定用の額に数え終えたもの。`lowered` は、budget を下げ終えていて、使用量が後から出ていないかを次の掃除がもう一度読むものです。`workspace_disposals` の `allowed_cents` は、片付けに回った時点でまだ数えていなかった枠です（`docs/anthropic-workspace.md` の「上限と費用」）。`CONVERSATION_DB_PATH=`（空）で保存をやめている bot は、停止のときにセッションの archive を 3 秒だけ試みます。その bot がターンの途中で落ちると（クラッシュなど）、セッションを覚えているのはチェックポイントだけになります。次の起動は、そのターンを 1 回だけ、新しいセッションで再開し、前のセッションを止めて archive します（ログに `Workspace session of an unfinished turn is in no row; it is stopped and all it has used is counted`。そのセッションの累計の全額を台帳に足すので、二重に数えることがあります）
- ログで見るもの（発言やコマンドの本文は入りません）:
  - `Workspace session created`（`variant` が `plain` か `ultra`、`model`、`effort`）
  - `Workspace turn finished`（`stop` が `end_turn`・`interrupted`・`timeout`・`budget`・`stopped` のどれか、`list_cost_cents`、`cost_reported`、`runs_started`、`open_runs`、`released`）。`released` が偽のターンは、budget を下げられずに終わっています。次の掃除（60 秒ごと）が下げます。`released` が真でも、使用量も額も見えないまま終わったターンは、次の掃除がセッションをもう一度読みます（セッションの GET が 1 回。`running` か `rescheduling` と読めたときだけ interrupt も送ります。読めたら、その掃除で lease を外します）
  - `Workspace session keeps an older tool list`: ツールの一覧が、そのセッションを作ったときから変わっている
  - `Workspace session removed` と、失敗時の `Workspace session could not be removed`（5 回失敗すると、次の起動まで試しません。workflow run が開いたままのセッションは、delete / archive が 400 で拒否されることがあります。下の `/clear` の項）
  - 警告: `workspace budget could not be lowered`、`workspace budget was not lowered: every value was rejected`、`workspace session has more than one workflow run open`、`workspace session multiagent differs from its variant`、`workspace tool result was not accepted`（Hibana のツールの結果を、セッションが受け取らなかった。届かなかった結果は送り直します）
- `/usage`（owner のみ）に、従来の推計とは別の行で出ます。`/context` には `workspace`（`variant`、`created_at`、`container_until`）が出ます。`container_until` は作成から 30 日後で、その後はコンテナの中身が失われます
- `/clear` は、会話に加えて、クラウドのセッションと作業ファイルも削除します。**Haiku Ultra で workflow run が開いたまま残っているセッションは、削除（モデルの変更では archive）が 400 で拒否されることがあります**（公開文書の記述。実 API では未確認）。その間は、会話と作業ファイルが Anthropic 側に残ります。`/clear` の返信は「削除を始めました」のままです。片付けは 60 秒ごとに 5 回試し、その後は次の bot の起動まで試しません。止まった run は、寿命（既定 24 時間）が過ぎるまで自分では終わりません
- bot がサーバーから外されても（kick）、そのサーバーのセッションは片付けません。`workspace_sessions` の行と、Anthropic 側の会話・作業ファイルは残ります
- 同じチャンネルのターンは、発言した人によらず 1 つずつ順に動きます（ほかのプロバイダーのターンと同じ、チャンネルごとのキュー）。待っている発言に、待ちの表示は出ません
- 起動すると、Discord のコマンド登録より前に、前のプロセスが残したセッションの片付け（interrupt と budget の引き下げ）を始めます。コマンド登録やサーバーごとの初期化が失敗しても、片付けは走ります
- 再起動で中断したターンは、起動後に 1 回だけ自動で再開します。もう一度止まったら、利用者の `/retry` を待ちます
  - 再開も、台帳と 1 日・月の上限で確かめます。断られたときは、チャンネルに定型文（上限に達している、または記録を読み込めていない）が出て、チェックポイントは消えます（続けるには、新しい発言が要ります）
  - 再開の前に、セッションに最後に送られた発言が、チェックポイントのものと同じかを確かめます（1 リクエスト）。同じチャンネルで別の人の発言が間に入っていたら、「続けて」ではなく、本人の発言を新しい発言として送り直します。そのターンは、新しい枠と新しい時間の上限で動きます（起動時の自動の再開では、最大 2 時間前の依頼が走ります）
  - チェックポイントに、セッションへまだ送っていない発言が残っていることがあります（発言が受理された後で失敗し、次の発言のターンが、送る前に失敗した場合）。チェックポイントは、何件目までが済んだか（セッションが受け取った、または長さのために送らなかった）を覚えていて（`ctx.workspaceMark.sent`。この項目の無いチェックポイントは、今までどおりに読みます）、`/retry` と起動時の自動の再開は、「続けて」の代わりに、まだ送っていない発言を新しい発言として送ります。次の発言があれば、その前に付けて 1 つの発言にします。どちらも新しい枠と新しい時間の上限で動き、断られると（いちばん新しい 1 件が長すぎる、上限、台帳）、チェックポイントごと消えます
  - 1 つにまとめると `ANTHROPIC_WORKSPACE_INPUT_MAX_CHARS` を超えるときは、新しいものから順に、収まるだけを送ります（いちばん新しい 1 件は必ず送ります）。送らなかった件数は、返信の後ろに「最後のメッセージより前の N 件は、合わせると Anthropic Workspace に送れる M 文字を超えるため、送っていません。必要であれば、もう一度送ってください。」と付きます。送らなかった発言を、後から自動で送り直すことはしません。発言を送った後でそのターンが失敗したときは、この 1 行は出ません（`docs/anthropic-workspace.md` の「限界」）
- budget の定型文（「このターンの費用の上限…」）で止まった後の次の発言では、止まっていた前の作業を止めてから、その発言を始めます。前の作業の続きは捨てます（`docs/anthropic-workspace.md` の「ターンの流れ」）
- 本文なしでターンが終わり、チャンネルに何も届いていないときは、「返信の本文がないまま、このターンが終わりました。必要であれば、もう一度メッセージを送ってください。」と返します（費用は数えます）

### 止め方

- **`/models` でプリセットを非公開に戻しても、既に選んでいるサーバーは動き続けます。** 新しく選べなくなるだけです
- 全部を止めるには、`bot.env` から `ANTHROPIC_WORKSPACE_API_KEY` を消して再起動します。Workspace を選んでいるサーバーのターンは、すべて認証エラーになります（ほかのモデルには切り替わりません）。片付け待ちのセッションの削除も、鍵を戻すまで進みません
- サーバーごとに止めるには、`/switch` かダッシュボードでモデルを替えます。そのサーバーのセッションは archive されます
- `ANTHROPIC_WORKSPACE_DAILY_BUDGET_USD=0.01` にして再起動すると、新しいターンは「1 日の利用額の上限」の定型文で断られます。その再起動で中断したターンの再開も、枠を残していれば断られます（コードの読み取りから。この値での動作はテストしていません）
- Console の側では、専用の workspace の spend limit を下げるか、鍵を無効にします

### 切り戻し

bot を前の版に戻している間（relay の自動の切り戻しを含む）:

- 新しい 2 つの表と 2 つのファイルは、前の版には使われないだけで、そのまま残ります（表については、前の版の `conversation-store.ts` と `history.ts` を取り出して、新しい版が書いたファイルに対して手元で動かして確かめました。前の版の bot 全体は動かしていません。この確認は、2 つの表に列を 1 つずつ足す前のファイルで行ったもので、列が増えても同じ、というのは、前の版がこの 2 つの表を読み書きしないことによります。2 つのファイルは、前の版のコードに読み書きする箇所が無いことによります）
- 前の版は `anthropic_workspace` を知りません。Workspace を選んでいるサーバーのターンは失敗する見込みで、進行中だった Workspace のチェックポイントを、ほかのプロバイダーのものとして扱うことがあります（前の版のコードの読み取りによる。未検証）。切り戻す前に、Workspace を選んでいるサーバーのモデルを替えておくのが安全です
- その間の `/clear` やチャンネルの削除は、クラウドのセッションに届きません。新しい版に戻すと、消したはずの会話と作業ファイルが続きます。確実に消すには、新しい版に戻してからもう一度 `/clear` します
- 停止のときに budget を下げられなかったセッションは、新しい版が戻るまで、上げた budget のまま残ります（使えるのはその budget まで）

検証は、手元のテスト（`apps/bot/src/__tests__/workspace-*.test.ts`。Anthropic の応答はすべて偽のもの）と、手元からの実 API での確認（2026-10-12 の 4 回の実行。`main` に載せ替える前のコードで行ったもので、載せ替えた後のコードは実 API に当てていません）です。**実 API では、2026-10-12 に、Haiku 5.5・effort medium のセッションで、手動のスクリプト（`cd apps/bot && bun run workspace-smoke`）と bot 自身のターン（Discord は偽）が通りました。Haiku Ultra は、bot 自身のターン 1 回（workflow run が 1 つ始まって終わる）が通りました**（AI が実行。持ち主は再実行していません。`docs/anthropic-workspace.md` の「実 API での確認」）。スクリプトは課金されるので、次に流すときも、そのつど持ち主の承認が要ります。未確認: Haiku Ultra のうち、budget で止まった run の扱い・ターンをまたぐ run・run が開いたセッションの片付け、Sonnet 5.5・Opus 5.5、実際の Discord を通したターン、実際の費用（請求額）、切り戻しの挙動、本番での動作。

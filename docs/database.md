# 設定 API の DB

設定 API（`apps/api`）の DB は Postgres です。本番は Supabase の Free プラン（東京リージョン）で、API の関数も東京（Vercel の `hnd1`）で動かします（判断記録 #93、[ADR-0012](adr/0012-move-api-database-to-supabase.md)）。`DATABASE_URL` を空にすると、メモリストアで動きます（ローカルの開発とテスト用）。

## 接続の仕様

- ドライバは Bun に組み込みの `SQL`（`apps/api/src/store.ts` の `PostgresStore`）。普通の TCP 接続なので、Neon に限らず、どの Postgres にもつながります
- 接続プールは API のインスタンスごとに 1 つで、最大 5 本です。使っていない接続は 5 秒で閉じます。Vercel は、Fluid compute のプールのアイドルタイムアウトを短くするよう勧めています
- `prepare: false` にしています。Supabase のプーラー（Supavisor）の transaction モード（ポート 6543）は、トランザクションごとに別のサーバー接続へ渡すので、名前つきの prepared statement を使えないためです
- `DATABASE_URL` のホストが手元（`localhost`・`127.0.0.1`）でなければ、`sslmode=require`・`verify-ca`・`verify-full` のどれかが必要です。無いと、API は起動時に止まります（Bun は `sslmode` が無いと TLS を使わず、パスワードが平文で流れるため）。エラー文に URL は出しません
- `sslmode=require` は暗号化するだけで、証明書を検証しません（Bun のドキュメントの表のとおり）。Supabase の CA 証明書で検証する `verify-full` は、まだ設定していません
- Supabase の Data API は、`public` スキーマのテーブルを、プロジェクトの公開鍵（anon / publishable）で REST から読めるようにする。Hibana は Data API を使わないので、ダッシュボードで公開を止める（手順 2）。加えて、API は起動時に、作ったテーブルすべてで RLS（row level security）を有効にする。ポリシーは作らないので、持ち主以外のロールには行が見えない。API はテーブルの持ち主として接続するので、RLS の影響を受けない（#93）
- Vercel は、アイドルのインスタンスを、タイマーを動かさずに休止させます。その間にサーバー側が接続を閉じると、起きた直後の最初のクエリが、閉じた接続に当たって失敗します。Bun 1.4.3 と Postgres 17 で測ると、FATAL の 57P01 と、`ERR_POSTGRES_CONNECTION_CLOSED` が続けて返り、どちらもクエリがサーバーに届く前に失敗していました。そこで、この 2 種類のエラーのときだけ、プールを作り直して、同じクエリを最大 3 回まで実行します。ほかのエラー（SQL の誤り、認証の失敗、接続のタイムアウト）はリトライしません
  - 残るリスク: クエリを送った後に接続が切れた場合も `ERR_POSTGRES_CONNECTION_CLOSED` になりうるので、その書き込みは 2 回実行されることがあります（ログの 1 行やコマンドの 1 件が重複する程度）。この場合は手元では再現していません

## Neon から Supabase への移行手順

Neon は無料枠を使い切って、HTTP 402 で読み出せません（#92）。そこで、bot が VPS に持っている snapshot から復元します（#93）。

### 復元されるもの・されないもの

`scripts/import-bot-snapshot.ts` が戻すのは、snapshot にあるものだけです。

| 戻る                                                                                                                                         | 戻らない                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| サーバー設定、DM のユーザーコンテキスト、個人設定、ロール、利用停止（ID だけ）、プリセットの公開・Premium の設定、予算フォールバックのモデル | セッション（全員の再ログインが必要）、ユーザー名とアバター（次のログインで入る）、利用停止の理由、ChatGPT アカウントの接続（やり直しが必要）、ログ、公開サイトとスキルの一覧、bot が使えるプリセットの一覧 |

最後の 3 つ（公開サイト、スキル、使えるプリセット）は、bot が起動したときに API へ送ります。そのため、切り替えた後に bot の再起動が要ります。snapshot の最終更新（2026-10-17 17:54）より後にダッシュボードで変えた内容は、Neon が止まっていたので、どこにも保存されていません。

### 手順

1. Supabase でプロジェクトを作る。リージョンは Northeast Asia (Tokyo)。作った後には変えられない
2. Integrations → Data API → Settings で、「Automatically expose new tables」をオフにし、Exposed schemas から `public` を外す
3. Supabase の Connect 画面で、Transaction pooler（ポート 6543）の接続文字列を取り、末尾に `?sslmode=require` を付ける
4. 手元で復元を流す。snapshot は SSH で読むだけで、手元のディスクには保存しない。出力は件数だけ

   ```sh
   ssh <VPS> 'cat /var/lib/hibana/runtime_state.json' \
     | DATABASE_URL='<手順 3 の接続文字列>' bun scripts/import-bot-snapshot.ts -
   ```

   テーブルは、このスクリプトが最初に作ります（API の起動時と同じ `migrate()`）。DB にサーバー設定かユーザーが既にあれば止まります。上書きするときだけ `--force` を付けます

5. Vercel の `hibana-api` の Production の `DATABASE_URL` を、手順 3 の接続文字列に替える
6. この PR をマージして、API を配信する（`regions: ["hnd1"]` もここで効く）
7. bot を再起動する（公開サイト・スキル・使えるプリセットを API に送り直すため）
8. 確かめる: `/healthz` が 200 になる。bot のログに snapshot の取得失敗が出ない。ダッシュボードにログインでき、サーバー設定が以前の値のまま見える。公開サイトとスキルの一覧が出る

### 戻し方

Vercel の `DATABASE_URL` を元の Neon の値に戻し、前のデプロイに戻します（Neon の枠が戻っていれば動きます）。Supabase の DB は消さずに残しておけば、もう一度切り替えられます。

## 検証の範囲

- 手元の Postgres 17（Docker の `postgres:17-alpine`）に対して、`PostgresStore` の全操作を確かめた（`apps/api/src/postgres-store.test.ts`。`HIBANA_TEST_DATABASE_URL` を設定したときだけ動く）
- 古い接続のリトライは、プロセスを止めている間に接続を切って、再開する形で手元で再現した
- 復元は、合成した snapshot を手元の Postgres に流して確かめた。本物の snapshot と、Supabase に対しては、まだ流していない
- Supabase のプーラー（transaction モード、TLS）に対する接続と、Vercel の `hnd1` での動作は、まだ確かめていない

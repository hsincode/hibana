# ADR-0002: action は commit SHA で、Vercel CLI は専用の lockfile で固定する

- 状態: 採用
- 決定日・判断者: 2026-10-04、持ち主
- 判断の過程を残した Issue: #3（作り直す範囲）、#5（方式の選択。表の 7 と、コメントの 18・19）
- 置き換える／置き換えられた ADR: なし

## 要求と決定
- プロダクトの特性と、満たす要求:
  - 配信の経路は本番の API・Web・bot を書き換える。同じ commit のワークフローが、日によって違うコードを実行しないこと
  - これまでは action をタグ（`@v4`）で指定し、Vercel CLI は `npx --yes vercel@59.14.0` で実行のたびに 37 個の依存を解決していた（#1 の観察 9）
- 採用する構成・方式:
  - action は 40 桁の commit SHA で指定し、版をコメントで添える。固定する版は、決定時点でタグが指していた版（checkout v4.4.0、setup-bun v2.2.0、upload-artifact v4.6.2）
  - Vercel CLI は `tools/vercel/` の `package.json` と `bun.lock` で固定する。配信の job はそこで `bun install --frozen-lockfile` を実行してから CLI を呼ぶ。`tools/vercel/` はワークスペースに入れない
  - 更新は Dependabot に週 1 回の PR を作らせる。対象は action と `tools/vercel/` だけ
  - タグ指定の action が混ざると失敗するテスト（`scripts/workflow-pins.test.ts`）を置く
- 比較した代替案と、採用しなかった理由:
  - 固定する版
    - 最新版に上げて固定: PR が 1 回で済む。メジャー版を 3 つ飛ばすので、問題が出たときに固定のせいか版上げのせいかを切り分けにくい
  - Vercel CLI
    - ルートの devDependencies: 場所が 1 つで分かりやすい。CLI を更新するたびにルートの lockfile が変わり、bot の配信の条件（ADR-0001）に当たって bot が再起動する
    - `npx` のまま版だけ固定: 変更が要らない。依存の木は固定されず、Dependabot の対象にもならない
  - 更新の仕組み
    - Renovate: まとめ方や頻度を細かく決められる。GitHub App を別に導入する必要がある
    - 手動: PR が増えない。古い版が残りやすい
  - 持ち主の言葉での理由は #5 に追記する

## 影響
- 得られる効果: ワークフローが実行する action と Vercel CLI が、commit ごとに決まる
- 費用・運用の負荷・残る制約:
  - Dependabot の PR を読んでマージする作業が増える。`tools/vercel/` と `.github/` だけの変更なので、マージしても API・Web・bot は配信されない。新しい CLI が使われるのは、その次の配信から
  - 配信の job に `bun install`（286 パッケージ）が加わる
  - アプリの依存（ルートの `bun.lock`）は Dependabot の対象にしていない。更新すると bot が再配信されるため、持ち主が時期を選んで手で行う
  - `Dockerfile` のベースイメージ（`oven/bun:1.4.3`）と、Vercel 側の `installCommand`（`npx --yes bun@1.4.3`）は、タグと版の指定のまま
  - Dependabot は SHA とコメントの両方を更新する（#16・#17 で確かめた）
- セキュリティ・障害時の挙動:
  - action の作者がタグを付け替えても、実行する commit は変わらない
  - `tools/vercel/bun.lock` と `package.json` が食い違うと、`--frozen-lockfile` が配信の前に失敗する

## 実装と検証
- 適用した commit・構成図: この ADR を追加した PR
- 要求ごとの検証記録:
  - 固定の検査: `scripts/workflow-pins.test.ts`。1 か所をタグ指定に戻すと失敗する（2026-10-04 に確認）
  - CLI: `tools/vercel/` で install したあと `vercel --version` が 59.14.0 を返し、ルートの `bun.lock` は変わらない（2026-10-04 に確認）
- 実際の運用・CI/CD の実行記録（2026-10-04）:
  - 固定した action での最初の実行: #7 のマージ後（https://github.com/hsincode/hibana/actions/runs/37191456680）
  - 固定した Vercel CLI での最初の配信: https://github.com/hsincode/hibana/actions/runs/37192815027 （API・Web）
  - Dependabot: #7 のマージの直後に #16（checkout 4.4.0 → 7.0.1）と #17（upload-artifact 4.6.2 → 7.0.1）を開いた。差分は commit SHA と版のコメントの両方を更新していた。持ち主の決定で 2 件ともマージし、マージ後の検査は成功した（https://github.com/hsincode/hibana/actions/runs/37193353942）

## 見直す条件
- Dependabot の PR が多すぎて読めなくなったとき（グループ化するか、頻度を下げる）
- `tools/vercel/` の install が配信の時間を目立って延ばすとき

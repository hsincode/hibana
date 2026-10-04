# ADR-0004: 配信の記録は GitHub の Deployments に残す

- 状態: 採用
- 決定日・判断者: 2026-10-04、持ち主
- 判断の過程を残した Issue: #3（作り直す範囲）、#5（方式の選択。表の 8）
- 置き換える／置き換えられた ADR: なし

## 要求と決定
- プロダクトの特性と、満たす要求:
  - 配信先が API・Web・bot の 3 つあり、変更の内容によって配信される組み合わせが変わる（ADR-0001）。「いつ、どの commit が、どこへ出て、成功したか」を配信先ごとに追えること
  - これまでの記録は、Actions の実行ログ（保存期限あり）、relay の `deployments.json`（30 件まで）、Discord の通知だけだった（#1 の観察 11）
- 採用する構成・方式:
  - 配信の job に Environment を指定する。`deploy-api` は `production-api`、`deploy-web` は `production-web`、`deploy` は `production-bot`
  - Environment を指定した job は、GitHub が Deployment を自動で作り、状態（進行中・成功・失敗）と実行の URL を記録する。スキップされた job は記録を作らない
  - 3 つの Environment は、保護されたブランチ（main）からの配信だけを受け付ける設定にする
- 比較した代替案と、採用しなかった理由:
  - 配信ごとに Git タグと GitHub Release を作る: 変更の一覧つきで履歴が読みやすい。1 日に何度も配信するとタグが増え、配信先ごとの成否は表しにくい
  - Deployments とタグの両方: 両方の利点を得られる。作る量と管理するものが増える
  - 持ち主の言葉での理由は #5 に追記する

## 影響
- 得られる効果: リポジトリの Deployments と、commit・PR の画面から、配信先ごとの履歴を辿れる。保存期限がない
- 費用・運用の負荷・残る制約:
  - 変更の一覧は記録に含まれない。commit の範囲は Discord の通知か、前後の Deployment の commit の差分で見る
  - relay が `superseded` を返した配信も成功として記録される。その実行は本番を変えておらず、実際に配信したのは、より新しい push の実行になる
  - Environment に承認者は設定していない（承認つきの配信はやらない。ADR-0003）
- セキュリティ・障害時の挙動: Environment は main 以外のブランチからの配信を拒否する。配信の job が main でしか動かない条件（`changes` job）に加えた、二重の制限になる

## 実装と検証
- 適用した commit・構成図: この ADR を追加した PR
- 要求ごとの検証記録（2026-10-04）:
  - 配信した job は記録を作る: `production-bot` に `32f6253`、`production-api` と `production-web` に `b51de5d`、`production-api` に `a8542da`。状態は queued → in_progress → success と遷移し、実行のログへのリンクが付く
  - 失敗した配信は失敗として残る: `production-api` の `a13bbee` は failure（#18 の件）
  - スキップされた job は記録を作らない: #7・#8・#9 のマージでは記録が増えなかった
- 実際の運用・CI/CD の実行記録: https://github.com/hsincode/hibana/deployments

## 見直す条件
- 変更の一覧を配信の記録と一緒に残したくなったとき（タグと Release を足す）
- `superseded` の記録が紛らわしく、配信の履歴を読み誤ったとき

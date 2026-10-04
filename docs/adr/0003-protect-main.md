# ADR-0003: main はブランチ保護で守り、本番前の確認は検査に任せる

- 状態: 採用
- 決定日・判断者: 2026-10-04、持ち主
- 判断の過程を残した Issue: #2（変更の進め方）、#3（作り直す範囲）、#5（方式の選択。表の 4 と、コメントの 20）
- 置き換える／置き換えられた ADR: なし

## 要求と決定
- プロダクトの特性と、満たす要求:
  - main への push は、そのまま本番の API・Web・bot に配信される
  - bot はホストの Docker・VPN コンテナ・音声合成に依存し、Discord のトークンも 1 つなので、本番と同じ環境を別に作りにくい（#3）
  - 変更は Issue → PR → 持ち主のマージで入れると決めた（#2）。これまでは約束ごとで、main へ直接 push できた（#1 の観察 5）
- 採用する構成・方式:
  - GitHub のブランチ保護を main にかける
    - マージには PR が必要。承認の必要数は 0（開発者が 1 人で、自分の PR は承認できないため）
    - `checks` と `container` の成功が必要
    - 持ち主（管理者）にも適用する
    - force push とブランチの削除は禁止
  - 本番前の確認は、PR の検査（型検査、テスト、ビルド、画面テスト、コンテナの起動確認）に任せる。プレビュー環境と、承認つきの配信は作らない
- 比較した代替案と、採用しなかった理由:
  - 保護 + PR ごとの API・Web のプレビュー: マージ前に触れる。プレビュー用の環境変数・DB・OAuth の設定と、本番の DB を触らせない設計が要る
  - 保護 + 承認つきの配信（GitHub の Environment）: 出す時刻を選べる。承認を忘れると配信が止まり、配信のたびに 1 手間増える
  - 持ち主は保護を迂回できる設定: 緊急時にすぐ直せる。持ち主の権限で動く AI も直接 push できてしまい、強制にならない
  - ステージングの常設は、範囲を決めたときに「やらないこと」とした（#3）
  - 持ち主の言葉での理由は #5 に追記する

## 影響
- 得られる効果: 検査を通っていない変更と、PR を通らない変更は main に入らない。持ち主の権限で動く AI も main へ直接 push できない
- 費用・運用の負荷・残る制約:
  - 緊急の修正でも PR と検査（数分）を待つ
  - 実際の環境での動作は、本番に出るまで見ない。検査で拾えない問題（外部サービスとの接続、本番だけの設定）は本番で初めて分かる
  - 「ブランチが最新であること」は要求していない。古い main から切った PR でも、検査が通っていればマージできる。マージ後の main の実行で `checks` と `container` が失敗すれば、配信の job は動かない
- セキュリティ・障害時の挙動:
  - 緊急時に保護を外す手順は下のとおり。外した事実と理由を Issue に残す

## 実装と検証
- 適用した commit・構成図: リポジトリの設定なので commit はない。2026-10-04 17:17 JST に、持ち主の決定（#5 の 16「AI が設定」）に基づいて AI が API で設定した
- 設定の内容（`gh api repos/hsincode/hibana/branches/main/protection` で確かめられる）:

  ```json
  {
    "required_status_checks": { "strict": false, "contexts": ["checks", "container"] },
    "enforce_admins": true,
    "required_pull_request_reviews": { "required_approving_review_count": 0 },
    "restrictions": null,
    "allow_force_pushes": false,
    "allow_deletions": false
  }
  ```

- 要求ごとの検証記録: 設定後に API が返した値は上と一致した。main への直接 push が拒否されることは、実際には試していない
- 実際の運用・CI/CD の実行記録（2026-10-04）: 保護をかけた後に、#4・#6・#12・#7・#8・#9・#14・#10・#19・#13・#16・#17 を、PR と検査を通してマージした。マージの操作は、持ち主の指示で AI が行った（#2 のコメント）。保護を外したことはない

### 緊急時に保護を外す手順

1. Issue を作り、外す理由と時刻を書く
2. 持ち主への適用だけを外す: `gh api -X DELETE repos/hsincode/hibana/branches/main/protection/enforce_admins`
3. 修正を push する
4. 適用を戻す: `gh api -X POST repos/hsincode/hibana/branches/main/protection/enforce_admins`
5. 戻したことを `gh api repos/hsincode/hibana/branches/main/protection --jq .enforce_admins.enabled` で確かめ、Issue に書く

## 見直す条件
- 検査を通った変更が本番で壊れることが続いたとき（プレビューか、承認つきの配信を足す）
- 緊急時に保護を外すことが繰り返されるとき
- 開発者が増えたとき（承認の必要数を上げる）

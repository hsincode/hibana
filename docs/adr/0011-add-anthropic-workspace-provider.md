# ADR-0011: プロバイダー「Anthropic Workspace」を足し、Claude Managed Agents のセッションで動かす

- 状態: 提案（実装済み。実 API では未実行。持ち主がマージを決めた時点で「採用」に変える）
- 決定日・判断者: 次の 4 項目は 2026-10-12、持ち主（#76 の原文）。プロバイダー「Anthropic Workspace」として足すこと。既存のサンドボックスではなく、クラウドの作業領域を前提にすること。既存のツールは入れられるものを入れ、入れられないものは無理に入れないこと。モデルは、Haiku Ultra に対応するほかは同じにすること。それ以外（下で「AI の案」と書いた点。上限の値を含む）は AI の案のまま実装しており、本人未確認
- 判断の過程を残した Issue: #76（本人の原文、AI の解釈、まだ決まっていない 11 点の比較）、#66（Managed Agents を不採用にした比較）、#67（非推奨の線引き）、#68（Anthropic の委譲）、#35（Auto Routing）、#44（利用額）
- 置き換える／置き換えられた ADR: なし。ADR-0009 が代替案として不採用にした「Managed Agents」を、`anthropic` のターンの置き換えではなく、別のプロバイダーとして足す。ADR-0009（`anthropic` は `claude` ハーネス）と ADR-0010（非推奨の 14 種と凍結）の対象は変えない。ADR-0008 の保存先（`conversations.db`）に、表を 2 つ足す

## 要求と決定
- プロダクトの特性と、満たす要求:
  - 作業領域は bot の機械の Docker サンドボックスで、サーバーの通常のチャンネルは 1 つを共有している。Anthropic のターンの委譲は `Agent` ツールだけで、Ultra は無い（#68）
  - 持ち主の要求（#76 の原文）: 作業領域もクラウドにあり、Haiku Ultra にも対応したものを、プロバイダー「Anthropic Workspace」として足す。直前のやりとりでの発言は「Haiku Ultra などとして公式 API の機能を使った実装にしたい」
  - AI の解釈（本人未確認）: 「公式 API の機能」は Claude Managed Agents の dynamic workflows。「クラウドの作業領域」は Managed Agents の cloud environment のコンテナ。「Haiku Ultra」は、Haiku 5.5 のときだけ dynamic workflows を有効にすること。「モデルは同じ」は、`anthropic` と同じ 3 モデル（Haiku 5.5 / Sonnet 5.5 / Opus 5.5）で、Auto は含めない
  - 併せて守る要求: 既存の 2 つのハーネスが送るリクエストを変えないこと（#67）。guild / DM の分離と権限チェックを保つこと。費用に上限を置くこと（AGENTS.md）。bot だけで切り戻せること（ADR-0006）
- 採用する構成・方式（プロバイダーとして足すこと以外は AI の案。本人未確認）:
  - provider `anthropic_workspace`（表示名は Anthropic Workspace）。プリセットは 3 件（Premium 以上が設定でき、サーバーで共有できる。`anthropic` と同じ）。最初は非公開で入れ、持ち主が `/models` で公開する。Auto のプリセットは作らず、Auto Routing は `anthropic` だけのままにする（#35）。非推奨でないプロバイダーは `anthropic` と `anthropic_workspace` の 2 つになる
  - 認証情報は `ANTHROPIC_WORKSPACE_API_KEY` だけ。`ANTHROPIC_API_KEY` へのフォールバックはしない（プロバイダーごとに独立した認証情報）
  - 3 つ目の実行経路 `workspace`。ターンは Managed Agents のセッションへの 1 回の発言で、ループ・会話・作業領域は Anthropic 側にある。内容は [docs/harness.md](../harness.md) の「workspace 経路」
  - 公式 SDK `@anthropic-ai/sdk` を **0.133.0 に固定**して、この経路だけで使う。dynamic workflows と budget の型が入った版で、beta の型は版ごとに変わりうるので、範囲指定にしない。`codex` と `claude` の送受信は、従来の `fetch` の実装のまま変えない（ADR-0009 で SDK への置き換えを見送った判断は、その 2 つについてはそのまま）
  - エージェントは 2 つ（委譲なしの plain と、dynamic workflows だけを有効にした ultra）、environment は 1 つ。最初のターンで作り、ID を `HIBANA_DATA_DIR` に保存する。モデル・effort・システムプロンプト・ツールは、セッションの作成時に上書きして渡す
  - セッションはチャンネルごとに 1 つ（スレッド・DM を含む）。対応は `conversations.db` の新しい表 `workspace_sessions`、片付け待ちは `workspace_disposals`（追加だけ）。`/clear` とチャンネルの削除はセッションを delete し、モデルや設定の変更・スレッドの期限切れは archive する
  - ツールは、Managed Agents の組み込みの 8 個と、Hibana の Discord・設定・サイト・Jev のツール最大 76 個（custom tool）。入れないのは、bot のサンドボックスのファイルやイメージに依るもの（スキル、サイトの公開、画像生成、`Agent`、ブラウザーとメディアのダウンロード、VPN、GitHub ログイン、Exa）。一覧は話す人によらず同じにし、可否は呼び出しのたびに、そのターンの依頼者の権限で `ToolRegistry.execute` を通して判定する。ファイルを渡すのは `send_file` だけで、コンテナの `/mnt/session/outputs/` から Files API で取る
  - Haiku Ultra は、既存の Ultra のスイッチが on で、モデルが Workspace の Haiku 5.5 のときだけ働く。xhigh に固定しない。キーワード `ultracode` は効かない。workflow run を始めるのはエージェントで、プロンプトには「分けられる大きな仕事のときだけ」「同時に 1 つまで」と条件つきで書く。run の中からの Hibana のツールは読み取りだけにし、run を始めた人の権限で判定する
  - 上限は、1 ターンの金額（Anthropic 側の session budget。$1、Haiku Ultra は $3）、1 日と月の金額（bot の台帳。$5 と $50）、1 ターンの時間（20 分、Haiku Ultra は 60 分）、bot 全体の同時ターン数（2）、入力長（60,000 字）。値は環境変数で変える。**回数の上限は置かず、金額・時間・同時数で代える**（ループが Anthropic 側にあり、bot は往復を数えて止められないため。#76 の 3）
  - コンテナのネットワークは、既定で `unrestricted`（環境変数で `limited` と許可するホストの一覧にできる）
  - プロンプトと、書き直したツールの説明は、公開文書をもとに自作する（docs/harness.md の「出所」）
- 比較した代替案と、採用しなかった理由（理由の整理は AI によるもので、持ち主の言葉での理由は聞いていない）:
  - `anthropic` のターンを Managed Agents に置き換える（#76 の案 B）: 経路は増えないが、既存の会話・作業領域・サブエージェントの形が変わり、#66 の決定と #69 の比較の前提が変わる
  - 既存の Workflow（Ultracode）を `anthropic` に出す（#68 の 2b）: 作業領域がクラウドにならない。root が xhigh になり、金額の上限を置けない。文面の出所の問題（#68 の 3）を先に決める必要がある
  - まだ決まっていない点ごとの代替案（専用のプリセット「Haiku Ultra」、ターンごとのセッション、会話だけを消す `/clear`、`limited` のネットワーク、生の HTTP での実装、スキルとサイトの公開を Files API 経由で入れる、など）は #76 の表にある。実装は AI の推奨の側で進めてあり、決まったら直す

## 影響
- 得られる効果:
  - bot の機械の CPU・メモリ・ディスクを使わない作業領域（公開文書の記述では、メモリは最大 8 GB、ディスクは最大 10 GB）
  - Haiku 5.5 での並行作業（workflow run）
  - 1 ターンの金額の上限を Anthropic の側に置けるので、bot が落ちても効く。`anthropic` のサブエージェントには、金額の上限がまだ無い（#68）
  - 既存の経路は変えないので、影響を受けるのは、このプロバイダーを選んだサーバーと利用者だけ
- 費用・運用の負荷・残る制約:
  - 料金は、トークンのほかに、セッションが `running` の間の $0.08 / 時と、web 検索 $10 / 1,000 回（料金ページ、取得日 2026-10-11〜12）。budget は list cost（公開単価）で数え、上限をまたいだリクエストは最後まで実行される。workflow run では、動いているスレッドごとに 1 リクエストぶん超えうる
  - 上限の既定値は、実測にもとづく値ではない。実際の 1 ターンの額は分かっていない
  - サーバーの中で、チャンネルをまたいでファイルを共有できなくなる。コンテナの中身は作成から 30 日で失われ、モデルや設定の変更・`/clear` でも失われる。`/clear` が作業ファイルも消すので、ほかの経路と意味が違う
  - セッションの設定（プロンプト・ツール・web の有無）は作成時に固定される。直して配信しても、既にあるセッションには届かない
  - 使えないもの: スキル、サイトの公開、画像生成、`Agent`、bot のブラウザーとメディアのダウンロード、VPN、GitHub ログイン、Exa、Jev の行動選択モード
  - beta（`managed-agents-2026-04-01`、dynamic workflows）に依存する。run の同時数などの上限は Anthropic のサーバーが決める。SDK を固定しているので、beta の変更への追従は手作業になる
  - 経路が 3 つになる。既存の 2 つは `harness-freeze.test.ts` と `claude-harness.test.ts` で固定したまま
  - archive したセッションと、定義を変える前のエージェント・environment は消さないので、Anthropic 側に溜まる
- セキュリティ・障害時の挙動:
  - 組み込みのシェル・ファイル・web のツールは Anthropic 側で動き、bot は 1 件ごとの権限チェックを挟めない。利用停止と権限を確かめるのは、ターンの開始時、Hibana のツールが呼ばれたとき、イベントを読むたび
  - コンテナは、既定では外に出られる。読んだ内容に動かされて、コンテナの中身を外へ送る危険は、公開文書が挙げている。秘密情報はコンテナに入れない（bot の鍵やトークンは渡していない）
  - Files API のファイルは、同じ Console workspace のどの鍵からも読める。**Workspace 専用の Console workspace を作り、その鍵を使い、spend limit を設定することを勧める**（#76 の 8。本人の判断待ち）。bot が壊れても効く歯止めは、この spend limit と session budget だけ
  - 鍵・`authToken`・接続先は必ず明示して SDK に渡すので、環境変数 `ANTHROPIC_API_KEY`・`ANTHROPIC_AUTH_TOKEN`・`ANTHROPIC_BASE_URL`（この配備では、ほかのプロバイダーのもの）がこの経路に混ざることはない（`workspace-client.test.ts`）。ただし SDK は環境変数 `ANTHROPIC_CUSTOM_HEADERS` を読んでヘッダーに足すので、bot の環境にこの変数を置くと、Workspace のリクエストにも付く（SDK 0.133.0 のコードの読み取り）
  - 止め方: **プリセットを非公開に戻しても、既に選んでいるサーバーは動き続ける。** 止めるには、鍵を外す（Workspace を選んでいるサーバーの全ターンが認証エラーになる。ほかのモデルには切り替わらない）か、サーバーごとにモデルを替える
  - 切り戻し（bot だけを前の版に戻したとき。ADR-0006）: 新しい表は読まれないだけで残る。**前の版の bot は、Workspace のチェックポイントを `codex` のものとして扱うことがある**（前の版のコードの読み取りによる。未検証）。**切り戻している間の `/clear` やチャンネルの削除は、クラウドのセッションに届かない**ので、新しい版に戻すと、消したはずの会話と作業ファイルが続く
  - 再起動: セッションを止めて budget を下げ、チェックポイントを残す。起動後は、残ったセッションの片付けを先に通し、1 回だけ自動で再開する。以後は `/retry` を待つ

## 実装と検証
- 適用した commit・構成図: この ADR を足した PR。経路の図は [docs/harness.md](../harness.md)
- 要求ごとの検証記録（手元の自動テスト。Anthropic の応答はすべて偽の `fetch`。ファイルは `apps/bot/src/__tests__/` の下、ほかは書いたとおり）:
  - 既存の 2 つのハーネスに送るリクエストが変わらない: `harness-freeze.test.ts`（スナップショットの期待値は変更なし。対象を選ぶフィルターを `provider !== "anthropic"` から `deprecatedProvider(provider)` に置き換えた）、`claude-harness.test.ts`。鍵を設定してプリセットを公開した状態でも、ツール一覧・プロンプト・設定の解決結果が同じであること: `workspace-settings.test.ts`
  - カタログと設定（非公開・Premium・Auto を広げない・Haiku 5.5 だけ Ultra・子のモデルに選べない）: `packages/shared/src/__tests__/workspace.test.ts`、`deprecation.test.ts`、`apps/api/src/app.test.ts`
  - 鍵の分離と、SDK のエラーの分類: `workspace-client.test.ts`
  - エージェント・environment・セッションの作成: `workspace-resources.test.ts`
  - 1 ターン（budget の上げ下げ、送信、イベント、再接続、中断、時間切れ、再起動）: `workspace-runner.test.ts`
  - ツール（一覧、権限、run の中からの呼び出し、`send_file`）: `workspace-tools.test.ts`
  - プロンプトと文脈、進捗の文: `workspace-prompt.test.ts`、`workspace-progress.test.ts`
  - セッションの表と、前の版・後の版とのファイルの互換: `workspace-sessions.test.ts`
  - 利用額の台帳: `workspace-usage.test.ts`
  - bot 全体（`Hibana.respond` から偽の API まで。上限、片付け、再開、コマンド）: `workspace-turn.test.ts`
  - 画面: `apps/web/tests/design.spec.ts`（`bun run test:ui`）
- 実際の運用・CI/CD の実行記録: 未配信
- 実 API での確認: **未実行**。手動のスクリプト（`cd apps/bot && bun run workspace-smoke`）はあるが、課金されるので、持ち主の承認が出るまで走らせない（#76 の 11）。スクリプト自体も通しでは動かしていない
- 検証していない範囲: [docs/harness.md](../harness.md) の「検証していない範囲」のとおり。主なものは、実 API での全経路、Haiku 5.5 で workflows を有効にできるか、実際の費用、切り戻しの挙動、持ち主による文面の確認

## 見直す条件
- この判断を見直す事象・数値:
  - 実 API で、Haiku 5.5 の workflows、Files API での受け渡し、budget での停止のどれかが、実装の前提どおりに動かないとき
  - #76 のまだ決まっていない点を、持ち主が AI の案と違う形で決めたとき（上限の値、回数の上限、`/clear` の意味、ネットワーク、Haiku Ultra の出し方、SDK を使うか）
  - beta の仕様か SDK の型が変わったとき（SDK の版を上げるのは、その差分を確かめてから）
  - 1 ターンの費用や run の暴走が、決めた上限で抑えられないとき
  - `anthropic` のターンもこの経路に寄せると判断するとき（#66 を変える判断記録で決める）

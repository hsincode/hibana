# Ultra（Claude Code の Ultracode）

サブエージェントの ultra は、Claude Code の Ultracode を再現したモードです。以前の ultra は Codex の Effort: Ultra（HsinCLI の積極的な委譲の指示文）でしたが、これを置き換えました。

Ultracode は、推論 effort の xhigh と、ワークフローの常時編成を組み合わせた設定です。ワークフローとは、複数のサブエージェントを編成する JavaScript のスクリプトです。

参照元は次の2つです。

- Claude Code 2.1.282 の CLI 本体: 指示文・リマインダー・Workflow ツールの説明とリファレンス・子エージェントの指示文・完了通知の形式・上限値を照合しました。
- [Dynamic workflows のドキュメント](https://code.claude.com/docs/en/workflows)

## 動作の概要

| 項目 | Claude Code | Hibana |
| --- | --- | --- |
| 有効化 | `/effort ultracode` | サーバー設定・マイ設定のサブエージェントで ultra、`/switch ultra:on`、設定ツールの `ultra_mode` |
| effort | xhigh | 親を xhigh で呼ぶ（保存済みの effort は変えない） |
| 方針 | 実質的な依頼には毎回 Workflow を使う | 同じ（リマインダーの文面も同一） |
| キーワード | 入力に `ultracode` があると、その1回だけワークフローで実行 | Discord で入力されたメッセージに同じ規則を適用 |
| スクリプト | `agent()` / `parallel()` / `pipeline()` などを使う JavaScript | 同じ API（隔離実行は QuickJS） |

## effort

Ultra の間は、親エージェントの effort を xhigh にして呼び出します。保存済みの effort は書き換えないので、ultra を外すと元の値に戻ります。会話履歴も切り替えでは消えません。

xhigh のないモデルでは、既存の effort 変換で最も近い段階になります。

- Gemini・Grok 4.5 → high
- DeepSeek → max

Claude Code は、xhigh のないモデルでは ultracode 自体を選べなくします。Hibana はモデルを問わず Ultra を使えるようにしました。

子エージェントの effort は、サブエージェントの effort 方針に従います。「任意」で指定がなければ親の xhigh を引き継ぎます。

## システムリマインダー

Claude Code は、入力されたプロンプトに `<system-reminder>` を添えます。Hibana も同じ文面を、ユーザーのメッセージの直後に内部メッセージとして入れます。

| 条件 | 文面 |
| --- | --- |
| Ultra を有効にした最初の入力 | `Ultracode is on: optimize for the most exhaustive, correct answer — not the fastest or cheapest. Use the Workflow tool on every substantive task; ...` |
| 前回のリマインダーから入力が10回あった後 | `Ultracode is still on — use the Workflow tool; ...` |
| Ultra を外した後の最初の入力 | `Ultracode is off — the Workflow tool's standard opt-in rule applies again.` |
| 入力にキーワード `ultracode` がある | `The user included the keyword "ultracode", opting this turn into multi-agent orchestration — use the Workflow tool to fulfill the request.` |

- リマインダーは会話履歴に残ります。次の入力では、モデルが最後に受け取ったのがオンかオフかを履歴から判定します。
- 通常チャンネルの履歴は既定で直近5ターンです。そのため、10回ごとの短い文面より先に、開始時の全文が再送されることがあります。
- `/retry` による再開にはリマインダーを付けません。
- `WORKFLOWS_ENABLED=false` やサブエージェント off のときは、リマインダーもキーワードも無効です。Claude Code でワークフローを無効にしたときと同じです。

キーワードの判定は Claude Code と同じ規則です。

- 大文字小文字は区別しません。「ultracodeで調べて」のように日本語に続けても一致します。
- スラッシュで始まるメッセージは対象外です。
- 次の位置にある場合は一致しません。
  - 引用符・バッククォート・括弧・タグの中
  - `/ultracode` や `ultracode-x` のようなパス・フラグの一部
  - `ultracode.js` のようなファイル名
  - 直後に `?` が続く場合
- 人が入力したメッセージだけが対象です。bot の投稿や音声の文字起こしは含みません。`ULTRACODE_KEYWORD_TRIGGER=false` で無効にできます。

## モードごとの違い

| サブエージェント | Workflow / TaskStop | キーワード | Ultracode のリマインダー | 親の effort | `<multi_agent_mode>` |
| --- | --- | --- | --- | --- | --- |
| off | なし | 無効 | なし | 保存値 | サブエージェント無効 |
| on | あり（明示的な依頼のときだけ使う） | 有効 | オフの通知だけ | 保存値 | 明示的な依頼のときだけ委譲 |
| ultra | あり（常に使う） | 有効 | オン・10回ごと | xhigh | 明示的な依頼のときだけ委譲 |
| multi | キーワードのターンだけ | 有効 | オフの通知だけ | 保存値 | 積極的な委譲＋役割チーム |

- on / ultra の `agents__spawn_agent` などは、従来の on と同じ方針です。明示的な依頼があるときだけ使います。Ultracode の常時の許可は Workflow ツールに対するもので、Claude Code の Agent ツールの扱いとも一致します。
- multi は従来のままです。HsinCLI の積極的な委譲の文面と役割チームを使います。保存上は `ultra_mode=true` も持ちますが、Ultracode にはなりません。

## Workflow ツール

親（root）だけが使えます。入力は Claude Code と同じです。

| 入力 | 内容 |
| --- | --- |
| `script` | ワークフローのスクリプト |
| `scriptPath` | `/workspace` 内のスクリプトファイル。`script` と `name` より優先 |
| `name` | 保存済みのワークフロー |
| `args` | スクリプトの `args` に渡す値 |
| `resumeFromRunId` | 以前の実行の Run ID。完了済みのエージェントを再利用する |

スクリプトの先頭には `export const meta = {...}` が必要です。name・description・phases を純粋なリテラルで書きます。変数・関数呼び出し・スプレッド・`${}` は受け付けません。

起動は非同期です。ツールはすぐに Task ID と Run ID を返し、完了すると `<task-notification>` が親に届きます。通知の形式は Claude Code と同じです。

- `<status>`
- `<summary>`（`Dynamic workflow "名前" completed` など）
- `<result>`（8000文字まで）
- 失敗時の `<recovery>`（再開の呼び出し例）
- `<usage>`（エージェント数・完了・失敗・停止・空の結果、トークン、ツール呼び出し回数、所要時間）

### 説明文とリファレンス

Claude Code と同じく、Workflow ツールの説明文は本体の説明と参照先の案内だけです。スクリプトの書き方のリファレンス（API、pipeline の使い方、品質パターン、Ultracode の方針、再開）は `workflow-authoring` スキルとして提供します。

- `use_skill` で読み込めます。スキル一覧にも表示します。
- キーワードのターンと、Ultracode の全文のリマインダーを送るターンでは自動で読み込みます。すでに会話にある場合は重ねて入れません。
- `SKILLS_ENABLED=false` のときは、説明文にリファレンス全文を埋め込みます。これは Claude Code がスキルを使えないときの動作と同じです。

on / ultra の親への各リクエストでは、ツール定義が約5,800文字増えます（全文を埋め込む場合は約22,000文字）。自動読み込みのリファレンスは約16,500文字で、履歴に残る間は以後のリクエストにも含まれます。

### スクリプトの API

| API | 動作 |
| --- | --- |
| `agent(prompt, opts)` | 子エージェントを1体起動します。`opts` には `label` / `phase` / `schema` / `model` / `effort` / `agentType` を指定できます。`schema` を渡すと、`StructuredOutput` で検証済みのオブジェクトを返します。検証の失敗は5回までです。 |
| `pipeline(items, ...stages)` | 項目ごとに段階を進めます。段階の間で待ち合わせません。 |
| `parallel(thunks)` | すべての完了を待ちます。失敗した要素は `null` になり、失敗は記録されます。 |
| `phase(title)` / `log(message)` | 進捗表示のグループと、表示する1行です。 |
| `console.*` | `log` と同じです。 |
| `workflow(nameOrRef, args)` | 保存済みのワークフロー、または `{scriptPath}` を1段だけ入れ子で実行します。 |
| `args` | Workflow の `args` をそのまま渡します。 |
| `budget` | `total` は常に `null`、`remaining()` は `Infinity` です。`spent()` はこのターンの出力トークン数です。 |
| `setTimeout` / `clearTimeout` | タイマーです。 |

- `Date.now()`、引数なしの `new Date()`、`Math.random()` は例外にします。再開時に同じ呼び出しを繰り返すためで、Claude Code と同じです。
- TypeScript の構文と、`import` / `export` は受け付けません。
- 構文エラーは起動前に検出します。そのときは `Workflow script has a syntax error and was not launched` を返します。

### 隔離と上限

Claude Code はスクリプトを Node の vm で実行します。Hibana のプロセスは各プロバイダーの API キーと全サーバーのワークスペースを持つので、vm では隔離が足りません。そのため、実行ごとに専用の QuickJS（WebAssembly、`quickjs-emscripten-core`）を起動します。

スクリプトからは、上の API 以外は使えません。

- ホストの `process`、`fetch`、ファイル、環境変数には触れられません。
- 関数のコンストラクタを経由しても、QuickJS の外には出られません。

| 上限 | 値 |
| --- | --- |
| 1回の実行で同時に動くエージェント | `min(16, max(2, CPU数 - 2))`（Claude Code と同じ。コンテナの CPU 割り当ても考慮）。`WORKFLOW_MAX_CONCURRENT_AGENTS` で 1〜256 に変更 |
| 1回の実行のエージェント総数 | 1000 |
| `parallel()` / `pipeline()` 1回の項目数 | 4096 |
| スクリプトのメモリ | 64MB |
| 待たずに続けられる同期処理 | 2秒（無限ループなどを止め、Discord との接続を塞がない） |
| スクリプトの長さ | 200,000文字 |

- CPU が4個以下の環境では、同時に動くのは既定で2体です。
- エージェント同士のシェル実行は、既存の仕組みでワークスペースごとに順番に処理されます。

## ワークフローの子エージェント

子エージェントの指示文は、Claude Code の workflow-subagent と同じです。最終テキストはスクリプトへの戻り値で、ユーザー向けのメッセージではありません。

- 会話の履歴は受け取りません。AGENTS.md の指示（人格・運用ルール・ワークスペース）は受け取ります。
- `agentType` に `explorer` / `worker` / `reviewer` を指定すると、Multi-Agent と同じ役割の指示とツール制限を使います。`Explore` は explorer と同じです。
- 使えないツールは次のとおりです。Claude Code の SendUserMessage・Agent・Workflow の禁止に相当します。一覧から外すだけでなく、実行時にも拒否します。
  - `agents__` の協調ツール
  - Workflow / TaskStop
  - ユーザーへの質問
  - Discord への送信・リアクション
  - 公開・設定変更・認証
- モデルと effort は、サブエージェントのモデル・effort 方針（任意／同一／固定）に従います。「任意」の場合だけ `opts.model`（プリセット ID）と `opts.effort` が効きます。利用可否と各アカウントの認証情報は、通常の子エージェントと同じく確認します。
- API の再試行が尽きて終わった場合と、停止した場合は `null` を返します。それ以外の失敗は `agent()` の例外になります。

## 待機・停止・再開

Claude Code では、ワークフローの実行中に会話のターンを終え、通知が届くと改めて回答します。Discord の返信は1回なので、Hibana の親は最終回答の直前でワークフローの完了を待ちます。

- 待機中にポーリングはしません。
- 待機中にユーザーが追加で入力すると、待機を中断してその入力を処理します。
- 親は `TaskStop`（`task_id`）で実行を止められます。自分で止めた実行には完了通知を送りません。
- ターンが終わると、実行中のワークフローは停止します。

再開には `resumeFromRunId` を使います。規則は Claude Code と同じです。

- 最初から変わっていない `agent()` 呼び出しは、保存した結果をすぐに返します。
- 変更・追加・失敗した呼び出しと、それ以降の呼び出しは実行し直します。
- 停止時に実行中だったエージェントはやり直しますが、それ以降の結果の再利用は妨げません。

結果は同じ利用者・同じチャンネルで2時間、メモリに保存します。後のメッセージからも再開できますが、bot を再起動すると消えます。Claude Code はセッションのディレクトリに保存するので、この点が異なります。

- 起動したスクリプトは `/workspace/.hibana/workflows/<Run ID>.js` に保存します。これを編集して `scriptPath` で再実行できます。
- 8000文字を超える結果は `<Run ID>.result.json` に保存し、通知にそのパスを書きます。
- 保存済みのワークフローは `/workspace/.claude/workflows/<name>.js` に置きます。Claude Code のプロジェクト用の保存場所に相当します。

## 表示とログ

実行ごとに Discord のメッセージを1つ作り、2.5秒ごとに書き換えます。Claude Code の `/workflows` に相当する表示です。

- ワークフロー名・状態・エージェント数・トークン・経過時間
- フェーズごとの件数（完了・再利用・実行中・待機・失敗・停止）
- 実行中のエージェント（最大3体）
- 直近のログ3行

Ultracode 以外では、エージェントが25体（サイズ指針を指定した場合はその数）を超えると `⚠ Large workflow` と表示します。

`Workflow started` / `Workflow finished` のログには、次の項目だけを記録します。プロンプト・結果・スクリプトは保存しません。

- Run ID、名前、状態、再開の有無、Ultracode の状態
- エージェント数、失敗数、トークン、所要時間

`Turn started` には、実際に使う effort、`ultracode`、`workflow_keyword` を追加しました。

## 設定

| 環境変数 | 既定 | 内容 |
| --- | --- | --- |
| `WORKFLOWS_ENABLED` | true | false にすると Workflow・キーワード・Ultracode をすべて止めます。サブエージェント無効でも止まります。 |
| `ULTRACODE_KEYWORD_TRIGGER` | true | キーワード `ultracode` を判定するか |
| `WORKFLOW_MAX_CONCURRENT_AGENTS` | 空（上記の式） | 1回の実行で同時に動くエージェント数 |
| `WORKFLOW_SIZE_GUIDELINE` | 空（medium） | 説明文に添えるサイズの目安。unrestricted / small（5体未満）/ medium（10体未満）/ large（50体未満）。上限ではありません。 |

`ultra_mode` の保存形式は変えていないので、データの移行は不要です。既存の Ultra の設定は、次のメッセージから Ultracode として動きます。

## Claude Code との違い

| 項目 | Claude Code | Hibana |
| --- | --- | --- |
| 実行前の確認 | 権限モードによって確認する（auto モードで ultracode のときは省略） | 確認しない。Ultra の設定・キーワード・明示的な依頼を同意として扱う |
| 実行中の会話 | ターンを終えて通知で再開する | 同じターンで待つ |
| スクリプトの実行 | Node vm | QuickJS（WebAssembly）。エラーの文面は QuickJS のもの（例: `not a function`） |
| 進捗の操作 | `/workflows` で一時停止・エージェントの停止や再起動・保存 | Discord の表示のみ。停止は TaskStop |
| worktree の分離 | `opts.isolation: 'worktree'` | なし（指定するとエラー） |
| agentType | Agent ツールの登録済みの種類 | explorer / worker / reviewer / general-purpose |
| budget | `+500k` のような指定で上限を設定 | 指定の仕組みがなく、常に上限なし |
| 再開の保存先 | セッションのディレクトリ（journal.jsonl） | メモリに2時間（再起動で消える） |
| 保存済みのワークフロー | プロジェクト・個人・プラグイン、同梱の `/deep-research` | ワークスペースの `.claude/workflows` のみ |
| xhigh のないモデル | ultracode を選べない | 既存の effort 変換で丸める |
| Large workflow の警告 | エージェント数と推定トークン数 | エージェント数のみ |
| キャッシュのための起動の待ち合わせ・利用上限での一時停止 | あり | なし |

## 検証範囲

自動テストで次を確認しています。

- キーワードの判定規則
- リマインダーの周期（開始・10回・終了）と、会話履歴を保ったままの切り替え
- effort の xhigh 化と、ワークフロー無効時の扱い
- meta の検証
- QuickJS での API の動作（失敗時の `null`、待ち合わせの有無）、決定性の制限、ホストへのアクセス不可、無限ループ・メモリ・循環参照の停止
- 同時実行数と1000体の上限
- 再開の規則
- 進捗表示と通知の形式
- 模擬の LLM で実際のエージェントループを通す統合テスト
  - Ultracode のターンでの起動・`StructuredOutput` の再試行・通知・回答
  - TaskStop と次のターンでの再開
  - 保存済みのワークフロー
  - 構文エラー
  - スキルの自動読み込み
  - 子のツール制限

実モデルがワークフローを書く品質、速度・トークン消費の実測、本番環境での動作はまだ検証していません。

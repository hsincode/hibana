# Anthropic のプロンプトキャッシュ

Anthropic のプロバイダー（`anthropic`、Claude Max）へのリクエストで、何をどれだけの時間キャッシュするか。Anthropic Workspace（Managed Agents）は別の経路で、この文書の対象外（[anthropic-workspace.md](anthropic-workspace.md)）。

## ブレークポイント

`apps/bot/src/llm.ts` の Anthropic の経路で、1 リクエストに 2 つ置く。

| 位置                                       | TTL    | 理由                                                                                                                            |
| ------------------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------- |
| システムの部分の末尾（ツールの定義を含む） | 1 時間 | どのチャンネルにも共通（約 3.8 万トークン）で、チャンネルをまたいで読まれる。履歴を切り詰めても動かない                         |
| 会話の末尾（トップレベルの自動キャッシュ） | 5 分   | ツールのループの次のリクエストや、すぐの返信は 5 分以内に来る。5 分の書き込みは入力の 1.25 倍で、1 時間（2 倍）より安い（#109） |

長い TTL を先に置く決まりがあるので、1 時間のシステムの部分の後に 5 分の会話の末尾を置く（逆の順は許されない）。

5 分を過ぎてから次の発言が来ると、会話の部分は書き直しになる。システムの部分は 1 時間残るので、書き直すのは会話の部分だけ。

## ツール検索（#126）

`anthropic` プロバイダーで、公式のツール検索に対応したモデル（`apps/bot/src/tool-search.ts` の `SUPPORTED`。公式ドキュメントの対応表のとおり）のときは、よく使うツール以外を遅延読み込みにする。

- 遅延させるのは `mcp__<group>__` 名の統合ツールのうち、`LOADED_TOOLS` に無いもの。ハーネスのツール（`shell_command` など）、`request_user_input`、`agents__` の協調ツール、`Workflow`・`TaskStop` は名前が違うので、常に読み込む
- 遅延したツールにも、定義は毎回すべて送る。`defer_loading: true` のツールはシステムの先頭から外れる。検索で見つかったツールは、API が会話の中で展開するので、先頭は書き換わらず、キャッシュは保たれる（公式ドキュメント: https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool ）
- `tool_search_tool_bm25_20251119` を一覧の最後に足す。Hibana の `tool_search`（送ったスキーマを返すだけ）は、この場合は外す
- システムの末尾に、遅延したツールの分類と「無いと答える前に検索する」旨の一文を足す。ツールの一覧が同じなら同じ文なので、先頭は変わらない
- 遅延できるツールが 10 個未満のとき（ロールやワークフローのエージェントなど）は何もしない
- 検索の `server_tool_use`・`tool_search_tool_result` は、ほかのサーバー側ツールと同じく `providerBlocks` として、ターン内の次のリクエストにそのまま送る。会話の履歴も `providerBlocks` を保存するので、後のターンでも同じブロックを送る。チェックポイントが `providerBlocks` を落とすのは、別のモデルで再開するときだけ
- 検索の結果は、読み込んだツールの名前（`tool_reference`）を持つ。その名前が、そのリクエストの `tools`（遅延かどうかは問わない）に無いと、API は `Tool reference '<名前>' not found in available tools` の HTTP 400 を返す。`drop_block` では避けられず、同じリクエストは何度送っても失敗する。ツールの一覧は、同じ会話の中でも発言者（`home_vpn_*`・`vpn_*` は administrator だけ）、サーバーの設定、sandbox の可否、配信で変わる。そこで、送るときに、そのリクエストの `tools` に無いツールへの参照だけを外す（`apps/bot/src/tool-search.ts` の `withDeclaredReferences`）。保存した履歴は変えないので、ツールが戻ったリクエストでは、結果を元のまま送る。外した数は、ログ `LLM request completed` の `tool_references_removed` に出る（外さなかったときは項目が無い）
  - 外すと会話の途中が変わる。ただ、そのリクエストではツールの一覧がすでに変わっていて、キャッシュはツールの位置から外れ、それより後の thinking ブロックは `drop_block` で捨てられる。だから、外すことによる損失は増えない
  - 実 API（`/v1/messages/count_tokens`、2026-11-14）で確かめたこと: 参照を減らした結果、参照が空の結果、宣言していないツールの過去の `tool_use`、検索ツールを宣言しないリクエストに残った検索のブロックは、どれも受け付けられる
  - 本番で HTTP 400 になった会話（2026-11-14 07:14 UTC、スレッドの要約のリクエスト、Claude Fable 5.2）を、管理者でない発言者のリクエストとして組み立て直した。修正前のコードでは同じエラー（fingerprint `30762e087e55209e`）、修正後は 200
- Claude Max は対象外（ゲートウェイがサーバー側ツールを通すか確かめていない。Web 検索と同じ理由）
- 手元で組み立てた一覧（Sonnet 5.5、サーバー内、administrator でない発言者、sandbox・スキル・Exa・Jev・画像を有効、2026-10-28）では、最初に読み込むツールが 101 個・61,065 文字から 12 個・13,791 文字になった。トークン数と、本番の「システムとツールで約 3.6〜3.8 万トークン」がどう変わるかは測っていない
- 本番（2026-11-14、Claude Fable 5.2）で、検索してから読み込んだツールを呼ぶターンと、その検索のブロックを履歴に持つ次のターン（同じ発言者）のリクエストが通った

## スレッドの要約

スレッドの履歴の推定が閾値を超えると、次のターンの前に、古いターンを要約に置き換える（`apps/bot/src/history.ts` の `compact`）。新しい方のターン（閾値の半分まで）はそのまま残す。

方式と閾値は全体の設定（ダッシュボードの「全体の設定」、Discord の `/thread-history`、bot の `set_thread_history`）で決める（#124 ではサーバーごとの設定だった。#161 で全サーバーと DM に共通の値にした）。

| 設定                       | 値                           | 既定    |
| -------------------------- | ---------------------------- | ------- |
| `thread_compaction`        | `cache`・`transcript`・`off` | `cache` |
| `thread_compaction_tokens` | 1,000〜1,000,000             | 30,000  |

- `cache`: 下の、会話のキャッシュを読む形で送る
- `transcript`: 古いターンを JSON にして渡す形で送り、キャッシュには書かない（#113 より前の形）
- `off`: 要約しない。スレッドは切り詰めず、プロバイダーに長すぎると断られたときに古い方の半分を落とす（`shrink`）だけ

閾値と比べるのは履歴の推定値（文字数から数える。システムの部分とツールの定義は含まない）。Anthropic のリクエストは、システムの部分とツールの定義だけで約 3.6〜3.8 万トークンあるので、リクエスト全体と比べると、小さい閾値ではほぼ毎ターン要約することになる。推定は実際より小さめに出る（本番で推定 10 万のとき、実際の履歴は約 13 万トークンだった）。

`THREAD_COMPACTION_TOKENS`（既定 30,000）は、新しく作られるサーバー設定の行と DM の既定値で、サーバーが保存した値が優先する。

`cache` の要約のリクエストは、そのターンが送る先頭（システムの部分・履歴・ツール、同じモデル・effort・検索の設定）に、要約の指示を 1 つ足した形で送る。会話の直前のリクエストと先頭がそろうので、会話の部分をキャッシュから読める（#109）。指示には、そのまま残すターンの最初の発言を引用して、そこより前だけを要約させる。

次のときは、古いターンを JSON にして渡す形（会話と先頭を共有しない）で送り、キャッシュには書かない。

- 方式が `transcript`
- その形で要約が返らなかった（ツールを呼んだ、文章が空）
- 残すターンの最初が文章でない、または履歴の中に見つからない
- Auto Routing のプリセット（モデルがまだ決まっていない）

## 会話の冒頭の設定（#177）

会話の冒頭（先頭の developer のメモと、`# AGENTS.md instructions` の user メッセージ）は、会話の最初のリクエストが送った内容を、以後のターンでもそのまま送る。発言者や設定が変わっても、送り済みの部分は書き換えない。

理由は 2 つある。

- Claude Fable 5.2 は、thinking ブロックを、それが作られたリクエストの `system`・`tools`・それより前の `messages` に束縛する。違う内容の後ろに付けて送り返すと HTTP 400（`invalid_request_error`）になり、同じ内容を送り直しても同じように失敗する（公式ドキュメント: https://platform.claude.com/docs/en/build-with-claude/preserved-thinking ）
- プロンプトキャッシュは先頭からの一致で読むので、冒頭が変わると、その会話のキャッシュを全部書き直すことになる

仕組み（`apps/bot/src/harness.ts` の `promptSections`・`promptMessages`・`promptUpdates`、`apps/bot/src/bot.ts`）:

- 冒頭の設定を節に分ける。ポリシーの節は `persona`（ペルソナ）・`operational`（運用プロンプト）・`context`（個人またはサーバーのコンテキスト）・`workspace`（Workspace の行）・`skills`（スキル一覧）。メモの節は `multi_agent_mode`・`multi_agent_team`・`jev`
- 会話の最初のターンの節を、会話と一緒に保存する（`conversations.db` の `history_channels.opening`）。以後のターンは、保存した節から冒頭を作る
- そのターンの設定と違う節があれば、その節の今の内容を、ユーザーのメッセージの後ろに足す。ポリシーの節はまとめて 1 つの user メッセージ（`# AGENTS.md instructions update`）、メモの節は 1 つずつ、履歴に残る developer のメモ。足したメッセージは、そのターンと一緒に履歴に残る
- どの節が今どの内容かは、保存した節と、履歴に残っている変更のメッセージから決める。同じ設定が続く間は何も足さない。要約や切り詰めで変更のメッセージが履歴から消えたら、次のターンでもう一度足す
- 先頭の system（`prompts/harness/codex.md` と環境の説明）は保存しない。配信で変わったら、新しい内容を送る
- 会話を始め直したとき（`/clear`、モデルの変更、スレッドの期限切れ、設定の変更による消去）は、保存した節も消える。次のターンの設定が、新しい会話の冒頭になる
- この仕組みより前に保存された会話は、最初の冒頭が記録に無い。次のターンの設定を冒頭として保存し、そこから同じように扱う
- Anthropic Workspace のターンは対象外（冒頭を送らない）

複数人のチャンネルで、個人のコンテキストを持つ人と持たない人が交互に話すと、話す人が変わるたびに、変わった節（ペルソナとコンテキスト）の分だけ会話が長くなる。

### 残る編集と `drop_block`

次の編集は、送り済みの内容を今も書き換える。

- `tools`: 発言者のロール（VPN のツール）、個人設定（Jev、MCP、サブエージェント、ワークフロー）、sandbox の可否で変わる。配信でも変わる
- 先頭の system: 配信で変わる
- スレッドの要約、古いターンの切り詰め（`trim`・`shrink`）
- `/retry` と起動時の再開: developer のメモを落として組み立て直す
- 保存するときに落とす画像と、履歴に残さない developer のメモ
- この仕組みより前に保存された会話の、最初のターン

このときに 400 にならないよう、`anthropic` プロバイダーの、thinking が adaptive のリクエストには、ヘッダ `anthropic-beta: thinking-binding-controls-2026-08-01` と `thinking.block_binding.prefix_mismatch_behavior: "drop_block"` を付ける（`apps/bot/src/llm.ts`）。API は、前の内容が変わった thinking ブロックだけを捨てて、リクエストを通す。捨てたブロックには課金されない。

- Claude Max には付けない（ゲートウェイがヘッダとフィールドを通すか確かめていない）
- `thinking: {type: "disabled"}` のリクエスト（Haiku 5.5 の effort なし）には付けない（`block_binding` と一緒だと 400 になる）。このリクエストで束縛のチェックが働くかは確かめていない
- `claude-haiku-5-5`・`claude-sonnet-5-5`・`claude-opus-5-5`・`claude-fable-5-2` が、adaptive とこの組み合わせを受け付けることは、`/v1/messages/count_tokens` で確かめた（2026-11-12）
- beta の機能。ヘッダ名や応答の形が変わったら見直す

### 実 API で確かめたこと（2026-11-12、commit 25ac6ba）

本番の状態と、失敗したターンのチェックポイントから、修正後のコードでリクエストを組み立てて送った。

- `/v1/messages/count_tokens`（無料）: HTTP 400 で失敗した 3 つの会話（Claude Fable 5.2。履歴の thinking ブロックは 7・8・1 個）のリクエストは、どれも 200。同じリクエストから `block_binding` とヘッダを外すと 400 で、エラーの fingerprint は本番のログと同じ `0f28eccbbce38ce7`
- `/v1/messages`（1 リクエスト、Claude Fable 5.2、effort medium、入力 16,920・出力 1,175 トークン）: 200。応答の `input_transformations` は `thinking_dropped` が 1 件、理由は `prefix_binding_mismatch`。このリクエストだけ、`tool_choice` を `none`、`max_tokens` を 3,000 にし、`cache_control` を外して送った（どれも thinking の束縛の対象外）
- 上の応答（thinking ブロック 1 個）を履歴に足して、個人のコンテキストを持つ別の発言者の次のターンを `count_tokens` に送った。冒頭をそのままにして変更分を足す形は、`block_binding` なしで 200。冒頭を発言者の設定で作り直す形（修正前）は、`block_binding` なしで 400（`pattern=first_message_rewritten`）、ありで 200 だが応答の thinking は数えられない（捨てられる）。足す形では、応答の thinking の 427 トークンが入力に数えられる
- 本番のログで fingerprint が違った 3 件のうち、`c3aa51529933fd8a` は同じエラーの別の位置（`messages.1.content.5`、最初に変わった位置は `messages.2.content.0`）。エラーの文に位置が入るので、位置が違うと fingerprint も違う。残る 2 件（`27cf8a4bdddebe77`、`02b8ec9b31abc295`）の文は分かっていない

確かめていないこと: Haiku 5.5・Sonnet 5.5・Opus 5.5 の `/v1/messages`、ツールを呼ぶターン、ターンをまたいで変更のメッセージが履歴に残った後の `/v1/messages`、Claude Max。

## 確かめ方

- リクエストごとのログ `LLM request completed` の `thinking_dropped` が、API が捨てた thinking ブロックの数（`input_transformations` の `thinking_dropped` の件数）。0 は、チェックが働いて何も捨てなかったこと。項目が無いのは、応答が何も言わなかったこと。`thinking_drop_reasons` は理由（`prefix_binding_mismatch`: 前の内容が変わった。`model_binding_mismatch`: 別のモデルのブロック）。`thinking_mismatch` は、API が付けた診断（応答ヘッダ `anthropic-thinking-prefix-mismatch`。編集の種類と、最初に変わった位置。公開されていないヘッダなので、無いこともある）
- 同じ診断は、HTTP 400 で失敗したときのログの `thinking_mismatch` にも出る

- リクエストごとのログ `LLM request completed` の `usage` に、キャッシュの読み込み（`cached_tokens`）と書き込み（`cache_write_tokens`）、書き込みの TTL ごとの内訳（`cache_write_5m_tokens`・`cache_write_1h_tokens`）が出る。要約のリクエストは `agent` が `compaction`
- 利用額の推計（`HIBANA_DATA_DIR/anthropic_usage.json`）は、5 分の書き込みを入力の 1.25 倍、1 時間の書き込みを 2 倍で数える
- 改善前後の計測と判定基準は #109

# プロバイダ障害と再開

HsinCLI fork の `codex-rs/model-provider-info/src/lib.rs`、
`codex-rs/codex-client/src/retry.rs`、`codex-rs/core/src/responses_retry.rs` を参照し、
Hibana の HTTP / SSE の復旧を実装しています。

- Chat Completions / Responses / Anthropic は `stream: true` で要求します。
  JSON を返す互換 API も受信できます。ストリーミングはプロキシが応答を待ち続けて
  524 になるリスクを減らしますが、上流の障害そのものは解消しません。
- HTTP 408 / 429 / 5xx 全般（524 を含む）と接続失敗は、初回に加えて最大4回再試行します。
  200 ms から指数的に待ち、±10%の揺らぎを加えます。Retry-After の秒数・日時も尊重します
  （待機の上限5分）。認証・モデル未検出・不正な入力・利用枠超過は無意味に再試行しません。
- 受信途中の切断、不正な JSON、SSE の完了イベント欠落、一時的な API エラーは最大5回再接続します。
  無通信タイムアウトは5分で、受信するたびに更新します。応答全体の長さを5分に制限しません。
- 上限は `LLM_REQUEST_MAX_RETRIES` / `LLM_STREAM_MAX_RETRIES` /
  `LLM_STREAM_IDLE_TIMEOUT_MS` で調整できます。HTTP と本文受信の予算は独立し、
  入れ子で試行回数を増幅させません。デフォルトでは4回＋5回の再接続＋初回で、
  最大10回のリクエストです。
- 新しいユーザー指示や終了処理は、受信中も再試行待機中も中断できます。
  Discord の進捗表示と `LLM reconnecting` ログに再試行回数を出します。
  エラー本文をログへコピーせず、HTTP ステータスと固定の分類を記録します。
- 応答の完了を確認してからツールを実行します。再接続で途中のツール引数を実行しません。
  計測できる使用量は完了した応答に限られます。失敗した生成のプロバイダ課金は不明です。

## `/retry`

チェックポイントはユーザー・チャンネル・guild/DM・スレッドの境界を確認し、保存から2時間まで
利用できます。新規メッセージからの自動再開にも同じ復元処理を使います。

保存する会話とコンテキストは独立したコピーにします。次の LLM リクエスト前、ツール実行前、
各ツールの結果が得られた時点で保存し、後続操作の失敗で先行操作の結果を失わないようにします。
復元時は現在のシステム指示・設定を作り直します。モデル・プロバイダを変更した場合も
依頼とツール結果を引き継ぎ、互換性のない暗号化された推論ブロックなどだけを取り除きます。

中断したツールの結果がない場合は「成否不明」の対応する結果を補い、実際の状態を確認するよう
モデルへ伝えます。外部操作とローカルファイル保存は原子的に実行できないため、プロセス停止の
瞬間によっては操作が完了していても結果が未保存になります。ツールの厳密な一度だけの実行を
保証するものではありません。外部操作を再実行する前の確認が必要です。

## 検証と限界

2026-09-21 の本番診断では、DeepSeek が `Tool names must be unique.` で HTTP 400 を返すことを
再現しました。Discord の `send_message` とエージェント間通信の `send_message` が同じ名前に
なっていました。重複を除いた同じツール構成の合成リクエストは HTTP 200 でした。
修正では両方の機能を維持し、`mcp__discord__send_message` と `agents__send_message` を
スキーマ検証から実行先まで区別します。

テストは HTTP 524 等からの復旧、SSE 三方式、途中切断・無通信・中断、ツールの二重実行防止、
チェックポイントの再開・モデル変更・スコープ境界・各メッセージツールの実行先を確認します。
VPS 上で修正版の通信処理を使い、DeepSeek と Codex Pro に合成リクエストを送り、
SSE の最終応答と使用量を取得できることも確認しました。ツール自体は実行していません。
全プロバイダの長時間実通信、Discord の利用者操作を含む再開、VPS の強制停止中の外部操作は
未検証です。WebSocket のフォールバックや無制限再接続など、
Codex fork の全機能を移植したものではありません。400/401/404 が設定に起因する場合は
設定の修正が必要で、同一リクエストの再送だけでは解消しません。
# Provider failure diagnostics

Bot journal failures now include `provider_diagnostics`: provider/model,
request or stream phase, elapsed milliseconds for the failed attempt, HTTP
status, recognized content type, SSE error event, and bounded symbolic error
code/type. Retry notices carry the same diagnostics. Invalid JSON, idle timeout,
transport errors and provider errors are distinguished.

Upstream messages, response bodies, prompts, tokens and arbitrary headers are
not logged. A short SHA-256 fingerprint correlates upstream error envelopes
without retaining their messages. Unknown codes keep their existing failure
classification; this change adds evidence rather than changing retry policy.
Tests cover SSE failures, HTTP fallback and malformed JSON retries, including
checks that private upstream content is absent. Earlier failures cannot be
reconstructed from these new fields.

## 失敗の詳細の表示（#42）

2026-10-09 から、どこで失敗したかを Discord と記録に出します。

- Discord の再接続の表示と最終的な失敗の通知に、固定の語だけを付けます。
  段階（`送信時` = 応答が始まる前、`受信中` = 応答の途中）と、原因（`HTTP 529` のような
  ステータス、`overloaded_error` のようなプロバイダのエラーの種類、`無応答で打ち切り`・
  `接続切断`・`不正な応答`・`応答が途中で終了`のどれか）です。最終的な通知には再試行の回数も
  付けます。例: 「プロバイダとの通信を再試行しましたが、応答を完了できませんでした。
  （受信中・overloaded_error・再試行 5 回）」。表示はサーバーのメンバー全員に見えます。
- エラーの種類は `[a-z_]` だけの語に限り、プロバイダが返した本文は表示も記録もしません。
- ダッシュボードの会話ログに `failure_stage`・`failure_reason`・`error_type`・`retries`・
  `effort` を追加しました。API 側でも決まった語・範囲以外は空にします。既存の行は空のままです。
- bot のログ（`provider_diagnostics`）には、問い合わせ用に Anthropic の `request-id`
  （OpenAI 互換は `x-request-id`）と再試行の回数も残します。ID の形をした値だけを残し、
  Discord には出しません。

検証の範囲: 模擬の応答を使う自動テストで、受信中の `overloaded_error`、HTTP 529、無応答、
接続失敗、途中で切れた応答のそれぞれの表示と、本文が表示に混ざらないことを確認しました。
実際のプロバイダの障害での表示は未確認です。

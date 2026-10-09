import type { Json } from "./types";
import { createHash } from "node:crypto";

export type ProviderDiagnostics = {
  event?: string; code?: string; type?: string; error_fingerprint?: string;
  reason?: string; phase?: string; elapsed_ms?: number; response_status?: number;
  content_type?: string; provider?: string; model?: string;
  /** Reconnects spent before the request gave up (#42). */
  retries?: number;
  /** The provider's id for the request (Anthropic `request-id`), for a
   *  support inquiry. Server log only: it is not shown in Discord. */
  request_id?: string;
};

// Never retain upstream messages, bodies, URLs or arbitrary error properties.
// Non-code values get a fingerprint so repeated failures can still correlate.
export function errorDiagnostics(raw: unknown, event?: string): ProviderDiagnostics {
  const e = raw && typeof raw === "object" ? raw as Json : {};
  const code = (v: unknown) => typeof v === "string" && /^[a-z][a-z_]{0,63}$/.test(v) ? v : undefined;
  return {
    event: event && /^[a-z_.]{1,64}$/.test(event) ? event : undefined,
    code: code(e.code), type: code(e.type),
    error_fingerprint: createHash("sha256").update(JSON.stringify([e.code, e.type, e.message])).digest("hex").slice(0, 16),
  };
}

export type FailureKind = "transient" | "authentication" | "invalid_request" | "not_found" | "quota" | "protocol" | "context_length" | "duplicate_tools" | "tool_history" | "refusal";

// Only fixed classifications reach logs/Discord. Provider messages can echo
// prompts, credentials, or an entire proxy HTML page and must stay private.
export class ProviderError extends Error {
  diagnostics: ProviderDiagnostics = {};
  constructor(
    public readonly kind: FailureKind,
    public readonly retryable: boolean,
    public readonly status?: number,
  ) {
    super(`Provider ${status ? `HTTP ${status}: ` : ""}${kind}`);
  }
}

export function httpFailure(status: number): ProviderError {
  const transient = status === 408 || status === 429 || status >= 500;
  return new ProviderError(
    transient ? "transient" : status === 401 || status === 403 ? "authentication"
      : status === 404 ? "not_found" : "invalid_request",
    transient, status,
  );
}

export function apiFailure(raw: unknown, event?: string): ProviderError {
  const failure = classifyApiFailure(raw);
  failure.diagnostics = errorDiagnostics(raw, event);
  return failure;
}

function classifyApiFailure(raw: unknown): ProviderError {
  const error = raw && typeof raw === "object" ? raw as Json : {};
  const codes = [error.code, error.type];
  const message = typeof error.message === "string" ? error.message : "";
  if (/tool names must be unique/i.test(message)) return new ProviderError("duplicate_tools", false);
  if (codes.includes("context_length_exceeded") || /maximum context length|context window.*exceed/i.test(message))
    return new ProviderError("context_length", false);
  if (/tool_call_id.*not found|tool.calls.*must be followed|insufficient tool messages/i.test(message))
    return new ProviderError("tool_history", false);
  if (codes.some(c => c === "insufficient_quota" || c === "billing_hard_limit_reached"))
    return new ProviderError("quota", false);
  if (codes.some(c => ["invalid_api_key", "authentication_error", "permission_error"].includes(String(c))))
    return new ProviderError("authentication", false);
  if (codes.some(c => ["context_length_exceeded", "invalid_request_error", "invalid_request", "content_policy_violation"].includes(String(c))))
    return new ProviderError("invalid_request", false);
  if (codes.some(c => ["model_not_found", "not_found_error"].includes(String(c))))
    return new ProviderError("not_found", false);
  const status = Number(error.status ?? error.code);
  if (Number.isInteger(status) && status >= 400 && status <= 599) return httpFailure(status);
  const transient = codes.some(c => ["server_error", "internal_error", "internal_server_error", "overloaded_error", "rate_limit_error", "rate_limit_exceeded", "timeout", "request_timeout"].includes(String(c)));
  return new ProviderError(transient ? "transient" : "protocol", transient);
}

const phaseWords: Record<string, string> = { request: "送信時", stream: "受信中" };
const reasonWords: Record<string, string> = {
  idle_timeout: "無応答で打ち切り", transport_error: "接続切断", invalid_json: "不正な応答",
  provider_error: "応答が途中で終了",
};

/** Where a provider request failed, in fixed words for Discord (#42), e.g.
 *  "受信中・overloaded_error" or "送信時・HTTP 529". Built only from the
 *  phase, an HTTP status and the code/type `errorDiagnostics` already
 *  restricted to [a-z_], so no provider text can reach a channel. */
export function failureDetail(diagnostics: ProviderDiagnostics | undefined, status?: number): string {
  const d = diagnostics ?? {};
  // `error` is the SSE event name, not a cause.
  const type = [d.type, d.code].find((v) => v && v !== "error");
  const cause = status ? `HTTP ${status}` : type ?? (d.reason ? reasonWords[d.reason] : undefined);
  return [d.phase ? phaseWords[d.phase] : undefined, cause].filter(Boolean).join("・");
}

export function providerFailureNotice(error: unknown): string | undefined {
  if (!(error instanceof ProviderError)) return;
  const detail = [failureDetail(error.diagnostics, error.status),
    error.diagnostics.retries ? `再試行 ${error.diagnostics.retries} 回` : ""].filter(Boolean).join("・");
  const notice = providerFailureText(error);
  return detail ? `${notice}（${detail}）` : notice;
}

function providerFailureText(error: ProviderError): string {
  switch (error.kind) {
    case "authentication": return "プロバイダの認証・権限エラーです。APIキーと利用権限を確認してください。";
    case "not_found": return "プロバイダのモデルまたは接続先が見つかりません。選択モデルと接続先を確認してください。";
    case "quota": return "プロバイダの利用枠を超えています。残高・利用上限を確認してください。";
    case "duplicate_tools": return "送信ツールの名前が重複しています。ボット側のツール定義の修正が必要です。";
    case "tool_history": return "会話内のツール呼び出しと結果の対応が不正です。再開時に履歴を修復します。";
    case "context_length": return "会話がモデルの入力上限を超えています。短い会話で再開するか、より大きい入力に対応するモデルを選んでください。";
    case "invalid_request": return "プロバイダがリクエストを受け付けませんでした。モデル設定や会話の長さを確認してください。";
    case "refusal": return "モデルの安全判定によりこの依頼への応答が停止されました。別のモデルを選ぶか、依頼内容を見直してください。";
    default: return "プロバイダとの通信を再試行しましたが、応答を完了できませんでした。";
  }
}

// Read only bounded JSON error envelopes. HTML proxy errors are unhelpful, and
// a stalled error body must not delay recovery for the full generation timeout.
export async function readHttpFailure(response: Response, signal: AbortSignal): Promise<ProviderError> {
  const fallback = httpFailure(response.status);
  if (!response.body || !response.headers.get("content-type")?.includes("application/json")) return fallback;
  const reader = response.body.getReader();
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), 1000);
  const stop = AbortSignal.any([signal, timeout.signal]);
  const cancel = () => { void reader.cancel().catch(() => {}); };
  stop.addEventListener("abort", cancel, { once: true });
  try {
    let text = "", size = 0;
    const decoder = new TextDecoder();
    while (true) {
      stop.throwIfAborted();
      const next = await reader.read();
      stop.throwIfAborted();
      if (next.done) break;
      size += next.value.length;
      if (size > 16384) return fallback;
      text += decoder.decode(next.value, { stream: true });
    }
    const data = JSON.parse(text + decoder.decode());
    const classified = apiFailure(data.error);
    const failure = classified.kind === "protocol" || (!fallback.retryable && classified.retryable) ? fallback
      : new ProviderError(classified.kind, classified.retryable, response.status);
    failure.diagnostics = classified.diagnostics;
    return failure;
  } catch { return fallback; }
  finally {
    clearTimeout(timer);
    stop.removeEventListener("abort", cancel);
    cancel();
    reader.releaseLock();
  }
}

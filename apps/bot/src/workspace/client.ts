import Anthropic, {
  AnthropicError,
  APIConnectionError,
  APIError,
  APIUserAbortError,
} from "@anthropic-ai/sdk";
import { WORKSPACE_PROVIDER } from "@hibana/shared/catalog";
import type { Config } from "../config";
import { apiFailure, httpFailure, ProviderError } from "../llm-errors";

/** The base URL the SDK expects. It adds `/v1` to every path itself, so a
 *  base configured the way the other providers write theirs still works. */
export function workspaceBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "").replace(/\/+$/, "");
}

/**
 * The official SDK client for Anthropic Workspace turns (#76). It is the only
 * place the SDK is constructed, because its defaults read the environment:
 * unset, `authToken` would take `ANTHROPIC_AUTH_TOKEN` (Claude Kiro's key in
 * this deployment) and `baseURL` would take `ANTHROPIC_BASE_URL` (the
 * `anthropic` provider's). Both are always passed, so this provider only ever
 * sends its own key to its own host. `ANTHROPIC_CUSTOM_HEADERS` is read by
 * the SDK too and cannot be switched off; see `withOwnKey` below.
 */
export function createWorkspaceClient(
  config: Pick<Config, "endpoints">,
  options: {
    fetch?: typeof fetch;
    maxRetries?: number;
    timeoutMs?: number;
  } = {},
): Anthropic {
  const endpoint = config.endpoints[WORKSPACE_PROVIDER];
  if (!endpoint?.apiKey) throw new ProviderError("authentication", false);
  return new Anthropic({
    apiKey: endpoint.apiKey,
    authToken: null,
    baseURL: workspaceBaseUrl(endpoint.baseUrl),
    // For the SDK's own check before it sends: it refuses a request whose
    // merged headers hold no credential, and a line of
    // `ANTHROPIC_CUSTOM_HEADERS` can blank the key there (`x-api-key:`).
    // What is sent is decided in `withOwnKey`, not here.
    defaultHeaders: { "X-Api-Key": endpoint.apiKey, Authorization: null },
    // The global `fetch` is what the SDK would take by itself.
    fetch: withOwnKey(options.fetch ?? fetch, endpoint.apiKey),
    // The SDK retries connection errors, 408, 409, 429 and 5xx without an
    // idempotency key. Calls that create something pass `maxRetries: 0`.
    maxRetries: options.maxRetries ?? 2,
    // Until the response headers. A stream that goes quiet is the runner's.
    timeout: options.timeoutMs ?? 60_000,
    // `ANTHROPIC_LOG=debug` would otherwise print request bodies.
    logLevel: "off",
    fetchOptions: { redirect: "error" },
  });
}

/**
 * `send` with this provider's key on every request, and no `Authorization`.
 * The SDK lays the lines of `ANTHROPIC_CUSTOM_HEADERS` over the credentials as
 * the keys of an object, and one name in two spellings (`X-Api-Key`, then
 * `x-api-key`) is two keys there: a value the client is given under one
 * spelling leaves the other, and the one written later is sent. So the two
 * headers are set here, after all of the SDK's merging. Every request of the
 * client leaves through its `fetch`, the event stream and the file downloads
 * included. Other headers of that variable are still sent (#76).
 */
function withOwnKey(send: typeof fetch, apiKey: string) {
  return (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    // The SDK passes its headers in `init`, never in a Request, whose own
    // headers these replace.
    const headers = new Headers(init?.headers);
    headers.set("x-api-key", apiKey);
    headers.delete("authorization");
    return send(input, { ...init, headers });
  };
}

/** Why a session can no longer take a turn. */
export type SessionGoneReason =
  "not_found" | "terminated" | "archived" | "deleted" | "no_budget";

/**
 * The session a turn was meant for cannot be used any more. `sent` tells the
 * caller what is safe: before the message was accepted a new session can take
 * the turn, after it the turn may already have acted and must not be repeated.
 */
export class SessionGone extends ProviderError {
  constructor(
    readonly sent: boolean,
    readonly why: SessionGoneReason,
  ) {
    super("transient", false);
    this.diagnostics = { code: `session_${why}`, provider: WORKSPACE_PROVIDER };
  }
}

/** What an SDK error says, for deciding what to do next. The message is the
 *  provider's own text: it may be matched here, never logged or shown. */
export type ApiErrorInfo = {
  status?: number;
  type?: string;
  code?: string;
  message: string;
};
export function apiErrorInfo(error: unknown): ApiErrorInfo {
  if (!(error instanceof APIError)) return { message: "" };
  // `APIError.error` is the whole response body, `{type: "error", error, request_id}`.
  // `details.error_code` is in the public documentation (`workflow_run_open`)
  // but not in SDK 0.133.0's types, hence the untyped read.
  const inner = (
    error.error as
      | {
          error?: {
            type?: unknown;
            message?: unknown;
            details?: { error_code?: unknown };
          };
        }
      | undefined
  )?.error;
  const text = (value: unknown) =>
    typeof value === "string" ? value : undefined;
  return {
    status: error.status,
    type: text(inner?.type) ?? error.type ?? undefined,
    code: text(inner?.details?.error_code),
    message: text(inner?.message) ?? "",
  };
}

// Only an id-shaped value is kept, never an arbitrary header.
const requestId = (id: string | null | undefined) =>
  id && /^[A-Za-z0-9_.:-]{1,128}$/.test(id) ? id : undefined;

/**
 * An SDK error as the fixed classification the rest of the bot shows and logs.
 * The SDK's own message and cause carry the provider's text and are dropped.
 * Anything that is not an SDK error is thrown back unchanged: a bug must not
 * be reported as a provider failure. Callers handle an abort first
 * (`if (signal.aborted) throw signal.reason`); the SDK reports one as
 * `APIUserAbortError`, which carries no reason.
 */
export function toProviderError(
  error: unknown,
  phase: "request" | "stream",
  model?: string,
): ProviderError {
  if (error instanceof ProviderError) return error;
  if (!(error instanceof AnthropicError)) throw error;
  const diagnostics = {
    phase,
    provider: WORKSPACE_PROVIDER,
    ...(model && { model }),
  };
  let failure: ProviderError;
  if (
    error instanceof APIUserAbortError ||
    error instanceof APIConnectionError
  ) {
    failure = new ProviderError("transient", true);
    failure.diagnostics = { reason: "transport_error", ...diagnostics };
  } else if (error instanceof APIError && typeof error.status === "number") {
    const info = apiErrorInfo(error);
    const fallback = httpFailure(error.status);
    const classified = apiFailure({
      type: info.type,
      code: info.code,
      message: info.message,
    });
    // The same merge as `readHttpFailure`: the body decides unless it is
    // unknown, and it never turns a final status into a retryable one.
    failure =
      info.type === "billing_error" || error.status === 402
        ? new ProviderError("quota", false, error.status)
        : classified.kind === "protocol" ||
            (!fallback.retryable && classified.retryable)
          ? fallback
          : new ProviderError(
              classified.kind,
              classified.retryable,
              error.status,
            );
    failure.diagnostics = {
      ...classified.diagnostics,
      ...diagnostics,
      response_status: error.status,
      request_id: requestId(error.requestID),
    };
  } else {
    failure = new ProviderError("protocol", false);
    failure.diagnostics = diagnostics;
  }
  return failure;
}

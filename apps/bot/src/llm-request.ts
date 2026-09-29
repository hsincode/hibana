import { sleep } from "./io";
import { readHttpFailure, ProviderError, type ProviderDiagnostics } from "./llm-errors";

export type RetryNotice = {
  diagnostics?: ProviderDiagnostics;
  provider?: string;
  model?: string;
  phase: "request" | "stream";
  attempt: number;
  maxRetries: number;
  delayMs: number;
  status?: number;
};
export type RequestHooks = {
  sleep?: typeof sleep;
  onRetry?: (notice: RetryNotice) => void;
};

export function retryDelay(value: string | null, attempt: number, now = Date.now(), random = Math.random()) {
  const seconds = value?.trim() ? Number(value) : NaN;
  const ms = Number.isFinite(seconds) ? seconds * 1000 : value ? Date.parse(value) - now : NaN;
  // Codex's request backoff starts at 200 ms with ±10% jitter. Respect a
  // server's longer Retry-After instead of retrying while it still throttles.
  return Number.isFinite(ms)
    ? Math.max(0, Math.min(300_000, ms))
    : Math.min(20_000, 200 * 2 ** attempt) * (0.9 + 0.2 * random);
}

export async function requestCompletion<T>(options: {
  fetch: (signal: AbortSignal) => Promise<Response>;
  read: (response: Response, signal: AbortSignal, activity: () => void) => Promise<T>;
  signal?: AbortSignal;
  requestRetries: number;
  streamRetries: number;
  idleMs: number;
  hooks: RequestHooks;
  onRetry?: (notice: RetryNotice) => Promise<void> | void;
}): Promise<T> {
  const retries = { request: 0, stream: 0 };
  while (true) {
    const started = Date.now();
    options.signal?.throwIfAborted();
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    let timer: ReturnType<typeof setTimeout>;
    const activity = () => {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(new ProviderError("transient", true)), options.idleMs);
    };
    let response: Response | undefined;
    let phase: RetryNotice["phase"] = "request";
    let failure: ProviderError | undefined;
    activity();
    try {
      response = await options.fetch(signal);
      signal.throwIfAborted();
      if (!response.ok) throw await readHttpFailure(response, signal);
      phase = "stream";
      activity();
      const result = await options.read(response, signal, activity);
      signal.throwIfAborted();
      return result;
    } catch (error) {
      // A user steering the agent or shutting it down must interrupt both the
      // request and its backoff, never consume the reconnect budget.
      options.signal?.throwIfAborted();
      failure = error instanceof ProviderError ? error : new ProviderError("transient", true);
      failure.diagnostics = {
        ...failure.diagnostics, phase, elapsed_ms: Date.now() - started,
        response_status: response?.status,
        // Only record recognized media types, never a raw provider header.
        content_type: response?.headers.get("content-type")?.includes("text/event-stream") ? "text/event-stream"
          : response?.headers.get("content-type")?.includes("application/json") ? "application/json" : "missing_or_other",
        reason: controller.signal.aborted ? "idle_timeout" : error instanceof SyntaxError ? "invalid_json"
          : error instanceof ProviderError ? "provider_error" : "transport_error",
      };
      if (!failure.retryable) throw failure;
    } finally {
      clearTimeout(timer!);
      // Cancel failed/unused bodies as well as the request's underlying socket.
      // Cancellation failures must not turn a retryable 524 into a fatal error.
      void response?.body?.cancel().catch(() => {});
      controller.abort();
    }
    const maxRetries = phase === "request" ? options.requestRetries : options.streamRetries;
    if (retries[phase] >= maxRetries) throw failure;
    const delayMs = retryDelay(response?.headers.get("retry-after") ?? null, retries[phase]);
    const notice = { phase, attempt: ++retries[phase], maxRetries, delayMs, status: failure?.status, diagnostics: failure?.diagnostics };
    // These are separate bounded budgets, not nested loops that multiply
    // attempts. Only the current model request is replayed; tools stay outside.
    options.hooks.onRetry?.(notice);
    await options.onRetry?.(notice);
    await (options.hooks.sleep ?? sleep)(delayMs, options.signal);
  }
}

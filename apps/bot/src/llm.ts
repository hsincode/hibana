import type { ServiceTier } from "@hibana/shared/settings";
import type { Config, Selection } from "./config";
import { recommendedEffort } from "./config";
import type { Json, Message, ToolCall, ToolDef, Usage } from "./types";
import { apiFailure, ProviderError } from "./llm-errors";
import { readCompletion } from "./llm-stream";
import { requestCompletion, type RequestHooks, type RetryNotice } from "./llm-request";
export { retryDelay } from "./llm-request";

// Claude Opus 5.5, Sonnet 5.5 and the Fable / Mythos 5 line reject a fixed
// `budget_tokens`, `thinking.type=disabled` and sampling parameters with HTTP
// 400. Depth is set only through `output_config.effort`. (Sonnet 5.5's own
// thinking-off mode, `between_tools`, is not used; effort none maps to low.)
export const adaptiveOnlyClaude = (model: string) =>
  /claude-(opus-5-5|sonnet-5-5|fable-5|mythos-5)/.test(model);
// Every Claude 5-series model rejects `budget_tokens` and sampling parameters;
// Opus 5 and Sonnet 5 still accept `thinking.type=disabled`.
const claude5 = (model: string) =>
  /claude-(opus|sonnet|fable|mythos)-5/.test(model);
export function wireEffort(
  model: string,
  effort?: string | null,
): string | undefined {
  if (!effort) return undefined;
  // Ultra is a local multi-agent mode, not a provider effort. Start from the
  // strongest normal rung and let the existing model clamps choose its wire value.
  if (effort === "ultra") effort = "max";
  // These models cannot switch thinking off; the cheapest valid rung is low.
  if (adaptiveOnlyClaude(model) && effort === "none") return "low";
  if (model.includes("muse-spark"))
    return effort === "none" ? "minimal" : effort === "max" ? "xhigh" : effort;
  if (model.includes("ox-alpha") && model.startsWith("stealth/"))
    return effort === "none" ? "minimal" : effort;
  if (/gemini|grok-4\.5/.test(model))
    return ["max", "xhigh"].includes(effort) ? "high" : effort;
  if (/grok-4\.[67]/.test(model)) return effort === "max" ? "xhigh" : effort;
  if (effort === "medium" && !/gpt-|grok|claude|gemini/.test(model))
    return "high";
  if (effort === "xhigh" && !/gpt-|claude/.test(model)) return "max";
  return effort;
}
export function protocolFor(
  selection: Selection,
  nativeSearch = false,
): "chat" | "responses" | "anthropic" {
  if (selection.provider === "claude_max") return "anthropic";
  if (selection.provider === "deepseek" && nativeSearch) return "responses";
  if (selection.provider === "chatgpt") return "responses";
  if (selection.provider === "openai" && /^gpt-6/.test(selection.model))
    return "responses";
  return "chat";
}
export function nativeSearchFor(s: Selection, mode: string, enabled: boolean) {
  return (
    enabled &&
    (mode === "off" || (mode === "auto" && s.provider === "deepseek"))
  );
}
export function outputBudget(
  model: string,
  effort: string | undefined,
  configured: number,
) {
  // Thinking counts toward max_tokens and cannot be switched off on these
  // models; a thinking-off sized limit cuts agentic replies short.
  if (adaptiveOnlyClaude(model)) return 65536;
  const top =
    effort === "max" ||
    effort === "xhigh" ||
    (effort === "high" && /grok-4\.5|gemini|stealth\/ox-alpha/.test(model));
  return Math.min(
    65536,
    Math.max(
      configured,
      top
        ? 32768
        : effort === "high" || effort === "medium"
          ? 16384
          : effort === "low"
            ? 8192
            : 0,
    ),
  );
}
export function toChat(m: Message, supportsDeveloper = false): Json {
  const { images, providerBlocks, turnStart, internal, ...rest } = m;
  const out: Json = {
    ...rest,
    // OpenAI's newer GPT chat models accept `developer`; older compatible APIs
    // get the same authority through `system` instead of rejecting the request.
    role: m.role === "developer" && !supportsDeveloper ? "system" : m.role,
    content: images?.length
      ? [
          ...(m.content ? [{ type: "text", text: m.content }] : []),
          ...images.map((url) => ({ type: "image_url", image_url: { url } })),
        ]
      : m.content,
  };
  // DeepSeek thinking (and other OpenAI-compat providers) 400 when `tool_calls`
  // is present but empty: they treat it as a tool round with no matching tool
  // results. Final answers from a previous turn must omit the field entirely.
  if (!Array.isArray(out.tool_calls) || out.tool_calls.length === 0)
    delete out.tool_calls;
  return out;
}
export function toChatMessages(messages: Message[], supportsDeveloper = false): Json[] {
  if (supportsDeveloper) return messages.map(m => toChat(m, true));
  // Agent mode policy is appended at planning boundaries. Consolidate it in
  // the system prefix for compatible APIs without a native developer role,
  // preserving user/tool adjacency when a checkpoint is resumed.
  const policy = messages.filter(m => m.role === "system" || m.role === "developer");
  return [
    ...(policy.length ? [{ role: "system", content: policy.map(m => m.content).join("\n\n") }] : []),
    ...messages.filter(m => m.role !== "system" && m.role !== "developer").map(m => toChat(m)),
  ];
}
export function toResponses(messages: Message[]): {
  instructions: string;
  input: unknown[];
} {
  const instructions = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const input: unknown[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: m.tool_call_id,
        output: m.content || "",
      });
      continue;
    }
    if (m.role === "assistant" && m.providerBlocks?.length) {
      input.push(...m.providerBlocks);
      continue;
    }
    if (m.content || m.images?.length)
      input.push({
        role: m.role,
        content: m.images?.length
          ? [
              { type: "input_text", text: m.content || "" },
              ...m.images.map((url) => ({
                type: "input_image",
                image_url: url,
              })),
            ]
          : m.content,
      });
    for (const tc of m.tool_calls ?? [])
      input.push({
        type: "function_call",
        call_id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
      });
  }
  return { instructions, input };
}
// Models that accept `role: "system"` inside `messages`. Sonnet 5 and the
// pre-4.8 models return HTTP 400 for it, so they keep every instruction in the
// top-level `system` as before.
export const midConversationSystem = (model: string) =>
  /claude-(opus-5|opus-4-8|fable-5|mythos-5|sonnet-5-5)/.test(model);
export function toAnthropic(messages: Message[], midSystem = true): {
  system: string;
  messages: { role: string; content: Json[] }[];
} {
  const out: { role: string; content: Json[] }[] = [];
  const push = (role: string, blocks: Json[]) => {
    if (!blocks.length) return;
    const last = out.at(-1);
    if (last?.role === role && role !== "system") last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  const system: string[] = [];
  for (const m of messages) {
    if (m.role === "system" || m.role === "developer") {
      // Only the leading policy is the top-level `system`. A later developer
      // note (review revision, "subagents still active", triage) stays where it
      // was appended: hoisting it rewrote `system` mid-session, which drops the
      // cached prefix and invalidates every earlier thinking block (Opus 5.5 /
      // Fable 5.1 preserved thinking).
      if (midSystem && out.length) push("system", [{ type: "text", text: m.content || "" }]);
      else system.push(m.content || "");
      continue;
    }
    if (m.role === "tool") {
      push("user", [
        {
          type: "tool_result",
          tool_use_id: m.tool_call_id,
          content: m.content || "",
        },
      ]);
      continue;
    }
    const blocks: Json[] = [];
    if (m.role === "assistant" && m.providerBlocks?.length) {
      push("assistant", m.providerBlocks as Json[]);
      continue;
    }
    if (m.content) blocks.push({ type: "text", text: m.content });
    for (const url of m.images ?? []) {
      const data = /^data:([^;]+);base64,(.+)$/.exec(url);
      blocks.push({
        type: "image",
        source: data
          ? { type: "base64", media_type: data[1], data: data[2] }
          : { type: "url", url },
      });
    }
    for (const tc of m.tool_calls ?? [])
      blocks.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function.name,
        input: JSON.parse(tc.function.arguments),
      });
    push(m.role, blocks);
  }
  // A mid-conversation system message must follow a user turn and be last or
  // followed by an assistant turn; otherwise keep its text in the user turn.
  const turns: typeof out = [];
  out.forEach((m, i) => {
    const valid = m.role !== "system" ||
      (turns.at(-1)?.role === "user" && (out[i + 1]?.role ?? "assistant") === "assistant");
    const role = valid ? m.role : "user";
    const last = turns.at(-1);
    if (last?.role === role && role !== "system") last.content.push(...m.content);
    else turns.push({ role, content: [...m.content] });
  });
  return { system: system.join("\n\n"), messages: turns };
}
export type Completion = {
  message: Message;
  usage: Usage;
  incomplete: boolean;
};
export function normalizeUsage(raw: Json = {}): Usage {
  const cacheRead = Number(
      (raw.prompt_tokens_details as Json)?.cached_tokens ??
        (raw.input_tokens_details as Json)?.cached_tokens ??
        raw.prompt_cache_hit_tokens ??
        raw.cache_read_input_tokens ??
        0,
    ),
    cacheWrite = Number(raw.cache_creation_input_tokens ?? 0),
    // Anthropic's `input_tokens` counts only the uncached tail; cache reads and
    // writes are reported beside it. OpenAI-style `prompt_tokens` already
    // includes cached tokens, so only the Anthropic shape is summed here.
    prompt =
      raw.prompt_tokens !== undefined
        ? Number(raw.prompt_tokens)
        : Number(raw.input_tokens ?? 0) +
          (raw.cache_read_input_tokens !== undefined ? cacheRead : 0) +
          cacheWrite,
    completion = Number(raw.completion_tokens ?? raw.output_tokens ?? 0);
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: Number(raw.total_tokens ?? prompt + completion),
    cached_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
  };
}
const normalizeCall = (call: Json): ToolCall => {
  const f = (call.function ?? call) as Json;
  return {
    id: String(call.call_id ?? call.id ?? crypto.randomUUID()),
    type: "function",
    function: {
      name: String(f.name),
      arguments:
        typeof f.arguments === "string"
          ? f.arguments
          : JSON.stringify(f.arguments ?? f.input ?? {}),
    },
  };
};
function optionalToolCalls(raw: unknown): ToolCall[] | undefined {
  const calls = (Array.isArray(raw) ? (raw as Json[]) : []).map(normalizeCall);
  // Persist absence, not `[]`, so replay through toChat stays valid.
  return calls.length ? calls : undefined;
}
export function parseCompletion(
  data: Json,
  protocol: "chat" | "responses" | "anthropic",
): Completion {
  if (data.error) throw apiFailure(data.error);
  if (protocol === "responses" && data.status === "failed") throw apiFailure(data.error);
  if (protocol === "responses" && (!Array.isArray(data.output) || (data.status && !["completed", "incomplete"].includes(String(data.status)))))
    throw new ProviderError("transient", true);
  if (protocol === "anthropic" && !Array.isArray(data.content))
    throw new ProviderError("transient", true);
  if (protocol === "responses") {
    const output = (data.output ?? []) as Json[];
    const text = output
      .filter((x) => x.type === "message")
      .flatMap((x) => (x.content as Json[]) ?? [])
      .filter((x) => x.type === "output_text")
      .map((x) => x.text)
      .join("\n");
    return {
      message: {
        role: "assistant",
        content: text,
        tool_calls: optionalToolCalls(
          output.filter((x) => x.type === "function_call"),
        ),
        providerBlocks: output,
      },
      usage: normalizeUsage(data.usage as Json),
      incomplete: data.status === "incomplete",
    };
  }
  if (protocol === "anthropic") {
    // HTTP 200 with stop_reason "refusal" is a classifier decline, not an
    // empty answer. Retrying the same request would decline again.
    if (data.stop_reason === "refusal") throw new ProviderError("refusal", false);
    const content = (data.content ?? []) as Json[];
    return {
      message: {
        role: "assistant",
        content: content
          .filter((x) => x.type === "text")
          .map((x) => x.text)
          .join("\n"),
        tool_calls: optionalToolCalls(
          content
            .filter((x) => x.type === "tool_use")
            .map((x) => ({ ...x, arguments: x.input })),
        ),
        providerBlocks: content,
      },
      usage: normalizeUsage(data.usage as Json),
      incomplete: data.stop_reason === "max_tokens",
    };
  }
  const choice = (data.choices as Json[])?.[0];
  if (!choice?.message)
    throw new ProviderError("transient", true);
  const m = choice.message as Json;
  return {
    message: {
      role: "assistant",
      content: typeof m.content === "string" ? m.content : null,
      reasoning_content:
        typeof (m.reasoning_content ?? m.reasoning) === "string"
          ? String(m.reasoning_content ?? m.reasoning)
          : undefined,
      tool_calls: optionalToolCalls(m.tool_calls),
    },
    usage: normalizeUsage(data.usage as Json),
    incomplete: choice.finish_reason === "length",
  };
}
export class LlmClient {
  constructor(
    private config: Config,
    private fetcher: (
      input: string,
      init?: RequestInit,
    ) => Promise<Response> = fetch,
    private hooks: RequestHooks = {},
  ) {}
  async complete(
    selection: Selection,
    messages: Message[],
    tools: ToolDef[],
    options: {
      serviceTier?: ServiceTier;
      temperature?: number;
      nativeSearch?: boolean;
      signal?: AbortSignal;
      onRetry?: (notice: RetryNotice) => Promise<void> | void;
    } = {},
  ): Promise<Completion> {
    const isChatgpt = selection.provider === "chatgpt";
    // This provider only uses registered master credentials. Never reuse an
    // environment API key or a configurable endpoint for ChatGPT OAuth tokens.
    const endpoint = isChatgpt
      ? { baseUrl: "https://chatgpt.com/backend-api/codex", apiKey: "master-account" }
      : this.config.endpoints[selection.provider];
    if (!endpoint?.apiKey)
      throw new Error(`Missing API key for ${selection.provider}`);
    const protocol = protocolFor(selection, options.nativeSearch);
    const effort = wireEffort(
      selection.model,
      selection.effort ??
        recommendedEffort(selection.model, selection.provider),
    );
    let max = outputBudget(selection.model, effort, this.config.maxTokens);
    const temperature = selection.model.startsWith("stealth/ox-alpha")
      ? Math.round(
          Math.min(1, options.temperature ?? this.config.temperature) * 100,
        ) / 100
      : (options.temperature ?? this.config.temperature);
    let body: Json;
    let path: string;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${endpoint.apiKey}`,
    };
    if (protocol === "responses") {
      path = "/responses";
      body = {
        model: selection.model,
        ...toResponses(messages),
        store: false,
        stream: true,
        max_output_tokens: max,
        tools: tools.map((t) => ({
          ...t.function,
          type: "function",
          strict: false,
        })),
      };
      if (tools.length) body.parallel_tool_calls = true;
      if (effort) body.reasoning = { effort };
      if (options.nativeSearch)
        (body.tools as unknown[]).push({ type: "web_search" });
      if (selection.provider === "openai")
        body.include = ["reasoning.encrypted_content"];
      if (isChatgpt) {
        // Codex's subscription endpoint rejects max_output_tokens and needs
        // encrypted reasoning returned for subsequent tool rounds.
        delete body.max_output_tokens;
        body.include = ["reasoning.encrypted_content"];
      }
    } else if (protocol === "anthropic") {
      path = "/messages";
      const { system, messages: turns } = toAnthropic(
        messages,
        midConversationSystem(selection.model),
      );
      body = {
        model: selection.model,
        // Explicit 1h breakpoint on the stable tools + system prefix, so it
        // survives history trimming that moves the rolling breakpoint below.
        ...(system && {
          system: [
            { type: "text", text: system, cache_control: { type: "ephemeral", ttl: "1h" } },
          ],
        }),
        messages: turns,
        max_tokens: max,
        stream: true,
        tools: tools.map((t) => ({
          name: t.function.name,
          description: t.function.description,
          input_schema: t.function.parameters,
        })),
      };
      headers["anthropic-version"] = "2023-06-01";
      headers["x-api-key"] = endpoint.apiKey;
      // Claude Max serves only 4.7+ models, which reject `budget_tokens` and
      // sampling parameters; adaptive thinking plus effort is the only shape.
      if (effort === "none") body.thinking = { type: "disabled" };
      else {
        body.thinking = { type: "adaptive" };
        if (effort) body.output_config = { effort };
      }
      // Top-level automatic caching moves a second breakpoint to the last
      // cacheable block each request, so tool loops reuse the previous prefix.
      body.cache_control = { type: "ephemeral", ttl: "1h" };
    } else {
      path = "/chat/completions";
      body = {
        model: selection.model,
        messages: toChatMessages(messages, /^gpt-/.test(selection.model)),
        max_tokens: max,
        // Claude 5-series models reject sampling parameters with HTTP 400.
        ...(!claude5(selection.model) && { temperature }),
        stream: true,
      };
      if (selection.provider !== "custom") body.stream_options = { include_usage: true };
      if (tools.length) {
        body.tools = tools;
        body.parallel_tool_calls = true;
      }
      if (effort && claude5(selection.model)) {
        // The Kiro gateway maps `reasoning_effort` to a fixed thinking budget,
        // which every Claude 5-series model rejects with HTTP 400. It forwards
        // Anthropic's adaptive fields unchanged (verified against claude-opus-5-5).
        body.thinking = { type: effort === "none" ? "disabled" : "adaptive" };
        if (effort !== "none") body.output_config = { effort };
      } else if (effort) {
        if (effort !== "none" || /^gpt-/.test(selection.model))
          body.reasoning_effort = effort;
        if (
          /deepseek|grok/.test(selection.model) ||
          ["codex_plus", "codex_pro"].includes(selection.provider)
        )
          body.thinking = { type: effort === "none" ? "disabled" : "enabled" };
      }
      if (options.nativeSearch) body.tools = [...tools, { type: "web_search" }];
    }
    // Other compatible providers can reject OpenAI-specific scheduling fields.
    // Omit auto to preserve existing endpoint/project defaults. Never silently
    // retry a requested tier as a different one: that can change billing.
    if (options.serviceTier && options.serviceTier !== "auto" &&
        ["openai", "codex_plus", "codex_pro", "chatgpt"].includes(selection.provider)) {
      body.service_tier = options.serviceTier;
    }
    try {
      return await requestCompletion({
        fetch: async (signal) => {
          const requestHeaders = { ...headers };
          if (isChatgpt) {
            if (!this.config.webApiUrl || !this.config.internalToken)
              throw new Error("ChatGPT requires the settings API");
            const auth = await this.fetcher(this.config.webApiUrl + "/internal/chatgpt/credential", {
              method: "POST", headers: { Authorization: `Bearer ${this.config.internalToken}` },
              signal, redirect: "error",
            });
            if (!auth.ok) throw new Error(`ChatGPT master account unavailable (HTTP ${auth.status})`);
            const credential = await auth.json() as { access_token: string; account_id: string };
            if (!credential.access_token || !credential.account_id) throw new Error("Invalid ChatGPT credentials");
            requestHeaders.Authorization = `Bearer ${credential.access_token}`;
            requestHeaders["ChatGPT-Account-ID"] = credential.account_id;
            requestHeaders.originator = "codex_cli_rs";
          }
          const response = await this.fetcher(endpoint.baseUrl + path, {
            method: "POST", headers: requestHeaders, body: JSON.stringify(body), signal, redirect: "error",
          });
          // The subscription endpoint may omit Content-Type despite returning
          // SSE. We explicitly requested streaming; preserve error envelopes.
          if (isChatgpt && response.ok && !response.headers.get("content-type")) {
            const headers = new Headers(response.headers);
            headers.set("content-type", "text/event-stream");
            return new Response(response.body, { status: response.status, headers });
          }
          return response;
        },
        read: async (response, signal, activity) => parseCompletion(
          await readCompletion(response, protocol, signal, activity), protocol,
        ),
        signal: options.signal,
        requestRetries: this.config.llmRequestRetries,
        streamRetries: this.config.llmStreamRetries,
        idleMs: this.config.llmStreamIdleMs,
        hooks: { ...this.hooks, onRetry: notice => this.hooks.onRetry?.({
          ...notice, provider: selection.provider, model: selection.model,
        }) },
        onRetry: options.onRetry,
      });
    } catch (error) {
      if (error instanceof ProviderError) {
        error.diagnostics = { ...error.diagnostics, provider: selection.provider, model: selection.model };
        error.message = `LLM ${selection.provider}: ${error.message}`;
      }
      throw error;
    }
  }
}

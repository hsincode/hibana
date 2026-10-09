import { describe, expect, test } from "bun:test";
import { LlmClient, retryDelay, toResponses, toAnthropic } from "../llm";
import { loadConfig } from "../config";
import { Agent } from "../agent";
import { ProviderError, failureDetail, providerFailureNotice } from "../llm-errors";
import type { RetryNotice } from "../llm-request";
import type { Json, Message } from "../types";

const selection = { provider: "custom", model: "test", effort: "none" };
const config = (env: NodeJS.ProcessEnv = {}) => loadConfig({
  PROVIDER: "custom", LLM_BASE_URL: "https://example.com/v1", LLM_API_KEY: "secret",
  LLM_MODEL: "test", ...env,
});
const ok = () => Response.json({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const chat = (delta: Json, finish_reason: string | null = null) => frame({ choices: [{ index: 0, delta, finish_reason }] });
const ending = chat({}, "stop") + "data: [DONE]\n\n";
const sse = (text: string, split = 7) => {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += split) controller.enqueue(bytes.slice(i, i + split));
      controller.close();
    },
  }), { headers: { "content-type": "text/event-stream; charset=utf-8" } });
};
const noWait = async () => {};

test("ChatGPT accepts headerless SSE and preserves done items from an empty terminal envelope", async () => {
  const item = { type: "message", role: "assistant", content: [{ type: "output_text", text: "OK" }] };
  const call = { type: "function_call", call_id: "call-1", name: "lookup", arguments: "{}" };
  const client = new LlmClient(config({ WEB_API_URL: "https://settings.example", WEB_INTERNAL_TOKEN: "internal" }), async url => {
    if (url.endsWith("/credential")) return Response.json({ access_token: "oauth", account_id: "account" });
    const response = sse(
      frame({ type: "response.output_item.done", output_index: 0, item }) +
      frame({ type: "response.output_item.done", output_index: 1, item: call }) +
      frame({ type: "response.completed", response: { status: "completed", output: [] } }),
    );
    response.headers.delete("content-type");
    return response;
  });
  const result = await client.complete({ provider: "chatgpt", model: "gpt-6-luna" }, [{ role: "user", content: "test" }], []);
  expect(result.message.content).toBe("OK");
  expect(result.message.tool_calls?.[0]?.id).toBe("call-1");
  expect(result.message.providerBlocks).toEqual([item, call]);
});

describe("provider recovery", () => {
  for (const status of [408, 429, 500, 502, 503, 504, 520, 524, 529, 599]) {
    test(`HTTP ${status} recovers and closes the failed body`, async () => {
      let requests = 0, cancelled = false;
      const notices: RetryNotice[] = [];
      const llm = new LlmClient(config(), async () => ++requests === 1
        ? new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status }) : ok(),
      { sleep: noWait, onRetry: n => { notices.push(n); } });
      expect((await llm.complete(selection, [], [])).message.content).toBe("ok");
      expect(requests).toBe(2);
      expect(cancelled).toBe(true);
      expect(notices).toMatchObject([{ phase: "request", attempt: 1, maxRetries: 4, status }]);
    });
  }
  for (const status of [400, 401, 403, 404, 422]) {
    test(`HTTP ${status} stops immediately without leaking the response`, async () => {
      let requests = 0;
      const llm = new LlmClient(config(), async () => { requests++; return new Response("secret prompt / key", { status }); }, { sleep: noWait });
      try { await llm.complete(selection, [], []); throw new Error("expected failure"); }
      catch (error) {
        expect(error).toBeInstanceOf(ProviderError);
        expect(String(error)).toContain(`HTTP ${status}`);
        expect(String(error)).not.toContain("secret");
        expect(providerFailureNotice(error)).not.toContain("secret");
      }
      expect(requests).toBe(1);
    });
  }
  test("HTTP retry budget is four retries after the initial request", async () => {
    let requests = 0;
    const llm = new LlmClient(config(), async () => { requests++; return new Response("", { status: 524 }); }, { sleep: noWait });
    await expect(llm.complete(selection, [], [])).rejects.toThrow("HTTP 524");
    expect(requests).toBe(5);
  });
  test("network failures before headers use the HTTP budget", async () => {
    let requests = 0;
    const llm = new LlmClient(config(), async () => { if (++requests < 5) throw new TypeError("socket closed"); return ok(); }, { sleep: noWait });
    expect((await llm.complete(selection, [], [])).message.content).toBe("ok");
    expect(requests).toBe(5);
  });
  test("dropped streams use five reconnects and never return partial output", async () => {
    let requests = 0;
    const notices: RetryNotice[] = [];
    const llm = new LlmClient(config(), async () => { requests++; return sse(chat({ content: "partial" })); }, { sleep: noWait, onRetry: n => { notices.push(n); } });
    await expect(llm.complete(selection, [], [])).rejects.toThrow("transient");
    expect(requests).toBe(6);
    expect(notices.at(-1)).toMatchObject({ phase: "stream", attempt: 5, maxRetries: 5 });
  });
  test("alternating HTTP and stream failures cannot reset each other's budget", async () => {
    let requests = 0;
    const llm = new LlmClient(config(), async () => ++requests % 2
      ? new Response("", { status: 524 }) : sse(chat({ content: "partial" })), { sleep: noWait });
    await expect(llm.complete(selection, [], [])).rejects.toThrow("HTTP 524");
    expect(requests).toBe(9);
  });
  test("JSON fallback body disconnects and malformed JSON are retried", async () => {
    let requests = 0;
    const llm = new LlmClient(config(), async () => {
      requests++;
      if (requests === 1) return new Response(new ReadableStream({ start(c) { c.error(new Error("socket closed")); } }));
      if (requests === 2) return new Response('{"choices":[');
      return ok();
    }, { sleep: noWait });
    expect((await llm.complete(selection, [], [])).message.content).toBe("ok");
    expect(requests).toBe(3);
  });
  test("pre-aborted requests do not connect", async () => {
    let requests = 0;
    const llm = new LlmClient(config(), async () => { requests++; return ok(); });
    await expect(llm.complete(selection, [], [], { signal: AbortSignal.abort(new Error("stop")) })).rejects.toThrow("stop");
    expect(requests).toBe(0);
  });
  test("abort during Retry-After stops immediately", async () => {
    let requests = 0;
    const controller = new AbortController();
    const llm = new LlmClient(config(), async () => { requests++; return new Response("", { status: 429, headers: { "retry-after": "300" } }); });
    const promise = llm.complete(selection, [], [], { signal: controller.signal, onRetry: () => controller.abort(new Error("steer")) });
    await expect(promise).rejects.toThrow("steer");
    expect(requests).toBe(1);
  });
  test("abort while reading cancels the body and never retries", async () => {
    let requests = 0, cancelled = false;
    const controller = new AbortController();
    const llm = new LlmClient(config(), async () => {
      requests++;
      return new Response(new ReadableStream({
        pull() { controller.abort(new Error("stop reading")); },
        cancel() { cancelled = true; },
      }), { headers: { "content-type": "text/event-stream" } });
    });
    await expect(llm.complete(selection, [], [], { signal: controller.signal })).rejects.toThrow("stop reading");
    expect(cancelled).toBe(true);
    expect(requests).toBe(1);
  });
  test("idle timeout cancels a stalled body and reconnects", async () => {
    let requests = 0, cancelled = false;
    const llm = new LlmClient(config({ LLM_STREAM_IDLE_TIMEOUT_MS: "20" }), async () => ++requests === 1
      ? new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "content-type": "text/event-stream" } })
      : ok(), { sleep: noWait });
    expect((await llm.complete(selection, [], [])).message.content).toBe("ok");
    expect(cancelled).toBe(true);
    expect(requests).toBe(2);
  });
  test("incoming heartbeats keep a long reasoning response alive", async () => {
    let count = 0;
    const llm = new LlmClient(config({ LLM_STREAM_IDLE_TIMEOUT_MS: "150" }), async () => new Response(new ReadableStream({
      async pull(controller) {
        await Bun.sleep(30);
        if (++count <= 8) controller.enqueue(new TextEncoder().encode(": ping\n\n"));
        else { controller.enqueue(new TextEncoder().encode(chat({ content: "done" }) + ending)); controller.close(); }
      },
    }), { headers: { "content-type": "text/event-stream" } }));
    expect((await llm.complete(selection, [], [])).message.content).toBe("done");
  });
  test("Retry-After dates and jittered backoff", () => {
    expect(retryDelay("90", 0)).toBe(90_000);
    expect(retryDelay("0", 0)).toBe(0);
    expect(retryDelay("Mon, 21 Sep 2026 10:01:00 GMT", 0, Date.parse("2026-09-21T10:00:00Z"))).toBe(60_000);
    expect(retryDelay(null, 0, 0, 0)).toBe(180);
    expect(retryDelay("bad", 3, 0, 0.5)).toBe(1600);
  });
});

describe("stream protocol adapters", () => {
  test("chat preserves split UTF-8, reasoning, interleaved tool arguments, and final usage", async () => {
    let request: Json = {};
    const llm = new LlmClient(config(), async (_url, init) => {
      request = JSON.parse(String(init?.body));
      return sse(": ping\r\n\r\n" + chat({ content: "日本語", reasoning_content: "thought" }) +
        chat({ tool_calls: [{ index: 0, id: "a", function: { name: "lookup", arguments: '{"x":' } }, { index: 1, id: "b", function: { name: "lookup", arguments: "{}" } }] }) +
        chat({ tool_calls: [{ index: 0, function: { arguments: "1}" } }] }, "tool_calls") +
        frame({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 4 } } }) + "data: [DONE]\n\n", 1);
    });
    const result = await llm.complete(selection, [], []);
    expect(request.stream).toBe(true);
    expect(result.message.content).toBe("日本語");
    expect(result.message.reasoning_content).toBe("thought");
    expect(result.message.tool_calls?.map(c => [c.id, c.function.arguments])).toEqual([["a", '{"x":1}'], ["b", "{}"]]);
    expect(result.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cached_tokens: 4, cache_write_tokens: 0 });
  });
  test("Responses uses completed blocks for encrypted reasoning and tool replay", async () => {
    const output = [{ type: "reasoning", id: "rs", encrypted_content: "opaque", summary: [] }, { type: "function_call", id: "fc", call_id: "call", name: "lookup", arguments: "{}" }];
    const cfg = config({ OPENAI_API_KEY: "separate-key" });
    const llm = new LlmClient(cfg, async () => sse(frame({ type: "response.output_text.delta", delta: "ignore partial" }) + frame({ type: "response.completed", response: { status: "completed", output, usage: { input_tokens: 10, output_tokens: 2 } } })));
    const result = await llm.complete({ provider: "openai", model: "gpt-6-astra" }, [], []);
    expect(toResponses([result.message]).input).toEqual(output);
    expect(result.usage.total_tokens).toBe(12);
  });
  test("Anthropic preserves thinking/signatures, fragmented tool JSON and usage", async () => {
    const cfg = config({ CLAUDE_MAX_API_KEY: "separate-key" });
    const llm = new LlmClient(cfg, async () => sse([
      { type: "message_start", message: { usage: { input_tokens: 10, cache_read_input_tokens: 6 } } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "thought" } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "call", name: "lookup", input: {} } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"key":' } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"a"}' } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } },
      { type: "message_stop" },
    ].map(frame).join("")));
    const result = await llm.complete({ provider: "claude_max", model: "claude-fable-5-1" }, [], []);
    expect(toAnthropic([result.message]).messages[0]?.content[0]).toEqual({ type: "thinking", thinking: "thought", signature: "sig" });
    expect(result.message.tool_calls?.[0]?.function.arguments).toBe('{"key":"a"}');
    // Anthropic input_tokens excludes cache reads; the total prompt adds them back.
    expect(result.usage).toEqual({ prompt_tokens: 16, completion_tokens: 5, total_tokens: 21, cached_tokens: 6, cache_write_tokens: 0 });
  });
  test("HTTP 200 API errors use their type to distinguish retryable overload from quota", async () => {
    let requests = 0;
    const llm = new LlmClient(config(), async () => ++requests === 1
      ? sse(frame({ type: "error", error: { type: "overloaded_error", message: "secret" } })) : ok(), { sleep: noWait });
    expect((await llm.complete(selection, [], [])).message.content).toBe("ok");
    const fatal = new LlmClient(config(), async () => Response.json({ error: { code: "insufficient_quota", message: "secret" } }), { sleep: async () => { throw new Error("must not retry"); } });
    await expect(fatal.complete(selection, [], [])).rejects.toThrow("quota");
  });
  test("Responses failed events reconnect; queued JSON is not treated as a completed answer", async () => {
    const cfg = config({ OPENAI_API_KEY: "key" });
    let requests = 0;
    const llm = new LlmClient(cfg, async () => ++requests === 1
      ? sse(frame({ type: "response.failed", response: { error: { code: "server_error" } } }))
      : requests === 2 ? Response.json({ status: "queued", output: [] })
      : sse(frame({ type: "response.incomplete", response: { status: "incomplete", output: [{ type: "message", content: [{ type: "output_text", text: "continue" }] }] } })), { sleep: noWait });
    const result = await llm.complete({ provider: "openai", model: "gpt-6-astra" }, [], []);
    expect(result.incomplete).toBe(true);
    expect(result.message.content).toBe("continue");
    expect(requests).toBe(3);
  });
  test("a terminal event finishes even when the gateway leaves the connection open", async () => {
    let cancelled = false;
    const llm = new LlmClient(config(), async () => new Response(new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode(chat({ content: "ok" }) + ending)); },
      cancel() { cancelled = true; },
    }), { headers: { "content-type": "text/event-stream" } }));
    expect((await llm.complete(selection, [], [])).message.content).toBe("ok");
    expect(cancelled).toBe(true);
  });
  test("reconnecting a partial tool response executes the completed tool only once", async () => {
    let requests = 0, executed = 0;
    const checkpoints: Message[][] = [];
    const llm = new LlmClient(config(), async () => {
      requests++;
      const call = chat({ tool_calls: [{ index: 0, id: "call", function: { name: "mutate", arguments: "{}" } }] }, "tool_calls");
      if (requests === 1) return sse(call); // Lost the completion marker.
      if (requests === 2) return sse(call + "data: [DONE]\n\n");
      if (requests === 3) return new Response("", { status: 524 }); // After the tool ran.
      return sse(chat({ content: "done" }) + ending);
    }, { sleep: noWait });
    const result = await new Agent(llm).run({
      selection, messages: [{ role: "user", content: "mutate" }],
      tools: [{ type: "function", function: { name: "mutate", description: "mutation", parameters: { type: "object", properties: {} } } }],
      context: { channelId: "1", userId: "2", botId: "3", thread: false, depth: 0, delivered: false },
      maxRounds: 4, temperature: 0.7, nativeSearch: false,
      execute: async () => { executed++; return "saved"; },
      checkpoint: async messages => { checkpoints.push(structuredClone(messages)); },
    });
    expect(result.text).toBe("done");
    expect(executed).toBe(1);
    expect(requests).toBe(4);
    expect(checkpoints.some(ms => ms.filter(m => m.role === "tool").length === 1)).toBe(true);
  });
});

test("HTTP error envelopes expose safe actionable reasons without echoing provider text", async () => {
  for (const [code, message, expected] of [
    ["invalid_request_error", "Tool names must be unique.", "duplicate_tools"],
    ["insufficient_quota", "secret account details", "quota"],
    ["context_length_exceeded", "secret prompt", "context_length"],
  ] as const) {
    let requests = 0;
    const llm = new LlmClient(config(), async () => {
      requests++;
      return Response.json({ error: { code, message } }, { status: 400 });
    }, { sleep: noWait });
    try { await llm.complete(selection, [], []); throw new Error("expected failure"); }
    catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).kind).toBe(expected);
      expect(String(error)).not.toContain("secret");
      expect(String(error)).toContain("LLM custom:");
    }
    expect(requests).toBe(1);
  }
});

// #42: a failure tells where it happened in fixed words only, never provider text.
describe("failure detail", () => {
  const overloaded = () => sse(frame({ type: "error", error: { type: "overloaded_error", message: "secret" } }));
  const failed = async (llm: LlmClient) => {
    try { await llm.complete(selection, [], []); } catch (error) { return error as ProviderError; }
    throw new Error("expected failure");
  };

  test("a stream that keeps failing names the phase, the error type and the reconnects", async () => {
    const notices: RetryNotice[] = [];
    const llm = new LlmClient(config(), async () => overloaded(), { sleep: noWait, onRetry: n => { notices.push(n); } });
    const error = await failed(llm);
    expect(failureDetail(notices.at(-1)!.diagnostics, notices.at(-1)!.status)).toBe("受信中・overloaded_error");
    expect(error.diagnostics).toMatchObject({ phase: "stream", type: "overloaded_error", retries: 5 });
    expect(providerFailureNotice(error)).toContain("（受信中・overloaded_error・再試行 5 回）");
    expect(providerFailureNotice(error)).not.toContain("secret");
  });

  test("HTTP failures, idle timeouts, dropped connections and cut streams each get their own words", async () => {
    const http = await failed(new LlmClient(config(), async () => new Response("", { status: 529 }), { sleep: noWait }));
    expect(failureDetail(http.diagnostics, http.status)).toBe("送信時・HTTP 529");
    const idle = await failed(new LlmClient(config({ LLM_STREAM_IDLE_TIMEOUT_MS: "5" }), async () =>
      new Response(new ReadableStream(), { headers: { "content-type": "text/event-stream" } }), { sleep: noWait }));
    expect(failureDetail(idle.diagnostics, idle.status)).toBe("受信中・無応答で打ち切り");
    const socket = await failed(new LlmClient(config(), async () => { throw new TypeError("socket closed"); }, { sleep: noWait }));
    expect(failureDetail(socket.diagnostics, socket.status)).toBe("送信時・接続切断");
    const cut = await failed(new LlmClient(config(), async () => sse(chat({ content: "partial" })), { sleep: noWait }));
    expect(failureDetail(cut.diagnostics, cut.status)).toBe("受信中・応答が途中で終了");
  });

  test("the provider's request id is kept for the server log only when it looks like an id", async () => {
    const withId = (id: string) => async () => new Response("", { status: 400, headers: { "request-id": id } });
    expect((await failed(new LlmClient(config(), withId("req_011CX9abc"), { sleep: noWait }))).diagnostics.request_id).toBe("req_011CX9abc");
    expect((await failed(new LlmClient(config(), withId("secret token with spaces"), { sleep: noWait }))).diagnostics.request_id).toBeUndefined();
  });

  test("the reconnect progress shows the same words", async () => {
    const progress: string[] = [];
    let requests = 0;
    const llm = new LlmClient(config(), async () => ++requests === 1 ? overloaded() : ok(), { sleep: noWait });
    await new Agent(llm).run({
      selection, messages: [{ role: "user", content: "hi" }], tools: [],
      context: { channelId: "1", userId: "2", botId: "3", thread: false, depth: 0, delivered: false, progress: async (text: string) => { progress.push(text); } },
      maxRounds: 2, temperature: 0.7, nativeSearch: false, execute: async () => "",
    });
    expect(progress).toContain("応答を再接続しています（1/5・受信中・overloaded_error）。進捗は保持しています。");
  });
});

import { describe, test, expect } from "bun:test";
import {
  normalizeUsage,
  LlmClient,
  parseCompletion,
  toChat,
  toResponses,
  toAnthropic,
  wireEffort,
  outputBudget,
  protocolFor,
  nativeSearchFor,
} from "../llm";
import { Agent } from "../agent";
import { loadConfig } from "../config";
import type { Message, ToolDef, Context, Json } from "../types";
const tool: ToolDef = {
  type: "function",
  function: {
    name: "lookup",
    description: "Find a record",
    parameters: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
    },
  },
};
const ctx: Context = {
  channelId: "1",
  userId: "2",
  botId: "3",
  thread: false,
  depth: 0,
  delivered: false,
};
const selection = { provider: "custom", model: "test-model", effort: "none" };
const config = () =>
  loadConfig({
    PROVIDER: "custom",
    LLM_BASE_URL: "https://example.com/v1",
    LLM_API_KEY: "secret-test",
    LLM_MODEL: "test-model",
  });
const response = (message: unknown) =>
  Response.json({
    choices: [{ message }],
    usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
  });
describe("provider adapters", () => {
  test("Responses preserves reasoning and function call identity on replay", () => {
    const data = {
      output: [
        {
          type: "reasoning",
          id: "rs",
          encrypted_content: "opaque",
          summary: [],
        },
        {
          type: "function_call",
          call_id: "fc",
          name: "lookup",
          arguments: '{"key":"a"}',
        },
      ],
      usage: {
        input_tokens: 10,
        output_tokens: 2,
        input_tokens_details: { cached_tokens: 4 },
      },
    };
    const completion = parseCompletion(data, "responses");
    expect(completion.usage.total_tokens).toBe(12);
    expect(completion.usage.cached_tokens).toBe(4);
    const replay = toResponses([
      { role: "system", content: "sys" },
      completion.message,
      { role: "tool", tool_call_id: "fc", content: "result" },
    ]);
    expect(replay.instructions).toBe("sys");
    expect(replay.input.slice(0, 2)).toEqual(data.output);
    expect(replay.input[2]).toEqual({
      type: "function_call_output",
      call_id: "fc",
      output: "result",
    });
  });
  test("Anthropic keeps thinking signatures and combines tool results into a user message", () => {
    const message = parseCompletion(
      {
        content: [
          { type: "thinking", thinking: "private", signature: "sig" },
          { type: "tool_use", id: "1", name: "lookup", input: { key: "a" } },
        ],
      },
      "anthropic",
    ).message;
    const body = toAnthropic([
      { role: "system", content: "sys" },
      message,
      { role: "tool", tool_call_id: "1", content: "ok" },
      { role: "user", content: "continue" },
    ]);
    expect(body.messages[0]?.content[0]).toEqual({
      type: "thinking",
      thinking: "private",
      signature: "sig",
    });
    expect(body.messages[1]?.content.map((x) => x.type)).toEqual([
      "tool_result",
      "text",
    ]);
  });
  test("effort and output budgets are model-aware", () => {
    expect(wireEffort("grok-4.5", "max")).toBe("high");
    expect(wireEffort("grok-4.5", "ultra")).toBe("high");
    expect(wireEffort("grok-4.6", "ultra")).toBe("xhigh");
    expect(wireEffort("muse-spark-1.3-contributor", "none")).toBe("minimal");
    expect(wireEffort("gpt-6.1-sol", "medium")).toBe("medium");
    expect(wireEffort("gpt-6.1-sol", "ultra")).toBe("max");
    expect(outputBudget("gemini-3.8-flash", "high", 8192)).toBe(32768);
    expect(outputBudget("gpt-6.1-sol", "max", 100000)).toBe(65536);
    expect(
      protocolFor({ provider: "codex_plus", model: "gpt-6-luna" }),
    ).toBe("chat");
    expect(
      protocolFor({ provider: "claude_max", model: "claude-fable-5-1" }),
    ).toBe("anthropic");
    expect(protocolFor({ provider: "openai", model: "gpt-6-astra" })).toBe(
      "responses",
    );
  });
  test("developer messages fall back only for chat APIs without native support", () => {
    const message = { role: "developer" as const, content: "policy" };
    expect(toChat(message).role).toBe("system");
    expect(toChat(message, true).role).toBe("developer");
    expect(toAnthropic([message]).system).toBe("policy");
    const later = toAnthropic([
      message,
      { role: "user", content: "hi" },
      { role: "developer", content: "revise" },
    ]);
    expect(later.system).toBe("policy");
    expect(later.messages.at(-1)).toEqual({ role: "system", content: [{ type: "text", text: "revise" }] });
    const hoisted = toAnthropic([message, { role: "user", content: "hi" }, { role: "developer", content: "revise" }], false);
    expect(hoisted.system).toBe("policy\n\nrevise");
    expect(hoisted.messages.map((m) => m.role)).toEqual(["user"]);
  });
  test("wire carries tools and reasoning content but never local metadata", async () => {
    let request: Json = {};
    const fetcher = async (_url: unknown, init?: RequestInit) => {
      request = JSON.parse(String(init?.body));
      return response({ role: "assistant", content: "ok" });
    };
    const client = new LlmClient(config(), fetcher);
    await client.complete(
      selection,
      [
        {
          role: "assistant",
          content: "",
          reasoning_content: "opaque",
          providerBlocks: [{ local: true }],
          images: [],
        },
      ],
      [tool],
    );
    expect((request.messages as Json[])[0]?.providerBlocks).toBeUndefined();
    expect((request.messages as Json[])[0]?.reasoning_content).toBe("opaque");
    expect(request.tools).toEqual([tool]);
  });
  test("empty tool_calls are omitted on the wire so DeepSeek does not 400 the next user turn", async () => {
    expect(
      toChat({
        role: "assistant",
        content: "done",
        reasoning_content: "thought",
        tool_calls: [],
      }).tool_calls,
    ).toBeUndefined();
    expect(
      parseCompletion(
        { choices: [{ message: { role: "assistant", content: "done" } }] },
        "chat",
      ).message.tool_calls,
    ).toBeUndefined();
    const calls = [
      {
        id: "a",
        type: "function" as const,
        function: { name: "lookup", arguments: '{"key":"x"}' },
      },
    ];
    expect(
      toChat({
        role: "assistant",
        content: "",
        reasoning_content: "think",
        tool_calls: calls,
      }).tool_calls,
    ).toEqual(calls);
    let request: Json = {};
    const client = new LlmClient(config(), async (_url, init) => {
      request = JSON.parse(String(init?.body));
      return response({ role: "assistant", content: "ok" });
    });
    await client.complete(
      selection,
      [
        { role: "user", content: "play" },
        {
          role: "assistant",
          content: "",
          reasoning_content: "need a tool",
          tool_calls: calls,
        },
        { role: "tool", tool_call_id: "a", content: "{}" },
        {
          role: "assistant",
          content: "report",
          reasoning_content: "finished",
          tool_calls: [],
        },
        { role: "user", content: "continue" },
      ],
      [tool],
    );
    const messages = request.messages as Json[];
    expect(messages[1]?.tool_calls).toEqual(calls);
    expect(messages[1]?.reasoning_content).toBe("need a tool");
    expect(messages[3]?.content).toBe("report");
    expect(messages[3]?.reasoning_content).toBe("finished");
    expect(messages[3]).not.toHaveProperty("tool_calls");
  });
  test("authorization failure is not retried or leaked", async () => {
    let calls = 0;
    const client = new LlmClient(config(), async () => {
      calls++;
      return new Response("secret-body", { status: 401 });
    });
    await expect(client.complete(selection, [], [])).rejects.toThrow(
      "HTTP 401",
    );
    expect(calls).toBe(1);
  });
});
describe("agent loop", () => {
  test("executes calls, sends results back and checkpoints complete tool pairs", async () => {
    const requests: Json[] = [];
    let round = 0;
    const client = new LlmClient(
      config(),
      async (_url: unknown, init?: RequestInit) => {
        requests.push(JSON.parse(String(init?.body)));
        round++;
        return response(
          round === 1
            ? {
                role: "assistant",
                content: "",
                tool_calls: [
                  {
                    id: "a",
                    type: "function",
                    function: { name: "lookup", arguments: '{"key":"x"}' },
                  },
                ],
              }
            : { role: "assistant", content: "Finished" },
        );
      },
    );
    const checkpoints: Message[][] = [];
    const result = await new Agent(client).run({
      selection,
      messages: [{ role: "user", content: "find x" }],
      tools: [tool],
      context: { ...ctx },
      maxRounds: 4,
      temperature: 0.7,
      nativeSearch: false,
      execute: async (name, args) => ({ name, value: args.key }),
      checkpoint: async (m) => {
        checkpoints.push(structuredClone(m));
      },
    });
    expect(result.text).toBe("Finished");
    expect(result.usage.total_tokens).toBe(30);
    expect((requests[1]?.messages as Json[]).at(-1)?.tool_call_id).toBe("a");
    expect(checkpoints.some(m => m.at(-1)?.role === "tool")).toBe(true);
  });
  test("unknown tools and invalid arguments never execute", async () => {
    let round = 0,
      executions = 0;
    const client = new LlmClient(config(), async () =>
      response(
        ++round === 1
          ? {
              tool_calls: [
                { id: "a", function: { name: "missing", arguments: "{}" } },
                { id: "b", function: { name: "lookup", arguments: "[]" } },
              ],
            }
          : { content: "Handled" },
      ),
    );
    const result = await new Agent(client).run({
      selection,
      messages: [],
      tools: [tool],
      context: { ...ctx },
      maxRounds: 4,
      temperature: 0,
      nativeSearch: false,
      execute: async () => {
        executions++;
      },
    });
    expect(executions).toBe(0);
    expect(
      result.messages
        .filter((m) => m.role === "tool")
        .every((m) => m.content?.includes("error")),
    ).toBe(true);
  });
  test("blocks the third identical call without duplicating its side effect", async () => {
    let round = 0,
      executions = 0;
    const client = new LlmClient(config(), async () =>
      response(
        ++round <= 3
          ? {
              tool_calls: [
                {
                  id: String(round),
                  function: { name: "lookup", arguments: '{"key":"a"}' },
                },
              ],
            }
          : { content: "Done" },
      ),
    );
    await new Agent(client).run({
      selection,
      messages: [],
      tools: [tool],
      context: { ...ctx },
      maxRounds: 6,
      temperature: 0,
      nativeSearch: false,
      execute: async () => {
        executions++;
        return { ok: true };
      },
    });
    expect(executions).toBe(2);
  });
  test("tool completion is preserved before steering is injected", async () => {
    let round = 0;
    let pending: Message[] = [];
    const client = new LlmClient(config(), async () =>
      response(
        ++round === 1
          ? {
              tool_calls: [
                {
                  id: "a",
                  function: { name: "lookup", arguments: '{"key":"a"}' },
                },
              ],
            }
          : { content: "Steered" },
      ),
    );
    const result = await new Agent(client).run({
      selection,
      messages: [],
      tools: [tool],
      context: { ...ctx },
      maxRounds: 4,
      temperature: 0,
      nativeSearch: false,
      takeSteering: () => pending.splice(0),
      execute: async () => {
        pending.push({ role: "user", content: "change direction" });
        return "done";
      },
    });
    expect(result.messages.map((m) => m.role)).toEqual([
      "assistant",
      "tool",
      "user",
      "assistant",
    ]);
  });
});

test("provider requests enable parallel function calls without changing reasoning effort", async () => {
  for (const [provider, model, payload] of [
    ["custom", "gpt-6.1-sol", { choices: [{ message: { role: "assistant", content: "ok" } }] }],
    ["openai", "gpt-6-astra", { output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] }],
    ["claude_max", "claude-fable-5-1", { content: [{ type: "text", text: "ok" }] }],
  ] as const) {
    const cfg = loadConfig({ PROVIDER: provider, LLM_MODEL: model, LLM_BASE_URL: "https://example.com", LLM_API_KEY: "fixture", OPENAI_API_KEY: "fixture", CLAUDE_MAX_API_KEY: "fixture" });
    let body: Json = {};
    const client = new LlmClient(cfg, async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return Response.json(payload);
    });
    await client.complete({ ...cfg.selection, effort: "low" }, [{ role: "user", content: "Use tools" }], [tool]);
    if (provider === "claude_max") {
      // Anthropic enables parallel tool use by default; OpenAI-only fields
      // would be invalid on /messages.
      expect(body.parallel_tool_calls).toBeUndefined();
      expect(body.tool_choice).toBeUndefined();
      expect(body.thinking).toEqual({ type: "adaptive" });
      expect(body.output_config).toEqual({ effort: "low" });
      expect(body.temperature).toBeUndefined();
    } else {
      expect(body.parallel_tool_calls).toBe(true);
      expect(provider === "openai" ? (body.reasoning as Json).effort : body.reasoning_effort).toBe("low");
    }
    await client.complete(cfg.selection, [{ role: "user", content: "Hello" }], []);
    expect(body.parallel_tool_calls).toBeUndefined();
  }
});

test("Service Tier reaches OpenAI chat and Responses and Codex gateways but stays off unrelated providers", async () => {
  for (const [provider, model] of [
    ["openai", "gpt-4o-mini"], ["openai", "gpt-6-astra"],
    ["codex_plus", "gpt-6.1-sol"], ["codex_pro", "gpt-6.1-sol"],
    ["deepseek", "deepseek-flash"], ["claude_max", "claude-fable-5-1"],
  ]) {
    const cfg = loadConfig({ OPENAI_API_KEY: "fixture", CODEX_PLUS_API_KEY: "fixture", CODEX_PRO_API_KEY: "fixture", DEEPSEEK_API_KEY: "fixture", CLAUDE_MAX_API_KEY: "fixture" });
    let body: Json = {};
    const client = new LlmClient(cfg, async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return Response.json({ choices: [{ message: { role: "assistant", content: "ok" } }],
        output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }], content: [{ type: "text", text: "ok" }] });
    });
    for (const serviceTier of ["priority", "flex", "ultrafast", "default", "auto"] as const) {
      await client.complete({ provider: provider!, model: model! }, [{ role: "user", content: "Hello" }], [], { serviceTier });
      expect(body.service_tier).toBe(serviceTier !== "auto" && ["openai", "codex_plus", "codex_pro"].includes(provider!) ? serviceTier : undefined);
    }
  }
});

test("Opus 5.5 and Sonnet 5.5 get adaptive thinking instead of a fixed budget on Kiro and Claude Max", async () => {
  for (const [provider, model] of [
    ["claude_kiro", "claude-opus-5-5"],
    ["claude_max", "claude-opus-5-5"],
    ["claude_kiro", "claude-sonnet-5-5"],
  ] as const) {
    const cfg = loadConfig({ CLAUDE_KIRO_API_KEY: "fixture", CLAUDE_MAX_API_KEY: "fixture" });
    let body: Json = {};
    const client = new LlmClient(cfg, async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return Response.json({ choices: [{ message: { role: "assistant", content: "ok" } }], content: [{ type: "text", text: "ok" }] });
    });
    for (const [effort, wire] of [["medium", "medium"], ["none", "low"]] as const) {
      await client.complete({ provider, model, effort }, [{ role: "user", content: "Hello" }], []);
      expect(body.thinking).toEqual({ type: "adaptive" });
      expect(body.output_config).toEqual({ effort: wire });
      expect(body.reasoning_effort).toBeUndefined();
    }
  }
});

test("Claude Max caches the system prefix and reports cache reads and writes", async () => {
  const cfg = loadConfig({ CLAUDE_MAX_API_KEY: "fixture" });
  let body: Json = {};
  const client = new LlmClient(cfg, async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return Response.json({
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 10, cache_read_input_tokens: 900, cache_creation_input_tokens: 90, output_tokens: 5 },
    });
  });
  const { usage } = await client.complete(
    { provider: "claude_max", model: "claude-fable-5-1" },
    [{ role: "system", content: "Stable rules" }, { role: "user", content: "Hello" }],
    [],
  );
  expect(body.system).toEqual([{ type: "text", text: "Stable rules", cache_control: { type: "ephemeral", ttl: "1h" } }]);
  expect(body.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  expect(body.temperature).toBeUndefined();
  expect(usage).toEqual({ prompt_tokens: 1000, completion_tokens: 5, total_tokens: 1005, cached_tokens: 900, cache_write_tokens: 90 });
});

test("OpenAI-style usage keeps prompt_tokens as the cached-inclusive total", () => {
  expect(normalizeUsage({ prompt_tokens: 100, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 60 } }))
    .toEqual({ prompt_tokens: 100, completion_tokens: 3, total_tokens: 103, cached_tokens: 60, cache_write_tokens: 0 });
});
describe("prompt cache routing", () => {
  const chatgpt = { provider: "chatgpt", model: "gpt-6-luna", effort: "low" };
  const sse = () => new Response(
    `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [], usage: {} } })}\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );
  async function sentBody(selection: typeof chatgpt, trace?: { channel: string; agent: string; round: number }) {
    let body: Json = {};
    const client = new LlmClient(
      loadConfig({
        PROVIDER: "custom", LLM_BASE_URL: "https://example.com/v1", LLM_API_KEY: "secret-test", LLM_MODEL: "test-model",
        WEB_API_URL: "https://api.example.com", WEB_INTERNAL_TOKEN: "internal",
      }),
      async (url, init) => {
        if (url.endsWith("/internal/chatgpt/credential"))
          return Response.json({ access_token: "token", account_id: "account" });
        body = JSON.parse(String(init?.body));
        return url.endsWith("/responses") ? sse() : response({ role: "assistant", content: "ok" });
      },
    );
    await client.complete(selection, [{ role: "user", content: "hi" }], [], { trace });
    return body;
  }
  test("a ChatGPT conversation sends one stable key per channel", async () => {
    const root = await sentBody(chatgpt, { channel: "111", agent: "root", round: 0 });
    const later = await sentBody(chatgpt, { channel: "111", agent: "child-ab12cd34", round: 3 });
    const other = await sentBody(chatgpt, { channel: "222", agent: "root", round: 0 });
    expect(root.prompt_cache_key).toMatch(/^[0-9a-f]{32}$/);
    expect(later.prompt_cache_key).toBe(root.prompt_cache_key);
    expect(other.prompt_cache_key).not.toBe(root.prompt_cache_key);
    // The provider gets a digest, never the Discord channel id.
    expect(String(root.prompt_cache_key)).not.toContain("111");
  });
  test("requests outside a conversation and other protocols carry no key", async () => {
    expect((await sentBody(chatgpt)).prompt_cache_key).toBeUndefined();
    const custom = await sentBody({ provider: "custom", model: "test-model", effort: "none" }, { channel: "111", agent: "root", round: 0 });
    expect(custom.prompt_cache_key).toBeUndefined();
  });
});

describe("Anthropic server-side web tools (#46)", () => {
  const cfg = () => loadConfig({ ANTHROPIC_API_KEY: "fixture", CLAUDE_MAX_API_KEY: "fixture" });
  test("exa auto selects provider-native search for the Anthropic API but not Claude Max", () => {
    expect(nativeSearchFor({ provider: "anthropic", model: "claude-sonnet-5-5" }, "auto", true)).toBe(true);
    expect(nativeSearchFor({ provider: "deepseek", model: "deepseek-chat" }, "auto", true)).toBe(true);
    expect(nativeSearchFor({ provider: "claude_max", model: "claude-opus-5-5" }, "auto", true)).toBe(false);
    expect(nativeSearchFor({ provider: "anthropic", model: "claude-sonnet-5-5" }, "on", true)).toBe(false);
    expect(nativeSearchFor({ provider: "anthropic", model: "claude-sonnet-5-5" }, "auto", false)).toBe(false);
  });

  test("native search adds capped web_search and web_fetch with the model's tool version", async () => {
    let body: Json = {};
    const client = new LlmClient(cfg(), async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return Response.json({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" });
    });
    const types = () => (body.tools as Json[]).map(t => [t.type, t.name, t.max_uses]);
    await client.complete({ provider: "anthropic", model: "claude-sonnet-5-5" }, [{ role: "user", content: "Hi" }], [tool], { nativeSearch: true });
    expect(types()).toEqual([
      [undefined, "lookup", undefined],
      ["web_search_20260209", "web_search", 10],
      ["web_fetch_20260209", "web_fetch", 10],
    ]);
    await client.complete({ provider: "anthropic", model: "claude-haiku-5-5" }, [{ role: "user", content: "Hi" }], [], { nativeSearch: true });
    expect(types()).toEqual([["web_search_20250305", "web_search", 10], ["web_fetch_20250910", "web_fetch", 10]]);
    await client.complete({ provider: "anthropic", model: "claude-sonnet-5-5" }, [{ role: "user", content: "Hi" }], [tool]);
    expect(types()).toEqual([[undefined, "lookup", undefined]]);
    await client.complete({ provider: "claude_max", model: "claude-opus-5-5" }, [{ role: "user", content: "Hi" }], [tool], { nativeSearch: true });
    expect(types()).toEqual([[undefined, "lookup", undefined]]);
  });

  test("pause_turn is resumed with the paused assistant content and merged into one completion", async () => {
    const bodies: Json[] = [];
    const paused = [
      { type: "text", text: "Searching." },
      { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "hibana" } },
      { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [] },
    ];
    const client = new LlmClient(cfg(), async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json(bodies.length === 1
        ? { content: paused, stop_reason: "pause_turn", usage: { input_tokens: 10, output_tokens: 2 } }
        : { content: [{ type: "text", text: "Found it." }], stop_reason: "end_turn", usage: { input_tokens: 20, output_tokens: 3 } });
    });
    const out = await client.complete(
      { provider: "anthropic", model: "claude-sonnet-5-5" }, [{ role: "user", content: "Find hibana" }], [], { nativeSearch: true },
    );
    expect(bodies).toHaveLength(2);
    expect((bodies[1].messages as Json[]).at(-1)).toEqual({ role: "assistant", content: paused });
    expect(out.message.content).toBe("Searching.\nFound it.");
    expect(out.message.tool_calls).toBeUndefined();
    expect(out.message.providerBlocks).toEqual([...paused, { type: "text", text: "Found it." }]);
    expect(out.usage.prompt_tokens).toBe(30);
    expect(out.usage.completion_tokens).toBe(5);
  });
});

test("Anthropic stream keeps server tool input and text citations", async () => {
  const sse = [
    ["message_start", { type: "message_start", message: { usage: { input_tokens: 5 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: {} } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"query\":\"hibana\"}" } }],
    ["content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "citations_delta", citation: { type: "web_search_result_location", url: "https://example.com" } } }],
    ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Cited." } }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }],
    ["message_stop", { type: "message_stop" }],
  ].map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
  const client = new LlmClient(loadConfig({ ANTHROPIC_API_KEY: "fixture" }), async () =>
    new Response(sse, { headers: { "content-type": "text/event-stream" } }));
  const out = await client.complete({ provider: "anthropic", model: "claude-sonnet-5-5" }, [{ role: "user", content: "Hi" }], []);
  expect(out.message.content).toBe("Cited.");
  expect(out.message.tool_calls).toBeUndefined();
  expect(out.message.providerBlocks).toEqual([
    { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "hibana" } },
    { type: "text", text: "Cited.", citations: [{ type: "web_search_result_location", url: "https://example.com" }] },
  ]);
});

// The frames claude-sonnet-5-5 and claude-haiku-5-5 sent for a call without
// arguments (#42): the only input delta is an empty string.
test("Anthropic stream accepts a tool call without arguments", async () => {
  const sse = [
    ["message_start", { type: "message_start", message: { usage: { input_tokens: 5 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "lookup", input: {} } }],
    ["ping", { type: "ping" }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "" } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 2 } }],
    ["message_stop", { type: "message_stop" }],
  ].map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
  let requests = 0;
  const client = new LlmClient(loadConfig({ ANTHROPIC_API_KEY: "fixture" }), async () => {
    requests++;
    return new Response(sse, { headers: { "content-type": "text/event-stream" } });
  }, { sleep: async () => {} });
  const out = await client.complete({ provider: "anthropic", model: "claude-sonnet-5-5" }, [{ role: "user", content: "Hi" }], [tool]);
  expect(out.message.tool_calls).toEqual([
    { id: "toolu_1", type: "function", function: { name: "lookup", arguments: "{}" } },
  ]);
  expect(out.message.providerBlocks).toEqual([{ type: "tool_use", id: "toolu_1", name: "lookup", input: {} }]);
  expect(requests).toBe(1);
});

test("Anthropic stream still rejects a tool input that ends mid-JSON", async () => {
  const sse = [
    ["message_start", { type: "message_start", message: { usage: { input_tokens: 5 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "lookup", input: {} } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"key\":" } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 2 } }],
    ["message_stop", { type: "message_stop" }],
  ].map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
  let requests = 0;
  const client = new LlmClient(loadConfig({ ANTHROPIC_API_KEY: "fixture" }), async () => {
    requests++;
    return new Response(sse, { headers: { "content-type": "text/event-stream" } });
  }, { sleep: async () => {} });
  const failure = await client.complete({ provider: "anthropic", model: "claude-sonnet-5-5" }, [{ role: "user", content: "Hi" }], [tool])
    .catch((error) => error);
  expect(failure.diagnostics).toMatchObject({ phase: "stream", reason: "invalid_json", retries: 5 });
  // The initial request and five reconnects; a half-received call never runs.
  expect(requests).toBe(6);
});

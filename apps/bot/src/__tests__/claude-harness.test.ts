import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "discord.js";
import pino from "pino";
import { Agent, type AgentOptions } from "../agent";
import { Hibana } from "../bot";
import { stripThinking, statusLine } from "../claude/progress";
import { claudeSystem, contextBlock, contextMessage } from "../claude/prompt";
import { conversationKey, harnessFor, keyHarness } from "../claude/select";
import { loadConfig } from "../config";
import { ConversationStore } from "../conversation-store";
import { History } from "../history";
import { LlmClient, parseCompletion, toAnthropic, type RequestRecord } from "../llm";
import { apiFailure } from "../llm-errors";
import { Runtime } from "../runtime";
import { ToolRegistry } from "../tools";
import { emptyUsage, ToolOutput, type Context, type Json, type Message, type ToolDef } from "../types";

// The Claude harness (#66) end to end below the Discord client: what is sent
// to Anthropic, how the loop treats what comes back, how a conversation is
// kept, and what a whole turn looks like. No request leaves the process.

const dir = await mkdtemp(join(tmpdir(), "hibana-claude-"));
afterAll(() => rm(dir, { recursive: true, force: true }));
const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  PROVIDER: "anthropic", LLM_MODEL: "claude-haiku-5-5", ANTHROPIC_API_KEY: "fixture", CLAUDE_MAX_API_KEY: "fixture",
  SANDBOX_ENABLED: "false", SKILLS_ENABLED: "false", RUNTIME_STATE_PATH: "", LOG_DIR: "",
  PERSONA_FILE: join(dir, "no-persona.md"), ...extra,
});
const opus = { provider: "anthropic", model: "claude-opus-5-5", effort: "high" };
const haiku = { provider: "anthropic", model: "claude-haiku-5-5", effort: "medium" };
const context = (extra: Partial<Context> = {}): Context => ({
  channelId: "10", userId: "20", botId: "30", thread: false, depth: 0, delivered: false, harness: "claude", ...extra,
});
const tool = (name: string, defer = false): ToolDef => ({
  type: "function",
  function: { name, description: `${name} tool`, parameters: { type: "object", properties: {} } },
  ...(defer && { defer: true }),
});

type Block = Record<string, unknown>;
/** An Anthropic streaming response made of whole content blocks. */
function stream(content: Block[], stop = "end_turn", usage: Json = { input_tokens: 100, output_tokens: 20 }) {
  const events: Json[] = [{ type: "message_start", message: { usage } }];
  content.forEach((block, index) => {
    if (block.type === "tool_use") {
      events.push({ type: "content_block_start", index, content_block: { ...block, input: {} } });
      events.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
    } else events.push({ type: "content_block_start", index, content_block: block });
    events.push({ type: "content_block_stop", index });
  });
  events.push({ type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: usage.output_tokens } });
  events.push({ type: "message_stop" });
  return new Response(events.map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}
const rejected = (message: string) =>
  Response.json({ type: "error", error: { type: "invalid_request_error", message } }, { status: 400 });
const text = (value: string): Block => ({ type: "text", text: value });
const use = (id: string, name: string, input: Json = {}): Block => ({ type: "tool_use", id, name, input });

type Sent = { headers: Record<string, string>; body: Json };
/** A client whose provider answers from a script, recording each request. */
function scripted(replies: (Response | (() => Response))[], extra: NodeJS.ProcessEnv = {}, hooks: ConstructorParameters<typeof LlmClient>[2] = {}) {
  const sent: Sent[] = [];
  const client = new LlmClient(loadConfig(env(extra)), async (_url, init) => {
    sent.push({ headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
    const reply = replies.shift();
    if (!reply) throw new Error("the script has no more replies");
    return typeof reply === "function" ? reply() : reply;
  }, { sleep: async () => {}, ...hooks });
  return { client, sent };
}

describe("which harness a turn runs on", () => {
  test("only Anthropic's own API runs on the Claude harness, and one setting takes it back", () => {
    const on = loadConfig(env()), off = loadConfig(env({ ANTHROPIC_HARNESS: "codex" }));
    expect(harnessFor({ provider: "anthropic" }, on)).toBe("claude");
    for (const provider of ["claude_max", "claude_kiro", "codex_plus", "chatgpt", "openrouter", "custom"])
      expect(harnessFor({ provider }, on)).toBe("codex");
    expect(harnessFor({ provider: "anthropic" }, off)).toBe("codex");
  });

  test("a conversation is filed under its harness, and the Codex key is the one it always was", () => {
    expect(conversationKey(opus, "codex")).toBe(JSON.stringify(opus));
    expect(conversationKey(opus, "claude")).not.toBe(conversationKey(opus, "codex"));
    expect(keyHarness(conversationKey(opus, "claude"))).toBe("claude");
    expect(keyHarness(conversationKey(opus, "codex"))).toBe("codex");
    // Checkpoints written before the Claude harness existed.
    expect(keyHarness(JSON.stringify([opus, "auto"]))).toBe("codex");
    expect(keyHarness("not json")).toBe("codex");
  });
});

describe("the request", () => {
  const conversation: Message[] = [
    { role: "system", content: "System text." },
    { role: "user", content: "Hello", turnStart: true },
    { role: "assistant", content: "", providerBlocks: [use("toolu_1", "Read", { file_path: "a.txt" })], tool_calls: [{ id: "toolu_1", type: "function", function: { name: "Read", arguments: '{"file_path":"a.txt"}' } }] },
    { role: "tool", tool_call_id: "toolu_1", content: "No such file: a.txt", is_error: true },
    { role: "developer", content: "Late note.", sticky: true },
  ];
  const tools = [tool("Read"), tool("mcp__discord__pin_message", true)];
  const request = async (selection: typeof opus, options: Json = { claude: true }, extra: NodeJS.ProcessEnv = {}, messages = conversation) => {
    const { client, sent } = scripted([stream([text("ok")])], extra);
    await client.complete(selection, structuredClone(messages), tools, options);
    return sent[0]!;
  };

  test("asks Opus 5.5 for tool search, its between-tool notes, an explicit effort and room to think", async () => {
    const { headers, body } = await request(opus);
    expect(body.tools).toEqual([
      { type: "tool_search_tool_bm25_20251119", name: "tool_search_tool_bm25" },
      { name: "Read", description: "Read tool", input_schema: { type: "object", properties: {} } },
      { name: "mcp__discord__pin_message", description: "mcp__discord__pin_message tool", input_schema: { type: "object", properties: {} }, defer_loading: true },
    ]);
    expect(body.thinking).toEqual({ type: "adaptive", display: "updates" });
    expect(headers["anthropic-beta"]).toBe("thinking-display-updates-2026-08-18");
    expect(body.output_config).toEqual({ effort: "high" });
    expect(body.max_tokens).toBe(64000);
    expect(body.system).toEqual([{ type: "text", text: "System text.", cache_control: { type: "ephemeral", ttl: "1h" } }]);
    expect(headers.Authorization).toBeUndefined();
  });

  test("gives Haiku 5.5 the same room and keeps a later note in the conversation, where it was sent", async () => {
    const { headers, body } = await request(haiku);
    expect(body.max_tokens).toBe(64000);
    // Haiku 5.5 does not take the `updates` display; it writes notes as text.
    expect(body.thinking).toEqual({ type: "adaptive" });
    expect(headers["anthropic-beta"]).toBeUndefined();
    expect(body.output_config).toEqual({ effort: "medium" });
    // Moved into `system`, the note would change the head of every request.
    expect((body.system as Json[])[0]!.text).toBe("System text.");
    expect((body.messages as Json[]).at(-1)).toEqual({ role: "system", content: [{ type: "text", text: "Late note." }] });
    // Thinking cannot be switched off here; "none" means the cheapest level.
    expect((await request({ ...haiku, effort: "none" })).body).toMatchObject({ thinking: { type: "adaptive" }, output_config: { effort: "low" } });
  });

  test("sends a failed tool result as a failure, and an image inside the result it belongs to", () => {
    const { messages } = toAnthropic([
      { role: "tool", tool_call_id: "a", content: "boom", is_error: true },
      { role: "tool", tool_call_id: "b", content: "Image dot.png (70 bytes)", images: ["data:image/png;base64,AAAA"] },
      { role: "tool", tool_call_id: "c", content: "plain" },
    ]);
    expect(messages).toEqual([{ role: "user", content: [
      { type: "tool_result", tool_use_id: "a", content: "boom", is_error: true },
      { type: "tool_result", tool_use_id: "b", content: [
        { type: "text", text: "Image dot.png (70 bytes)" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
      ] },
      { type: "tool_result", tool_use_id: "c", content: "plain" },
    ] }]);
  });

  test("leaves the Codex-style harness and the Claude Max gateway as they were", async () => {
    const legacy = await request(opus, {});
    expect((legacy.body.tools as Json[]).map((t) => t.name)).toEqual(["Read", "mcp__discord__pin_message"]);
    expect(JSON.stringify(legacy.body)).not.toContain("defer_loading");
    expect(legacy.body.thinking).toEqual({ type: "adaptive" });
    expect(legacy.headers["anthropic-beta"]).toBeUndefined();
    const max = { provider: "claude_max", model: "claude-opus-5-5", effort: "high" };
    expect((await request(max, { claude: true })).body).toEqual((await request(max, {})).body);
  });

  test("sends every definition up front when tool search is switched off", async () => {
    const { body } = await request(opus, { claude: true }, { CLAUDE_TOOL_SEARCH: "false" });
    expect((body.tools as Json[]).map((t) => t.name)).toEqual(["Read", "mcp__discord__pin_message"]);
    expect(JSON.stringify(body.tools)).not.toContain("defer_loading");
  });

  test("names the summary beta when it asks for a summary and whenever the conversation carries one", async () => {
    const asking = await request(haiku, { claude: true, compaction: true });
    expect(asking.body.compaction).toEqual({ type: "summarize" });
    expect(asking.headers["anthropic-beta"]).toBe("compact-2026-09-04");
    const summary: Message = { role: "assistant", content: "", providerBlocks: [{ type: "compaction", content: "So far.", signature: "sig" }] };
    const carrying = await request(opus, { claude: true }, {}, [conversation[0]!, summary, { role: "user", content: "Next", turnStart: true }]);
    expect(carrying.body.compaction).toBeUndefined();
    expect(carrying.headers["anthropic-beta"]).toBe("thinking-display-updates-2026-08-18,compact-2026-09-04");
    // The signed block goes back first, exactly as it came.
    expect((carrying.body.messages as Json[])[0]).toEqual({ role: "assistant", content: [{ type: "compaction", content: "So far.", signature: "sig" }] });
  });

  test("goes on without a feature Anthropic rejects, and stops asking for it", async () => {
    const dropped: string[] = [];
    const { client, sent } = scripted([
      rejected("tools.2.defer_loading: Extra inputs are not permitted"),
      stream([text("ok")]),
      rejected("thinking.display: Input should be 'summarized' or 'omitted'; 'updates' requires thinking-display-updates-2026-08-18"),
      stream([text("ok")]),
      stream([text("ok")]),
    ], {}, { onFeatureDisabled: (feature) => dropped.push(feature) });
    await client.complete(opus, structuredClone(conversation), tools, { claude: true });
    await client.complete(opus, structuredClone(conversation), tools, { claude: true });
    await client.complete(opus, structuredClone(conversation), tools, { claude: true });
    expect(dropped).toEqual(["tool_search", "thinking_updates"]);
    expect(sent).toHaveLength(5);
    expect(JSON.stringify(sent[1]!.body.tools)).not.toMatch(/defer_loading|tool_search/);
    expect(sent[3]!.body.thinking).toEqual({ type: "adaptive" });
    expect(sent[4]!.headers["anthropic-beta"]).toBeUndefined();
    expect((sent[4]!.body.tools as Json[]).map((t) => t.name)).toEqual(["Read", "mcp__discord__pin_message"]);
  });
});

describe("the response", () => {
  test("a note written before tool calls is the status line, and a summary is recognized", () => {
    const noted = parseCompletion({ stop_reason: "tool_use", usage: {}, content: [
      { type: "thinking", thinking: "", signature: "a" },
      { type: "thinking", thinking: "Checking the config first.", signature: "b" },
      use("toolu_1", "Read", { file_path: "a" }),
    ] }, "anthropic");
    expect(noted.progress).toBe("Checking the config first.");
    expect(parseCompletion({ stop_reason: "end_turn", usage: {}, content: [text("hi")] }, "anthropic").progress).toBeUndefined();
    const summary = parseCompletion({ stop_reason: "compaction", content: [{ type: "compaction", content: "So far.", signature: "s" }],
      usage: { input_tokens: 0, output_tokens: 0, iterations: [{ type: "compaction", input_tokens: 144, output_tokens: 276 }] } }, "anthropic");
    expect(summary).toMatchObject({ compacted: true, usage: { prompt_tokens: 144, completion_tokens: 276 } });
    // 200 with nothing in it: the call was made but wrote no summary.
    expect(parseCompletion({ stop_reason: "compaction", content: [], usage: {} }, "anthropic").compacted).toBe(false);
  });

  test("names what a rejection is about without keeping its text", () => {
    const binding = apiFailure({ type: "invalid_request_error", message: "messages.5.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation. Remove the block." });
    expect(binding).toMatchObject({ kind: "invalid_request", feature: "thinking_binding" });
    expect(JSON.stringify(binding.diagnostics)).not.toContain("signature");
    expect(apiFailure({ type: "invalid_request_error", message: "prompt is too long: 1200000 tokens > 1000000 maximum" }).kind).toBe("context_length");
    expect(apiFailure({ type: "invalid_request_error", message: "max_tokens: Input should be less than 128000" }).feature).toBeUndefined();
    expect(apiFailure({ type: "api_error", message: "Internal server error" })).toMatchObject({ kind: "transient", retryable: true });
    expect(apiFailure({ type: "timeout_error", message: "Request timed out" }).retryable).toBe(true);
    expect(() => parseCompletion({ stop_reason: "model_context_window_exceeded", content: [], usage: {} }, "anthropic")).toThrow("context_length");
  });

  test("a request the model declined is recorded with what it used", async () => {
    const records: RequestRecord[] = [];
    const { client } = scripted([stream([], "refusal", { input_tokens: 900, output_tokens: 0 })], {}, { onCompletion: (r) => records.push(r) });
    await expect(client.complete(haiku, [{ role: "user", content: "Hi" }], [], { claude: true })).rejects.toThrow("refusal");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ refused: true, model: "claude-haiku-5-5", usage: { prompt_tokens: 900 } });
  });
});

describe("the loop", () => {
  const run = (client: LlmClient, execute: AgentOptions["execute"], extra: Partial<AgentOptions> = {}, ctx = context()) =>
    new Agent(client).run({
      selection: haiku, messages: [{ role: "system", content: "S" }, { role: "user", content: "Go", turnStart: true }],
      tools: [tool("Read"), tool("Bash")], context: ctx, maxRounds: 16, temperature: 0, nativeSearch: false, execute, ...extra,
    });
  const results = (messages: Message[]) => messages.filter((m) => m.role === "tool");

  test("writes a tool result as the tool's own text, a failure as a flag, and an image into its result", async () => {
    const { client, sent } = scripted([
      stream([use("t1", "Read", { file_path: "a.txt" }), use("t2", "Read", { file_path: "b.txt" }), use("t3", "Bash", { command: "ls" }), use("t4", "Bash", { command: "shot" })], "tool_use"),
      stream([text("done")]),
    ]);
    const ctx = context({ pendingImages: [] });
    const out = await run(client, async (name, args) => {
      if (args.file_path === "a.txt") return new ToolOutput('     1\tconst a = "x";');
      if (args.file_path === "b.txt") throw new Error("No such file: b.txt");
      if (args.command === "shot") { ctx.pendingImages!.push("data:image/png;base64,AAAA"); return { ok: true }; }
      return new ToolOutput("exit 2", { isError: true });
    }, {}, ctx);
    expect(out.text).toBe("done");
    expect(results(out.messages)).toEqual([
      { role: "tool", tool_call_id: "t1", content: '     1\tconst a = "x";' },
      { role: "tool", tool_call_id: "t2", content: "No such file: b.txt", is_error: true },
      { role: "tool", tool_call_id: "t3", content: "exit 2", is_error: true },
      { role: "tool", tool_call_id: "t4", content: '{"ok":true}', images: ["data:image/png;base64,AAAA"] },
    ]);
    // Nothing is left for the other harness's "Images loaded" message.
    expect(out.messages.some((m) => m.content?.startsWith("Images loaded"))).toBe(false);
    // All results of one response go back in one user message.
    const turns = sent[1]!.body.messages as { role: string; content: Json[] }[];
    expect(turns.at(-1)!.content.map((b) => b.type)).toEqual(["tool_result", "tool_result", "tool_result", "tool_result"]);
    expect(sent[1]!.body.max_tokens).toBe(64000);
  });

  test("refuses the same call a third time in a row, and not when other work came between", async () => {
    const again = () => stream([use(crypto.randomUUID(), "Bash", { command: "bun test" })], "tool_use");
    const { client } = scripted([again(), again(), again(), stream([use("e", "Read", { file_path: "x" })], "tool_use"), again(), stream([text("done")])]);
    const out = await run(client, async () => new ToolOutput("1 fail"));
    expect(results(out.messages).map((m) => m.is_error ?? false)).toEqual([false, false, true, false, false]);
    expect(results(out.messages)[2]!.content).toContain("twice in a row");
  });

  test("discards a response that the output limit cut inside a tool call, and says why", async () => {
    const cut = () => new Response([
      { type: "message_start", message: { usage: { input_tokens: 10 } } },
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "c1", name: "Bash", input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"command":"cat <<EOF' } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 64000 } },
      { type: "message_stop" },
    ].map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    const { client, sent } = scripted([cut(), stream([text("done in smaller steps")])]);
    let ran = 0;
    const out = await run(client, async () => { ran++; return new ToolOutput(""); });
    expect(ran).toBe(0);
    expect(sent).toHaveLength(2);
    expect(out.text).toBe("done in smaller steps");
    expect(out.messages.filter((m) => m.role === "assistant")).toHaveLength(1);
    expect(out.messages.find((m) => m.internal)!.content).toContain("reached the output limit in the middle of a tool call");
    // The discarded response was still generated and is still counted.
    expect(out.usage.completion_tokens).toBe(64020);
  });

  test("sends the history once more without thinking blocks when Anthropic rejects them", async () => {
    const { client, sent } = scripted([
      rejected("messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation."),
      stream([text("carried on")]),
    ]);
    let stripped = 0;
    const out = await run(client, async () => null, {
      onThinkingStripped: () => { stripped++; },
      messages: [
        { role: "system", content: "S" },
        { role: "user", content: "Earlier", turnStart: true },
        { role: "assistant", content: "Hi", providerBlocks: [{ type: "thinking", thinking: "", signature: "old" }, text("Hi")] },
        { role: "user", content: "Go", turnStart: true },
      ],
    });
    expect(out.text).toBe("carried on");
    expect(stripped).toBe(1);
    expect(JSON.stringify(sent[0]!.body.messages)).toContain('"signature":"old"');
    expect(JSON.stringify(sent[1]!.body.messages)).not.toContain("thinking");
    // Only once: a second rejection is something else and fails the turn.
    const twice = scripted([rejected("The block is bound to a different conversation."), rejected("The block is bound to a different conversation.")]);
    await expect(run(twice.client, async () => null, {
      messages: [{ role: "user", content: "Go" }, { role: "assistant", content: "", providerBlocks: [{ type: "thinking", thinking: "", signature: "x" }, text("a")] }, { role: "user", content: "More" }],
    })).rejects.toThrow("invalid_request");
  });

  test("shows the model's note as status, or says what the tool call is when there is none", async () => {
    const shown: string[] = [];
    const ctx = context({ progress: async (line) => { shown.push(line); } });
    const { client } = scripted([
      stream([{ type: "thinking", thinking: "Looking at the tests.", signature: "s" }, use("a", "Bash", { command: "bun test", description: "テストを実行" })], "tool_use"),
      stream([use("b", "Read", { file_path: "src/app.ts" }), use("c", "Read", { file_path: "src/b.ts" })], "tool_use"),
      stream([text("Fixing it."), use("d", "Bash", { command: "x" })], "tool_use"),
      stream([text("done")]),
    ]);
    const out = await run(client, async () => new ToolOutput("ok"), {}, ctx);
    expect(shown).toEqual(["Looking at the tests.", "読み込み: src/app.ts（ほか 1 件）", "Fixing it."]);
    // The size the next request starts from: the last request, not the sum.
    expect(out.context).toBe(120);
    expect(out.usage.prompt_tokens).toBe(400);
    expect(statusLine([{ id: "x", type: "function", function: { name: "mcp__discord__pin_message", arguments: "{}" } }])).toBe("ツール: pin_message");
  });

  test("removing thinking keeps an assistant turn sendable", () => {
    const messages: Message[] = [
      { role: "assistant", content: "", providerBlocks: [{ type: "thinking", thinking: "", signature: "a" }, { type: "redacted_thinking", data: "x" }] },
      { role: "assistant", content: "kept", providerBlocks: [text("kept")] },
    ];
    expect(stripThinking(messages)).toBe(true);
    expect(messages[0]!.providerBlocks).toEqual([text("(no visible output)")]);
    expect(stripThinking(messages)).toBe(false);
  });
});

describe("the stored conversation", () => {
  const usage = { ...emptyUsage(), prompt_tokens: 10 };
  const history = (store?: ConversationStore) =>
    new History(loadConfig(env({ HISTORY_MAX_TOKENS: "1000", HISTORY_KEEP_TOKENS: "100" })), store);
  const turn = (i: number): Message[] => [{ role: "user", content: `question ${i} ${"x".repeat(900)}`, turnStart: true }, { role: "assistant", content: `answer ${i}` }];

  test("is never cut at the head, unlike the other harness's", () => {
    const h = history();
    for (const [id, appendOnly] of [["claude", true], ["codex", false]] as const) {
      h.get(id, undefined, "k", false, 0, appendOnly);
      for (let i = 0; i < 8; i++) h.put(id, turn(i), usage);
    }
    expect(h.get("claude", undefined, "k", false, 0, true)).toHaveLength(16);
    expect(h.get("codex", undefined, "k", false, 0).length).toBeLessThan(16);
  });

  test("keeps images, the size of its last request, and a summary in place of what it summarizes", async () => {
    const store = new ConversationStore(join(dir, "c.db"));
    store.open();
    const h = history(store);
    h.get("1", "g", "k", false, 0, true);
    h.put("1", [{ role: "user", content: "look", images: ["data:image/png;base64,AAAA"], turnStart: true }, { role: "assistant", content: "seen" }], { ...usage, context_tokens: 190_000 }, true);
    const stored = h.get("1", "g", "k", false, 0, true);
    expect(stored[0]!.images).toEqual(["data:image/png;base64,AAAA"]);
    expect(h.contextTokens("1")).toBe(190_000);
    const summary: Message[] = [{ role: "assistant", content: "", providerBlocks: [{ type: "compaction", content: "So far.", signature: "s" }] }];
    // Made from a conversation that has since changed: not applied.
    expect(h.replace("1", [...stored, { role: "user", content: "newer" }], summary)).toBe(false);
    expect(h.replace("1", stored, summary)).toBe(true);
    expect(h.contextTokens("1")).toBeUndefined();
    // What a restart reads back is the summary alone.
    const reopened = new History(loadConfig(env()), store);
    expect(reopened.get("1", "g", "k", false, 0, true)).toEqual(summary);
    store.close();
  });

  test("rewrites what is stored when thinking blocks have to go", () => {
    const store = new ConversationStore(join(dir, "r.db"));
    store.open();
    const h = history(store);
    h.get("1", undefined, "k", false, 0, true);
    h.put("1", [{ role: "user", content: "a", turnStart: true }, { role: "assistant", content: "b", providerBlocks: [{ type: "thinking", thinking: "", signature: "s" }, text("b")] }], usage);
    h.put("1", [{ role: "user", content: "c", turnStart: true }, { role: "assistant", content: "d" }], usage);
    h.rewrite("1", stripThinking);
    const reopened = new History(loadConfig(env()), store).get("1", undefined, "k", false, 0, true);
    expect(reopened.map((m) => m.content)).toEqual(["a", "b", "c", "d"]);
    expect(JSON.stringify(reopened)).not.toContain("thinking");
    store.close();
  });
});

describe("the prompt", () => {
  test("is the same text for every server, person and model", async () => {
    const runtime = new Runtime(loadConfig(env()));
    const system = await claudeSystem(runtime);
    expect(system.role).toBe("system");
    expect(system.content).toContain("You are the agent behind Hibana");
    expect(system.content).toContain("# This deployment");
    // Written for this harness: none of the other one's instructions, and no
    // tool is named, so adding or removing one never leaves a stale mention.
    expect(system.content).not.toMatch(/Codex|apply_patch|shell_command|AGENTS\.md/);
    // (Read, Edit and Write are also ordinary words, so those are looked for
    // in the form a tool name would take.)
    for (const name of ["Bash", "Glob", "Grep", "AskUserQuestion", "send_file", "publish_site", "mcp__", "`Read`", "`Edit`", "`Write`", "`Agent`", "`Skill`"])
      expect(system.content).not.toContain(name);
    runtime.snapshot.user_overrides.someone = { ...runtime.snapshot.user_overrides.someone!, context: { text: "Call me Aki.", persona_override: false } } as never;
    expect((await claudeSystem(runtime)).content).toBe(system.content);
  });

  test("carries who the bot is here in the conversation, once, and again only when it changed", async () => {
    const runtime = new Runtime(loadConfig(env()));
    const ctx = context({ guildId: "1" });
    const block = await contextBlock(runtime, ctx, "- video-edit: Cut and join clips.");
    expect(block).toBe([
      "<hibana_context>",
      "<persona>\nYou are Hibana (火花), a helpful Discord assistant. Respond naturally in Japanese unless asked otherwise.\n</persona>",
      "<workspace>\n/workspace belongs to this server.\n</workspace>",
      "<skills>\n- video-edit: Cut and join clips.\n</skills>",
      "</hibana_context>",
    ].join("\n"));
    expect(await contextBlock(runtime, context({ thread: true }), "")).toContain("/workspace belongs to this thread.");
    expect(await contextBlock(runtime, context(), "")).toContain("this direct-message conversation");
    const first = contextMessage(block, [])!;
    expect(first).toEqual({ role: "user", internal: true, content: block });
    const conversation = [first, { role: "user" as const, content: "hi", turnStart: true }];
    expect(contextMessage(block, conversation)).toBeUndefined();
    expect(contextMessage(block.replace("video-edit", "audio-edit"), conversation)!.content).toContain("audio-edit");
    // A summary replaced the conversation, and the block with it.
    expect(contextMessage(block, [{ role: "assistant", content: "", providerBlocks: [{ type: "compaction" }] }])).toBeDefined();
  });
});

describe("a turn", () => {
  type Call = { selection: { model: string }; messages: Message[]; tools: ToolDef[]; options: Json };
  async function bot(extra: NodeJS.ProcessEnv = {}) {
    const data = await mkdtemp(join(dir, "bot-"));
    const hibana = new Hibana(loadConfig(env({ HIBANA_DATA_DIR: data, ...extra })), pino({ enabled: false }));
    const sent: string[] = [];
    hibana.client.channels.fetch = (async () => ({
      id: "10", isSendable: () => true, sendTyping: async () => {},
      send: async (value: { content: string }) => { sent.push(value.content); return { id: "40", edit: async () => {} }; },
    })) as never;
    hibana.runtime.snapshot.user_roles["20"] = "premium";
    hibana.tools.sandbox.available = true;
    const calls: Call[] = [];
    let reply: (call: Call) => Awaited<ReturnType<LlmClient["complete"]>> = () =>
      ({ message: { role: "assistant", content: "ok" }, usage: { ...emptyUsage(), prompt_tokens: 500, completion_tokens: 20 }, incomplete: false });
    hibana.llm.complete = (async (selection, messages, tools, options) => {
      const call = { selection, messages: structuredClone(messages), tools, options: (options ?? {}) as Json };
      calls.push(call);
      return reply(call);
    }) as LlmClient["complete"];
    const ctx: Context = { channelId: "10", userId: "20", botId: "30", thread: false, depth: 0, delivered: false };
    return { hibana, sent, calls, ctx, script: (next: typeof reply) => { reply = next; } };
  }
  const today = new Date().toISOString().slice(0, 10);

  test("starts with the Claude prompt, the context block and the dated message, on Claude Code's tools", async () => {
    const { hibana, calls, ctx, sent } = await bot();
    try {
      await hibana.respond("こんにちは\n\n[author: Aki; user_id: 20; channel_id: 10; message_id: 1]", { ...ctx });
      expect(sent).toEqual(["ok"]);
      const [first] = calls;
      expect(first!.options.claude).toBe(true);
      expect(first!.messages.map((m) => m.role)).toEqual(["system", "user", "user"]);
      expect(first!.messages[0]!.content).toContain("You are the agent behind Hibana");
      expect(first!.messages[1]!.content!.startsWith("<hibana_context>")).toBe(true);
      expect(first!.messages[2]!.content).toBe(`こんにちは\n\n[author: Aki; user_id: 20; channel_id: 10; message_id: 1]\n[date: ${today}]`);
      const names = first!.tools.map((t) => t.function.name);
      expect(names.slice(0, 8)).toEqual(["Bash", "Read", "Edit", "Write", "Glob", "Grep", "AskUserQuestion", "Agent"]);
      expect(names).not.toContain("shell_command");
      expect(names).not.toContain("apply_patch");
      // The second turn appends to the first: one context block, both turns.
      await hibana.respond("続き", { ...ctx });
      const second = calls[1]!.messages;
      expect(second.filter((m) => m.content?.startsWith("<hibana_context>"))).toHaveLength(1);
      expect(second.map((m) => m.role)).toEqual(["system", "user", "user", "assistant", "user"]);
      expect(JSON.stringify(second.slice(0, 3))).toBe(JSON.stringify(first!.messages));
    } finally { await hibana.close(); }
  });

  test("with ANTHROPIC_HARNESS=codex runs as it did before", async () => {
    const { hibana, calls, ctx } = await bot({ ANTHROPIC_HARNESS: "codex" });
    try {
      await hibana.respond("こんにちは", { ...ctx });
      expect(calls[0]!.options.claude).toBe(false);
      expect(calls[0]!.messages[0]!.content).toContain("Codex CLI");
      expect(calls[0]!.messages.at(-1)!.content).toBe("こんにちは");
      expect(calls[0]!.tools.map((t) => t.function.name)).toContain("shell_command");
    } finally { await hibana.close(); }
  });

  test("replaces a conversation that has grown past its budget with the API's summary before going on", async () => {
    const { hibana, calls, ctx, script } = await bot({ CLAUDE_COMPACT_TOKENS_HAIKU: "10000" });
    try {
      script(() => ({ message: { role: "assistant", content: "long answer" }, usage: { ...emptyUsage(), prompt_tokens: 12_000, completion_tokens: 500 }, incomplete: false }));
      await hibana.respond("最初の依頼", { ...ctx });
      const block = { type: "compaction", content: "The user asked for X; it is done.", signature: "sig" };
      script((call) => call.options.compaction
        ? { message: { role: "assistant", content: "", providerBlocks: [block] }, usage: { ...emptyUsage(), prompt_tokens: 12_600, completion_tokens: 300 }, incomplete: false, compacted: true }
        : { message: { role: "assistant", content: "ok" }, usage: { ...emptyUsage(), prompt_tokens: 900, completion_tokens: 10 }, incomplete: false });
      await hibana.respond("次の依頼", { ...ctx });
      const [, summarize, next] = calls;
      // The summary is asked for over exactly what the last turn sent: same
      // prompt, same tools, the conversation so far and nothing added.
      expect(summarize!.options).toMatchObject({ claude: true, compaction: true });
      expect(summarize!.messages.map((m) => m.role)).toEqual(["system", "user", "user", "assistant"]);
      expect(summarize!.tools.map((t) => t.function.name)).toEqual(calls[0]!.tools.map((t) => t.function.name));
      // Then the summary stands for the conversation, and the context block,
      // which the summary swallowed, is sent again.
      expect(next!.messages.map((m) => m.role)).toEqual(["system", "assistant", "user", "user"]);
      expect(next!.messages[1]!.providerBlocks).toEqual([block]);
      expect(next!.messages[2]!.content!.startsWith("<hibana_context>")).toBe(true);
      // A short conversation is left alone.
      await hibana.respond("もう一つ", { ...ctx });
      expect(calls).toHaveLength(4);
      expect(calls[3]!.options.compaction).toBeUndefined();
    } finally { await hibana.close(); }
  });

  test("asks for a summary in the conversation itself when the API's is unavailable, and goes on unsummarized when that fails too", async () => {
    const { hibana, calls, ctx, script } = await bot({ CLAUDE_COMPACT_TOKENS_HAIKU: "10000" });
    try {
      const big = { ...emptyUsage(), prompt_tokens: 12_000, completion_tokens: 500 };
      script(() => ({ message: { role: "assistant", content: "long answer" }, usage: big, incomplete: false }));
      await hibana.respond("最初の依頼", { ...ctx });
      script((call) => {
        if (call.options.compaction) throw new Error("unavailable");
        const asked = call.messages.at(-1)!.content?.includes("Write that summary now");
        return { message: { role: "assistant", content: asked ? "X is done; Y is open." : "ok" }, usage: big, incomplete: false };
      });
      await hibana.respond("次の依頼", { ...ctx });
      expect(calls[3]!.messages.map((m) => m.role)).toEqual(["system", "user", "user", "user"]);
      expect(calls[3]!.messages[1]!.content).toBe("<conversation_summary>\nX is done; Y is open.\n</conversation_summary>");
      // Both ways fail: the turn still runs, on the conversation as it was.
      script((call) => {
        if (call.options.compaction || call.messages.at(-1)!.content?.includes("Write that summary now")) throw new Error("unavailable");
        return { message: { role: "assistant", content: "ok" }, usage: big, incomplete: false };
      });
      const before = calls.length;
      await hibana.respond("三つ目", { ...ctx });
      const last = calls.at(-1)!;
      expect(calls.length).toBe(before + 3);
      expect(last.messages.at(-1)!.content).toContain("三つ目");
      expect(last.messages.some((m) => m.content?.includes("次の依頼"))).toBe(true);
    } finally { await hibana.close(); }
  });

  test("does not continue the other harness's conversation or checkpoint", async () => {
    const data = await mkdtemp(join(dir, "switch-"));
    // Two bots over one data directory, as a restart with the setting changed.
    const start = (harness: string) => bot({ HIBANA_DATA_DIR: data, ANTHROPIC_HARNESS: harness });
    const codex = await start("codex");
    try {
      codex.hibana.conversations.open();
      await codex.hibana.respond("旧ハーネスでの依頼", { ...codex.ctx });
    } finally { await codex.hibana.close(); }
    const claude = await start("claude");
    try {
      claude.hibana.conversations.open();
      await claude.hibana.respond("新ハーネスでの依頼", { ...claude.ctx });
      expect(JSON.stringify(claude.calls[0]!.messages)).not.toContain("旧ハーネスでの依頼");
      expect(claude.calls[0]!.messages.map((m) => m.role)).toEqual(["system", "user", "user"]);
    } finally { await claude.hibana.close(); }
  });
});

describe("subagents", () => {
  async function registry(extra: NodeJS.ProcessEnv = {}, replies: Response[] = []) {
    const runtime = new Runtime(loadConfig(env(extra)));
    const { client, sent } = scripted(replies, extra);
    const discord = new Client({ intents: [] });
    const tools = new ToolRegistry(runtime, discord, new Agent(client));
    tools.sandbox.available = true;
    return { runtime, tools, sent, close: async () => { await tools.close(); discord.destroy(); } };
  }
  const call = (subagent_type: string, description = "find it") => ({ description, prompt: "Where is the config?", subagent_type });

  test("an Explore subagent gets the task and nothing else, on the small model, with read-only tools", async () => {
    const { tools, sent, close } = await registry({}, [stream([text("It is in config.ts:12.")], "end_turn", { input_tokens: 300, output_tokens: 40 })]);
    try {
      const spent = emptyUsage();
      const parent = context({ rootSelection: opus, recordToolUsage: (u) => { spent.prompt_tokens += u.prompt_tokens; } });
      const out = await tools.execute("Agent", call("Explore"), parent) as ToolOutput;
      expect(out.text).toBe("It is in config.ts:12.");
      const { body } = sent[0]!;
      expect(body.model).toBe("claude-haiku-5-5");
      expect((body.system as Json[])[0]!.text).toContain("You are a research subagent of Hibana");
      const turns = body.messages as { role: string; content: Json[] }[];
      expect(turns).toHaveLength(1);
      expect(String(turns[0]!.content[0]!.text).startsWith("Where is the config?\n\n[date: ")).toBe(true);
      const names = (body.tools as Json[]).map((t) => String(t.name));
      expect(names).toEqual(expect.arrayContaining(["Read", "Glob", "Grep"]));
      for (const hidden of ["Bash", "Edit", "Write", "Agent", "AskUserQuestion", "mcp__workspace__send_file"]) expect(names).not.toContain(hidden);
      // Its spend is charged to the turn that started it.
      expect(spent.prompt_tokens).toBe(300);
      expect(parent.agentCalls).toEqual({ count: 1 });
    } finally { await close(); }
  });

  test("a general-purpose subagent runs on the turn's model with the shell and file tools", async () => {
    const { tools, sent, close } = await registry({}, [stream([text("Built and tested.")])]);
    try {
      await tools.execute("Agent", call("general-purpose"), context({ rootSelection: opus }));
      expect(sent[0]!.body.model).toBe("claude-opus-5-5");
      const names = (sent[0]!.body.tools as Json[]).map((t) => String(t.name));
      expect(names).toEqual(expect.arrayContaining(["Bash", "Read", "Edit", "Write"]));
      for (const hidden of ["Agent", "AskUserQuestion", "mcp__workspace__send_file", "mcp__discord__send_message"]) expect(names).not.toContain(hidden);
    } finally { await close(); }
  });

  test("is refused past the turn's limit, from inside a subagent, and when subagents are off", async () => {
    const limited = await registry({ CLAUDE_AGENTS_PER_TURN: "1" }, [stream([text("one")])]);
    try {
      const parent = context({ rootSelection: haiku });
      await limited.tools.execute("Agent", call("Explore"), parent);
      await expect(limited.tools.execute("Agent", call("Explore"), parent)).rejects.toThrow("already started 1 subagents");
      // The tool is not on a subagent's list at all, whatever it sends.
      await expect(limited.tools.execute("Agent", call("Explore"), context({ depth: 1, agentRole: "worker" }))).rejects.toThrow("cannot use Agent");
    } finally { await limited.close(); }
    const off = await registry({ SUBAGENT_ENABLED: "false" });
    try {
      expect(off.tools.tools(context()).map((t) => t.function.name)).not.toContain("Agent");
      await expect(off.tools.execute("Agent", call("Explore"), context())).rejects.toThrow("not available");
    } finally { await off.close(); }
  });

  test("a subagent that runs out of rounds returns an error, not a silent stop", async () => {
    const loop = () => stream([use(crypto.randomUUID(), "Read", { file_path: `${crypto.randomUUID()}.txt` })], "tool_use");
    const { tools, close } = await registry({ CLAUDE_AGENT_MAX_ROUNDS: "2" }, [loop(), loop()]);
    try {
      await expect(tools.execute("Agent", call("Explore"), context({ rootSelection: haiku }))).rejects.toThrow("stopped without a report");
    } finally { await close(); }
  });
});

describe("who may call what", () => {
  test("everyone in a conversation is shown the same tools, and a tool still checks who is calling", async () => {
    const runtime = new Runtime(loadConfig(env({ VPN_ENABLED: "true" })));
    const discord = new Client({ intents: [] });
    const tools = new ToolRegistry(runtime, discord, new Agent(new LlmClient(runtime.config)));
    try {
      runtime.snapshot.user_roles.admin = "administrator";
      const admin = context({ userId: "admin" }), member = context({ userId: "member" });
      const names = (ctx: Context) => tools.tools(ctx).map((t) => t.function.name);
      // A list that changed with the speaker would change the head of every
      // request in a shared channel.
      expect(names(member)).toEqual(names(admin));
      expect(names(member)).toContain("mcp__discord__vpn_status");
      await expect(tools.execute("mcp__discord__vpn_status", {}, member)).rejects.toThrow("not available to you");
      // Names from the other harness, or made up, are not callable here.
      await expect(tools.execute("shell_command", { command: "ls" }, admin)).rejects.toThrow("not available to you");
      await expect(tools.execute("mcp__workspace__bash", { command: "ls" }, admin)).rejects.toThrow("not available to you");
      await expect(tools.execute("Read", { path: "a.txt" }, admin)).rejects.toThrow("not available to you");
    } finally { await tools.close(); discord.destroy(); }
  });

  test("arguments are checked against the tool's own schema before it runs", async () => {
    const runtime = new Runtime(loadConfig(env()));
    const discord = new Client({ intents: [] });
    const tools = new ToolRegistry(runtime, discord, new Agent(new LlmClient(runtime.config)));
    tools.sandbox.available = true;
    try {
      await expect(tools.execute("Read", { path: "a.txt" }, context())).rejects.toThrow("Invalid arguments for Read");
      await expect(tools.execute("Bash", { command: "ls", timeout: 999_999 }, context())).rejects.toThrow("Invalid arguments for Bash");
      await expect(tools.execute("Edit", { file_path: "a", old_string: "", new_string: "b" }, context())).rejects.toThrow("Invalid arguments for Edit");
    } finally { await tools.close(); discord.destroy(); }
  });
});

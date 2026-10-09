import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pino from "pino";
import { checkpointSnapshot, checkpointInScope, resumeCheckpoint } from "../checkpoint";
import { Hibana } from "../bot";
import { loadConfig } from "../config";
import { toAnthropic, toChatMessages, toResponses } from "../llm";
import type { Context, Message, Json } from "../types";

const ctx: Context = { channelId: "10000", userId: "20000", botId: "30000", thread: false, depth: 0, delivered: false };
const selection = { provider: "custom", model: "test", effort: "high" };
const prefix: Message[] = [{ role: "system", content: "current policy" }, { role: "user", content: "# AGENTS.md instructions\n<INSTRUCTIONS>current</INSTRUCTIONS>" }];
const call = (id: string) => ({ id, type: "function" as const, function: { name: "mutate", arguments: "{}" } });
const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cached_tokens: 0 };

describe("checkpoint recovery", () => {
  test("saved memory is an immutable snapshot matching durable state", () => {
    const messages: Message[] = [{ role: "user", content: "task" }, { role: "assistant", content: null, tool_calls: [call("a")] }];
    const saved = checkpointSnapshot({ ...ctx, progress: async () => {}, recordToolUsage: () => {} }, messages, 0, JSON.stringify(selection));
    messages[1]!.tool_calls![0]!.function.arguments = "changed";
    messages.push({ role: "assistant", content: "unsaved" });
    expect(saved.messages).toHaveLength(2);
    expect(saved.messages[1]?.tool_calls?.[0]?.function.arguments).toBe("{}");
    expect(saved.ctx).not.toHaveProperty("progress");
    expect(saved.ctx).not.toHaveProperty("recordToolUsage");
  });
  test("missing batch results are marked unknown; orphan results never go to the provider", () => {
    const messages: Message[] = [
      { role: "user", content: "task" },
      { role: "assistant", content: null, tool_calls: [call("a"), call("b")] },
      { role: "tool", tool_call_id: "a", content: "saved mutation" },
      { role: "user", content: "continue" },
      { role: "tool", tool_call_id: "orphan", content: "wrong" },
    ];
    const cp = checkpointSnapshot(ctx, messages, 0, JSON.stringify(selection));
    const resumed = resumeCheckpoint(cp, prefix, selection).messages;
    expect(resumed.filter(m => m.role === "tool")).toHaveLength(2);
    expect(resumed.find(m => m.tool_call_id === "a")?.content).toBe("saved mutation");
    expect(JSON.parse(resumed.find(m => m.tool_call_id === "b")!.content!).outcome).toBe("unknown");
    expect(resumed.at(-1)?.content).toBe("continue");
  });
  test("effort and object property order changes preserve opaque provider state", () => {
    const blocks = [{ type: "reasoning", encrypted_content: "opaque" }];
    const cp = checkpointSnapshot(ctx, [{ role: "assistant", content: "done", providerBlocks: blocks, reasoning_content: "thought" }], 0,
      JSON.stringify({ effort: "low", model: selection.model, provider: selection.provider }));
    const resumed = resumeCheckpoint(cp, prefix, selection);
    expect(resumed.messages.at(-1)?.providerBlocks).toEqual(blocks);
    expect(resumed.messages.at(-1)?.reasoning_content).toBe("thought");
  });
  test("provider/model changes preserve task and results using portable messages", () => {
    const cp = checkpointSnapshot({ ...ctx, delivered: true }, [
      { role: "system", content: "old policy" },
      { role: "user", content: "# AGENTS.md instructions\n<INSTRUCTIONS>old</INSTRUCTIONS>" },
      { role: "user", content: "original request", turnStart: true },
      { role: "assistant", content: null, providerBlocks: [{ encrypted_content: "old" }], reasoning_content: "old", tool_calls: [call("a")] },
      { role: "tool", tool_call_id: "a", content: "already saved" },
      { role: "developer", content: "stale mode" },
    ], 2, JSON.stringify(selection));
    const resumed = resumeCheckpoint(cp, prefix, { ...selection, model: "replacement" });
    expect(resumed.historyStart).toBe(prefix.length);
    expect(resumed.messages.some(m => m.content === "original request")).toBe(true);
    expect(resumed.messages.some(m => m.content === "old policy" || m.content === "stale mode")).toBe(false);
    expect(resumed.messages.some(m => m.providerBlocks || m.reasoning_content)).toBe(false);
    expect(toResponses(resumed.messages).input).toContainEqual({ type: "function_call_output", call_id: "a", output: "already saved" });
  });
  test("retry cannot import another user, guild, channel, or DM checkpoint", () => {
    const cp = checkpointSnapshot(ctx, [], 0, JSON.stringify(selection));
    expect(checkpointInScope(cp, ctx)).toBe(true);
    for (const patch of [{ userId: "other" }, { guildId: "other" }, { channelId: "other" }, { thread: true }])
      expect(checkpointInScope(cp, { ...ctx, ...patch })).toBe(false);
  });
  test("non-developer chat APIs receive policy before the user/tool conversation", () => {
    const wire = toChatMessages([
      { role: "system", content: "base" },
      { role: "user", content: "task" },
      { role: "developer", content: "root mode" },
      { role: "assistant", content: null, tool_calls: [call("a")] },
      { role: "tool", tool_call_id: "a", content: "saved" },
      { role: "developer", content: "new mode" },
    ]);
    expect(wire.map(m => m.role)).toEqual(["system", "user", "assistant", "tool"]);
    expect(wire[0]?.content).toBe("base\n\nroot mode\n\nnew mode");
    expect(wire[2]?.tool_calls).toEqual([call("a")]);
  });
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "hibana-retry-"));
  const bot = new Hibana(loadConfig({
    HIBANA_DATA_DIR: dir, PROVIDER: "custom", LLM_BASE_URL: "https://example.com/v1",
    LLM_API_KEY: "key", LLM_MODEL: "test", SANDBOX_ENABLED: "false", SKILLS_ENABLED: "false",
    LOG_DIR: "", SUBAGENT_ENABLED: "false",
  }), pino({ enabled: false }));
  const sent: string[] = [];
  bot.client.channels.fetch = (async () => ({
    id: ctx.channelId, isSendable: () => true, sendTyping: async () => {},
    send: async (value: { content: string }) => {
      sent.push(value.content);
      const i = sent.length - 1;
      return { id: "40000", edit: async (next: { content: string }) => { sent[i] = next.content; } };
    },
  })) as never;
  bot.tools.tools = () => [{ type: "function", function: { name: "mutate", description: "mutation", parameters: { type: "object", properties: {} } } }];
  return { bot, dir, sent, cleanup: async () => { await bot.close(); await rm(dir, { recursive: true, force: true }); } };
}

test("/retry after an HTTP failure reuses completed tool results and clears the checkpoint on success", async () => {
  const f = await fixture();
  let executions = 0, rounds = 0;
  f.bot.tools.execute = async () => { executions++; return "saved"; };
  f.bot.llm.complete = async (_selection, messages) => {
    if (++rounds === 1) return { message: { role: "assistant", content: null, tool_calls: [call("a")] }, usage, incomplete: false };
    if (rounds === 2) throw new Error("HTTP 524");
    expect(messages.find(m => m.tool_call_id === "a")?.content).toBe('"saved"');
    return { message: { role: "assistant", content: "resumed" }, usage, incomplete: false };
  };
  try {
    expect(await f.bot.respond("do the task", ctx)).toBe("");
    const cp = Object.values(await Bun.file(join(f.dir, "retry_checkpoints.json")).json())[0] as { messages: Message[] };
    expect(cp.messages.at(-1)?.role).toBe("tool");
    await f.bot.retry(ctx);
    expect(f.sent.at(-1)).toBe("resumed");
    expect(executions).toBe(1);
    expect(await Bun.file(join(f.dir, "retry_checkpoints.json")).json()).toEqual({});
  } finally { await f.cleanup(); }
});

// Production 2026-10-09 (#50): a checkpoint whose last message was the drafted
// answer went to Anthropic as-is, which rejects it as assistant prefill (HTTP 400).
test("/retry of a checkpoint ending in an undelivered answer ends the request with a user turn", async () => {
  const f = await fixture();
  const channel = await f.bot.client.channels.fetch(ctx.channelId) as unknown as { send: (value: { content: string }) => Promise<unknown> };
  const deliver = channel.send;
  let sends = 0;
  // Only the first delivery fails, so the failure notice still goes out.
  channel.send = async value => { if (++sends === 1) throw new Error("Discord unavailable"); return deliver(value); };
  f.bot.client.channels.fetch = (async () => channel) as never;
  const last: string[] = [];
  f.bot.llm.complete = async (_selection, messages) => {
    last.push(toAnthropic(messages).messages.at(-1)!.role);
    return { message: { role: "assistant", content: last.length === 1 ? "draft" : "resumed" }, usage, incomplete: false };
  };
  try {
    expect(await f.bot.respond("do the task", ctx)).toBe("");
    const cp = Object.values(await Bun.file(join(f.dir, "retry_checkpoints.json")).json())[0] as { messages: Message[] };
    expect(cp.messages.at(-1)).toMatchObject({ role: "assistant", content: "draft" });
    await f.bot.retry(ctx);
    expect(last).toEqual(["user", "user"]);
    expect(f.sent.at(-1)).toBe("resumed");
    expect(await Bun.file(join(f.dir, "retry_checkpoints.json")).json()).toEqual({});
  } finally { await f.cleanup(); }
});

test("/retry succeeds after changing model and carries the original task and delivery state", async () => {
  const f = await fixture();
  let rounds = 0;
  f.bot.tools.execute = async (_name, _args, context) => { context.delivered = true; return "file sent"; };
  f.bot.llm.complete = async (selected, messages) => {
    if (++rounds === 1) return { message: { role: "assistant", content: null, tool_calls: [call("a")] }, usage, incomplete: false };
    if (rounds === 2) throw new Error("HTTP 404");
    expect(selected.model).toBe("replacement");
    expect(messages.some(m => m.content === "send the file")).toBe(true);
    expect(messages.some(m => m.tool_call_id === "a")).toBe(true);
    return { message: { role: "assistant", content: "ファイルを送信しました。" }, usage, incomplete: false };
  };
  try {
    await f.bot.respond("send the file", ctx);
    f.bot.config.selection = { ...f.bot.config.selection, model: "replacement" };
    await f.bot.retry(ctx);
    expect(rounds).toBe(3); // No false "delivery has not succeeded" nudge.
    expect(f.sent.at(-1)).toBe("ファイルを送信しました。");
  } finally { await f.cleanup(); }
});

test("a mid-batch checkpoint contains the first result before the second side effect starts", async () => {
  const f = await fixture();
  let rounds = 0, executions = 0;
  f.bot.llm.complete = async () => ++rounds === 1
    ? { message: { role: "assistant", content: null, tool_calls: [call("a"), call("b")] }, usage, incomplete: false }
    : { message: { role: "assistant", content: "done" }, usage, incomplete: false };
  f.bot.tools.execute = async () => {
    executions++;
    const cp = Object.values(await Bun.file(join(f.dir, "retry_checkpoints.json")).json())[0] as { messages: Message[] };
    expect(cp.messages.find(m => m.tool_calls)?.tool_calls).toHaveLength(2);
    if (executions === 1) expect(cp.messages.filter(m => m.role === "tool")).toHaveLength(0);
    else expect(cp.messages.find(m => m.tool_call_id === "a")?.content).toBe('"saved"');
    return "saved";
  };
  try {
    expect(await f.bot.respond("task", ctx)).toBe("done");
    expect(executions).toBe(2);
  } finally { await f.cleanup(); }
});

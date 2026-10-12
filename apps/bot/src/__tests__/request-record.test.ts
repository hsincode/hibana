import { expect, test } from "bun:test";
import { Agent } from "../agent";
import { loadConfig } from "../config";
import { LlmClient, usageDetail, type RequestRecord } from "../llm";
import type { Context, Message } from "../types";

// The request log is what a before/after comparison of the harness reads
// (#69): which turn a request belongs to, and the parts of Anthropic's usage
// that are billed by something other than a token count.

const anthropic = () =>
  loadConfig({ PROVIDER: "anthropic", ANTHROPIC_API_KEY: "fixture", SANDBOX_ENABLED: "false", SKILLS_ENABLED: "false", RUNTIME_STATE_PATH: "" });
const stream = (events: Record<string, unknown>[]) =>
  new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
const answer = (start: Record<string, unknown>, end: Record<string, unknown>) => stream([
  { type: "message_start", message: { usage: start } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: end },
  { type: "message_stop" },
]);
const ask: Message[] = [{ role: "user", content: "Hello" }];
const context = (turnId?: string): Context => ({
  channelId: "c1", userId: "u1", botId: "bot", thread: false, depth: 0, delivered: false, turnId,
});

test("an Anthropic request records cache writes by TTL and server tool requests", async () => {
  const records: RequestRecord[] = [];
  const client = new LlmClient(anthropic(), async () => answer(
    {
      input_tokens: 10, cache_read_input_tokens: 500, cache_creation_input_tokens: 120,
      cache_creation: { ephemeral_5m_input_tokens: 20, ephemeral_1h_input_tokens: 100 },
    },
    { output_tokens: 7, server_tool_use: { web_search_requests: 2, web_fetch_requests: 0 } },
  ), { onCompletion: (r) => records.push(r) });
  await client.complete({ provider: "anthropic", model: "claude-haiku-5-5", effort: "high" }, ask, []);
  expect(records).toHaveLength(1);
  expect(records[0]!.usage_detail).toEqual({
    cache_write_5m_tokens: 20, cache_write_1h_tokens: 100, web_search_requests: 2, web_fetch_requests: 0,
  });
  // The token totals the ledger prices are unchanged by the extra fields.
  expect(records[0]!.usage).toMatchObject({ prompt_tokens: 630, completion_tokens: 7, cached_tokens: 500, cache_write_tokens: 120 });
});

test("a request without those fields logs no usage detail", async () => {
  expect(usageDetail({ prompt_tokens: 12, completion_tokens: 3 })).toBeUndefined();
  expect(usageDetail()).toBeUndefined();
  // A provider that sends something else under the same key is not trusted.
  expect(usageDetail({ cache_creation: { ephemeral_1h_input_tokens: "100" }, server_tool_use: null })).toBeUndefined();
  const records: RequestRecord[] = [];
  const client = new LlmClient(anthropic(), async () => answer({ input_tokens: 10 }, { output_tokens: 7 }),
    { onCompletion: (r) => records.push(r) });
  await client.complete({ provider: "anthropic", model: "claude-haiku-5-5", effort: "high" }, ask, []);
  expect("usage_detail" in records[0]!).toBe(false);
});

test("every request of a turn carries the turn id, and it never reaches the provider", async () => {
  const records: RequestRecord[] = [];
  const bodies: string[] = [];
  const client = new LlmClient(anthropic(), async (_url, init) => {
    bodies.push(String(init?.body) + JSON.stringify(init?.headers));
    return answer({ input_tokens: 10 }, { output_tokens: 7 });
  }, { onCompletion: (r) => records.push(r) });
  const run = (ctx: Context) => new Agent(client).run({
    selection: { provider: "anthropic", model: "claude-haiku-5-5", effort: "high" },
    messages: ask, tools: [], context: ctx, maxRounds: 4, temperature: 0, nativeSearch: false,
    execute: async () => null,
  });
  await run(context("turn-a"));
  // A child's context is a copy of its parent's, so it reports the same turn.
  await run({ ...context("turn-a"), depth: 1 });
  await run(context());
  expect(records.map((r) => r.turn)).toEqual(["turn-a", "turn-a", undefined]);
  expect(bodies.join("")).not.toContain("turn-a");
});

test("a checkpoint does not store the turn id", async () => {
  const { checkpointSnapshot } = await import("../checkpoint");
  const saved = checkpointSnapshot(context("turn-a"), ask, 0, "key");
  expect("turnId" in saved.ctx).toBe(false);
  expect(saved.ctx).toEqual(context());
});

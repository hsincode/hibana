import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { anthropicCost } from "@hibana/shared/catalog";
import { loadConfig } from "../config";
import { LlmClient, type RequestRecord } from "../llm";
import { UsageLedger } from "../usage-ledger";
import type { Message } from "../types";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "hibana-usage-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const record = (over: Partial<RequestRecord> = {}): RequestRecord => ({
  provider: "anthropic", model: "claude-sonnet-5-5", protocol: "anthropic",
  usage: { prompt_tokens: 1_000_000, completion_tokens: 100_000, total_tokens: 1_100_000, cached_tokens: 600_000, cache_write_tokens: 100_000 },
  usage_reported: true, latency_ms: 1, ...over,
});
const at = (iso: string) => () => new Date(iso);

test("prices each token kind at its own rate", () => {
  // Sonnet 5.5: 300k uncached × $2 + 100k 1h writes × $4 + 600k reads × $0.10 + 100k output × $10.
  expect(anthropicCost("claude-sonnet-5-5", { prompt: 1_000_000, cache_read: 600_000, cache_write: 100_000, output: 100_000 }))
    .toBeCloseTo(0.6 + 0.4 + 0.06 + 1.0, 10);
  expect(anthropicCost("claude-opus-5-5", { prompt: 1_000_000, cache_read: 0, cache_write: 0, output: 1_000_000 })).toBeCloseTo(24, 10);
  expect(anthropicCost("claude-unknown", { prompt: 1, cache_read: 0, cache_write: 0, output: 1 })).toBeUndefined();
});

test("Haiku 5.5 bills the whole request at the long rate once the prompt, cache included, exceeds 100k", () => {
  const short = anthropicCost("claude-haiku-5-5", { prompt: 100_000, cache_read: 90_000, cache_write: 0, output: 0 });
  expect(short).toBeCloseTo((10_000 * 0.1 + 90_000 * 0.01) / 1e6, 12);
  const long = anthropicCost("claude-haiku-5-5", { prompt: 100_001, cache_read: 90_000, cache_write: 0, output: 1000 });
  expect(long).toBeCloseTo((10_001 * 0.5 + 90_000 * 0.05 + 1000 * 2.5) / 1e6, 12);
});

test("records only Anthropic API requests and keeps unknown figures apart", () => {
  const ledger = new UsageLedger(join(dir, "u.json"), at("2026-10-09T12:00:00Z"));
  ledger.record(record());
  // Claude Max is a subscription: it must not count as API spend.
  ledger.record(record({ provider: "claude_max" }));
  ledger.record(record({ usage_reported: false }));
  ledger.record(record({ model: "claude-new-model" }));
  const s = ledger.summary();
  expect(s.today).toEqual({ cost_usd: 2.06, requests: 3, unpriced_requests: 1, unreported_requests: 1 });
  expect(s.month_by_model["claude-sonnet-5-5"]).toMatchObject({
    requests: 2, cost_usd: 2.06, input_tokens: 300_000, cache_read_tokens: 600_000,
    cache_write_tokens: 100_000, output_tokens: 100_000, unreported_requests: 1,
  });
});

test("groups by UTC day and month", () => {
  let now = "2026-09-30T23:59:59Z";
  const ledger = new UsageLedger(join(dir, "u.json"), () => new Date(now));
  ledger.record(record());
  now = "2026-10-01T00:00:00Z";
  ledger.record(record({ model: "claude-opus-5-5" }));
  const s = ledger.summary();
  expect(s.month.month).toBe("2026-10");
  expect(s.month.requests).toBe(1);
  expect(s.today.requests).toBe(1);
  expect(s.last_7_days["2026-09-30"]).toBe(2.06);
  expect(Object.keys(s.last_7_days)).toHaveLength(7);
});

test("persists across restarts and merges requests made before the file loaded", async () => {
  const path = join(dir, "u.json");
  const first = new UsageLedger(path, at("2026-10-09T00:00:00Z"));
  await first.load();
  first.record(record());
  await first.flush();
  const second = new UsageLedger(path, at("2026-10-09T01:00:00Z"));
  second.record(record());
  // Nothing is written before load: that write would erase the stored day.
  await second.flush();
  expect(JSON.parse(await readFile(path, "utf8")).days["2026-10-09"]["claude-sonnet-5-5"].requests).toBe(1);
  await second.load();
  await second.flush();
  expect(second.summary().today.requests).toBe(2);
  expect(JSON.parse(await readFile(path, "utf8")).days["2026-10-09"]["claude-sonnet-5-5"].requests).toBe(2);
});

test("a damaged file is never overwritten", async () => {
  const path = join(dir, "u.json");
  await writeFile(path, "{broken");
  const ledger = new UsageLedger(path, at("2026-10-09T00:00:00Z"));
  await expect(ledger.load()).rejects.toThrow();
  ledger.record(record());
  await ledger.flush();
  expect(await readFile(path, "utf8")).toBe("{broken");
  expect(ledger.summary().today.requests).toBe(1);
});

test("drops days older than the retention window", async () => {
  let now = "2025-01-01T00:00:00Z";
  const path = join(dir, "u.json");
  const ledger = new UsageLedger(path, () => new Date(now));
  await ledger.load();
  ledger.record(record());
  now = "2026-10-09T00:00:00Z";
  ledger.record(record());
  await ledger.flush();
  expect(Object.keys(JSON.parse(await readFile(path, "utf8")).days)).toEqual(["2026-10-09"]);
});

test("an Anthropic stream's usage reaches the ledger with cache reads and writes", async () => {
  const ledger = new UsageLedger(join(dir, "u.json"), at("2026-10-09T00:00:00Z"));
  const sse = [
    { type: "message_start", message: { usage: { input_tokens: 300_000, cache_read_input_tokens: 600_000, cache_creation_input_tokens: 100_000, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 100_000 } },
    { type: "message_stop" },
  ].map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  const client = new LlmClient(
    loadConfig({ PROVIDER: "anthropic", ANTHROPIC_API_KEY: "fixture", SANDBOX_ENABLED: "false", SKILLS_ENABLED: "false", RUNTIME_STATE_PATH: "" }),
    async () => new Response(sse, { headers: { "content-type": "text/event-stream" } }),
    { onCompletion: (r) => ledger.record(r) },
  );
  const ask: Message[] = [{ role: "user", content: "Hello" }];
  await client.complete({ provider: "anthropic", model: "claude-sonnet-5-5", effort: "high" }, ask, []);
  expect(ledger.summary().today).toEqual({ cost_usd: 2.06, requests: 1 });
});

test("/usage answers only the owner", async () => {
  const { handleCommand } = await import("../commands");
  const ledger = new UsageLedger(join(dir, "u.json"), at("2026-10-09T00:00:00Z"));
  ledger.record(record());
  const runtime = {
    snapshot: { blocked_users: [] },
    role: (id: string) => (id === "owner" ? "administrator" : "moderator"),
  };
  const reply = async (userId: string) => {
    let text = "";
    const i = {
      commandName: "usage", user: { id: userId }, guildId: "g1", channelId: "c1",
      client: { user: { id: "bot" } }, channel: { isThread: () => false },
      options: { getString: () => null, getBoolean: () => null },
      deferReply: async () => {}, reply: async () => {},
      editReply: async (t: string) => { text = t; },
    };
    // Only the fields /usage touches are faked.
    await handleCommand(i as never, runtime as never, {} as never, {} as never, {} as never, async () => {}, ledger);
    return text;
  };
  expect(await reply("moderator-user")).toBe("エラー: このコマンドは owner のみ使用できます。");
  expect(await reply("owner")).toContain('"cost_usd": 2.06');
});

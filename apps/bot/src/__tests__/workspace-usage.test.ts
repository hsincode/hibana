import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { BetaManagedAgentsSessionUsageSnapshot } from "@anthropic-ai/sdk/resources/beta/sessions/events";
import type { BetaManagedAgentsSessionUsage } from "@anthropic-ai/sdk/resources/beta/sessions/sessions";
import {
  WorkspaceUsage,
  sessionTotals,
  totalsDelta,
  totalsMax,
  type LedgerEntry,
  type WorkspaceTotals,
} from "../workspace/usage";

// Decision record: #76. What Anthropic Workspace sessions cost is taken from
// the list cost each session reports, never priced from tokens.

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "hibana-workspace-usage-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const at = (iso: string) => () => new Date(iso);
const totals = (over: Partial<WorkspaceTotals> = {}): WorkspaceTotals => ({
  list_cost_cents: 0, active_seconds: 0, input_tokens: 0, cache_read_tokens: 0,
  cache_write_5m_tokens: 0, cache_write_1h_tokens: 0, output_tokens: 0,
  web_search_requests: 0, web_fetch_requests: 0, ...over,
});
const entry = (over: Partial<LedgerEntry> = {}): LedgerEntry => ({
  model: "claude-haiku-5-5", ultra: false, cost_reported: true,
  delta: totals({ list_cost_cents: 42, active_seconds: 90, input_tokens: 1000, output_tokens: 200 }),
  ...over,
});

test("reads a session's cumulative usage in both shapes the API reports it", () => {
  // As `sessions.retrieve` returns it, and as a `session.usage` event carries it.
  const onSession: BetaManagedAgentsSessionUsage = {
    active_seconds: 754.5,
    cache_creation: { ephemeral_5m_input_tokens: 300, ephemeral_1h_input_tokens: 4000 },
    cache_read_input_tokens: 90_000,
    input_tokens: 12_000,
    list_cost: { amount: "137", currency: "USD" },
    output_tokens: 3400,
    server_tool_use: { web_search_requests: 3, web_fetch_requests: 2 },
  };
  const inEvent: BetaManagedAgentsSessionUsageSnapshot = { ...onSession, list_cost: { amount: "137", currency: "USD" }, server_tool_use: { web_search_requests: 3, web_fetch_requests: 2 } };
  const expected = {
    cost: true,
    totals: {
      list_cost_cents: 137, active_seconds: 754.5, input_tokens: 12_000, cache_read_tokens: 90_000,
      cache_write_5m_tokens: 300, cache_write_1h_tokens: 4000, output_tokens: 3400,
      web_search_requests: 3, web_fetch_requests: 2,
    },
  };
  expect(sessionTotals(onSession)).toEqual(expected);
  expect(sessionTotals(inEvent)).toEqual(expected);
  // A new session reports a cost of zero; that is a cost, not a missing one.
  expect(sessionTotals({ list_cost: { amount: "0", currency: "USD" } })).toEqual({ cost: true, totals: totals() });
  // No list cost yet, none at all, or one that is not whole US cents.
  for (const usage of [
    undefined, null, {}, { list_cost: null },
    { list_cost: { amount: "137", currency: "EUR" } },
    { list_cost: { amount: "1.37", currency: "USD" } },
    { list_cost: { amount: "-5", currency: "USD" } },
    { list_cost: { amount: "", currency: "USD" } },
    { list_cost: { amount: 137 as never, currency: "USD" } },
  ])
    expect(sessionTotals(usage)).toEqual({ cost: false, totals: totals() });
  // The tokens of a session without a cost are still read.
  expect(sessionTotals({ input_tokens: 5, server_tool_use: null, cache_creation: null }))
    .toEqual({ cost: false, totals: totals({ input_tokens: 5 }) });
  // Figures that are not counts add nothing.
  expect(sessionTotals({ input_tokens: -1, output_tokens: Number.NaN, active_seconds: Infinity }).totals).toEqual(totals());
});

test("the delta of two cumulative snapshots never goes negative", () => {
  const before = totals({ list_cost_cents: 100, active_seconds: 60, input_tokens: 5000, output_tokens: 900, web_search_requests: 2 });
  const now = totals({ list_cost_cents: 142, active_seconds: 150, input_tokens: 6000, output_tokens: 1100, web_search_requests: 2 });
  expect(totalsDelta(now, before))
    .toEqual(totals({ list_cost_cents: 42, active_seconds: 90, input_tokens: 1000, output_tokens: 200 }));
  // A session's first turn has nothing before it.
  expect(totalsDelta(now)).toEqual(now);
  expect(totalsDelta(now, null)).toEqual(now);
  expect(totalsDelta(now, now)).toEqual(totals());
  // A reading that is behind the stored one (or lacks the cost) is not a refund.
  expect(totalsDelta(before, now)).toEqual(totals());
  expect(totalsDelta(totals({ input_tokens: 7000 }), now)).toEqual(totals({ input_tokens: 1000 }));
  // A stored row from an older shape, or a damaged one.
  expect(totalsDelta(now, { list_cost_cents: 100 } as WorkspaceTotals).list_cost_cents).toBe(42);
  expect(totalsDelta(now, { list_cost_cents: "100", input_tokens: Number.NaN } as never))
    .toMatchObject({ list_cost_cents: 142, input_tokens: 6000 });

  // What is stored as the next "before" never goes down either, so a reading
  // without a cost cannot make the following one count the same spend twice.
  const unreported = sessionTotals({ input_tokens: 7000 }).totals;
  const kept = totalsMax(unreported, now);
  expect(kept).toEqual({ ...now, input_tokens: 7000 });
  const later = totals({ ...now, list_cost_cents: 150, input_tokens: 7500 });
  expect(totalsDelta(later, kept)).toMatchObject({ list_cost_cents: 8, input_tokens: 500 });
  expect(totalsDelta(later, unreported).list_cost_cents).toBe(150);
  expect(totalsMax(now)).toEqual(now);
});

test("adds each turn's delta to the UTC day and model", () => {
  let now = "2026-09-30T23:59:59Z";
  const usage = new WorkspaceUsage(join(dir, "w.json"), () => new Date(now));
  usage.record(entry({ new_session: true }));
  now = "2026-10-01T00:00:00Z";
  usage.record(entry({ new_session: true }));
  usage.record(entry({ delta: totals({ list_cost_cents: 8, active_seconds: 30, web_search_requests: 2, web_fetch_requests: 1 }) }));
  usage.record(entry({
    model: "claude-opus-5-5",
    delta: totals({ list_cost_cents: 250, cache_read_tokens: 40_000, cache_write_5m_tokens: 10, cache_write_1h_tokens: 20 }),
  }));
  // Haiku Ultra is the same model; its part of the cost is kept apart.
  usage.record(entry({ ultra: true, new_session: true, delta: totals({ list_cost_cents: 300, active_seconds: 3600 }) }));
  // What a session still added when it was closed is spend, but not a turn.
  usage.record(entry({ ultra: true, turn: false, delta: totals({ list_cost_cents: 5 }) }));

  const s = usage.summary();
  expect(s.today).toEqual({ cost_usd: 6.05, turns: 4 });
  expect(s.month).toEqual({ month: "2026-10", cost_usd: 6.05, turns: 4, sessions: 2, active_seconds: 3720, web_search_requests: 2 });
  expect(s.month_by_model).toEqual({
    "claude-haiku-5-5": {
      cost_usd: 3.55, turns: 3, ultra_cost_usd: 3.05, ultra_turns: 1, sessions: 2, active_seconds: 3720,
      input_tokens: 1000, cache_read_tokens: 0, cache_write_5m_tokens: 0, cache_write_1h_tokens: 0, output_tokens: 200,
      web_search_requests: 2, web_fetch_requests: 1,
    },
    "claude-opus-5-5": {
      cost_usd: 2.5, turns: 1, ultra_cost_usd: 0, ultra_turns: 0, sessions: 0, active_seconds: 0,
      input_tokens: 0, cache_read_tokens: 40_000, cache_write_5m_tokens: 10, cache_write_1h_tokens: 20, output_tokens: 0,
      web_search_requests: 0, web_fetch_requests: 0,
    },
  });
  expect(s.last_7_days["2026-10-01"]).toBe(6.05);
  expect(s.last_7_days["2026-09-30"]).toBe(0.42);
  expect(Object.keys(s.last_7_days)).toHaveLength(7);
  // The limits read the same sums, in cents.
  expect(usage.spentCents("day")).toBe(605);
  expect(usage.spentCents("month")).toBe(605);
  now = "2026-10-02T09:00:00Z";
  expect(usage.spentCents("day")).toBe(0);
  expect(usage.spentCents("month")).toBe(605);
  now = "2026-11-01T00:00:00Z";
  expect(usage.spentCents("month")).toBe(0);
});

test("a span without a list cost is counted apart", () => {
  const usage = new WorkspaceUsage(join(dir, "w.json"), at("2026-10-09T12:00:00Z"));
  usage.record(entry());
  // The cost is unknown, not zero: it is never estimated from the tokens,
  // and a figure that came along with it is not trusted either.
  usage.record(entry({ cost_reported: false, delta: totals({ list_cost_cents: 999, input_tokens: 50, active_seconds: 10 }) }));
  usage.record(entry({ ultra: true, cost_reported: false, delta: totals({ list_cost_cents: 999 }) }));
  expect(usage.summary().today).toEqual({ cost_usd: 0.42, turns: 3, unreported_turns: 2 });
  expect(usage.summary().month_by_model["claude-haiku-5-5"]).toMatchObject({
    cost_usd: 0.42, turns: 3, unreported_turns: 2, ultra_cost_usd: 0, ultra_turns: 1, input_tokens: 1050, active_seconds: 100,
  });
  expect(usage.spentCents("day")).toBe(42);
  // Figures that are not counts add nothing and take nothing away.
  usage.record(entry({ delta: totals({ list_cost_cents: -500, input_tokens: Number.NaN, output_tokens: Infinity }) }));
  expect(usage.summary().today).toEqual({ cost_usd: 0.42, turns: 4, unreported_turns: 2 });
  expect(usage.summary().month_by_model["claude-haiku-5-5"]).toMatchObject({ input_tokens: 1050, output_tokens: 200 });
});

test("merges the stored file and survives a reload", async () => {
  const path = join(dir, "w.json");
  const first = new WorkspaceUsage(path, at("2026-10-09T00:00:00Z"));
  expect(first.loaded).toBe(false);
  await first.load();
  expect(first.loaded).toBe(true);
  first.record(entry({ new_session: true }));
  await first.flush();
  const stored = JSON.parse(await readFile(path, "utf8"));
  expect(stored.version).toBe(1);
  expect(stored.days["2026-10-09"]["claude-haiku-5-5"]).toEqual({
    list_cost_cents: 42, active_seconds: 90, input_tokens: 1000, cache_read_tokens: 0,
    cache_write_5m_tokens: 0, cache_write_1h_tokens: 0, output_tokens: 200,
    web_search_requests: 0, web_fetch_requests: 0,
    turns: 1, ultra_turns: 0, sessions: 1, unreported_turns: 0, ultra_list_cost_cents: 0,
  });

  const second = new WorkspaceUsage(path, at("2026-10-09T01:00:00Z"));
  second.record(entry({ ultra: true }));
  // Nothing is written before load: that write would erase the stored day.
  await second.flush();
  expect(JSON.parse(await readFile(path, "utf8")).days["2026-10-09"]["claude-haiku-5-5"].turns).toBe(1);
  // Until then the limits only see what this process recorded.
  expect(second.spentCents("day")).toBe(42);
  await second.load();
  await second.flush();
  expect(second.spentCents("day")).toBe(84);
  expect(second.summary().today).toEqual({ cost_usd: 0.84, turns: 2 });
  expect(JSON.parse(await readFile(path, "utf8")).days["2026-10-09"]["claude-haiku-5-5"])
    .toMatchObject({ turns: 2, ultra_turns: 1, sessions: 1, list_cost_cents: 84, ultra_list_cost_cents: 42 });

  // Days older than the retention are dropped when something is recorded.
  const later = new WorkspaceUsage(path, at("2027-12-01T00:00:00Z"));
  await later.load();
  later.record(entry());
  await later.flush();
  expect(Object.keys(JSON.parse(await readFile(path, "utf8")).days)).toEqual(["2027-12-01"]);
});

test("a ledger file that cannot be read is left as it is and reported", async () => {
  const path = join(dir, "w.json");
  await writeFile(path, "{ not json");
  const errors: unknown[] = [];
  const usage = new WorkspaceUsage(path, at("2026-10-09T00:00:00Z"), (error) => errors.push(error));
  await expect(usage.load()).rejects.toThrow();
  expect(usage.loaded).toBe(false);
  // It still counts in memory, and never replaces the file it could not read.
  usage.record(entry());
  await usage.flush();
  expect(usage.spentCents("day")).toBe(42);
  expect(await readFile(path, "utf8")).toBe("{ not json");
  expect(errors).toEqual([]);

  // A file with values that are not counts is merged without them.
  await writeFile(path, JSON.stringify({ version: 1, days: { "2026-10-09": { "claude-haiku-5-5": { list_cost_cents: "12", turns: 2, input_tokens: -4, extra: 9 } }, "2026-10-08": null } }));
  const repaired = new WorkspaceUsage(path, at("2026-10-09T00:00:00Z"));
  await repaired.load();
  expect(repaired.summary().today).toEqual({ cost_usd: 0, turns: 2 });
  expect(repaired.summary().month_by_model["claude-haiku-5-5"]).toMatchObject({ input_tokens: 0 });
});

test("the lines for /usage read as written, and there are none without a record", () => {
  let now = "2026-10-09T12:00:00Z";
  const usage = new WorkspaceUsage(join(dir, "w.json"), () => new Date(now));
  expect(usage.line()).toBeUndefined();
  usage.record(entry({ delta: totals({ list_cost_cents: 150, active_seconds: 600 }) }));
  expect(usage.line()).toBe([
    "Anthropic Workspace（セッションの list_cost の合計。公開単価での額で、請求額とは一致しないことがあります。日付は UTC）",
    "今日: $1.50 / 1 ターン",
    "2026-10: $1.50 / 1 ターン（稼働 0.2 時間）",
    "  claude-haiku-5-5: $1.50 / 1 ターン",
  ].join("\n"));

  now = "2026-10-10T08:00:00Z";
  usage.record(entry({ model: "claude-opus-5-5", delta: totals({ list_cost_cents: 2500, active_seconds: 9000, web_search_requests: 12 }) }));
  usage.record(entry({ ultra: true, delta: totals({ list_cost_cents: 810, active_seconds: 9120 }) }));
  usage.record(entry({ ultra: true, turn: false, delta: totals({ list_cost_cents: 20 }) }));
  usage.record(entry({ cost_reported: false, delta: totals({ input_tokens: 10 }) }));
  usage.record(entry({ model: "claude-sonnet-5-5", cost_reported: false, delta: totals() }));
  expect(usage.line()).toBe([
    "Anthropic Workspace（セッションの list_cost の合計。公開単価での額で、請求額とは一致しないことがあります。日付は UTC）",
    "今日: $33.30 / 4 ターン",
    "2026-10: $34.80 / 5 ターン（稼働 5.2 時間、web search 12 回）",
    "  claude-opus-5-5: $25.00 / 1 ターン",
    "  claude-haiku-5-5: $9.80 / 3 ターン（うち Ultra $8.30 / 1 ターン）",
    "  claude-sonnet-5-5: $0.00 / 1 ターン",
    "額の報告が無かったターン: 2（合計に入っていません）",
  ].join("\n"));

  // The lines stay short enough to sit above the JSON in one Discord reply,
  // whatever the model ids are.
  for (let i = 0; i < 30; i++)
    usage.record(entry({ model: `vendor/a-rather-long-model-identifier-${i}`, delta: totals({ list_cost_cents: i }) }));
  const long = usage.line()!;
  expect(long.length).toBeLessThanOrEqual(600);
  expect(long).toContain("  claude-opus-5-5: $25.00 / 1 ターン");
  expect(long).toMatch(/\n  ほか \d+ モデル\n額の報告が無かったターン: 2（合計に入っていません）$/);

  // A new month starts empty; the earlier one stays in the file.
  now = "2026-11-01T00:00:00Z";
  expect(usage.line()).toBeUndefined();
  expect(usage.summary().last_7_days).toMatchObject({ "2026-11-01": 0 });
});

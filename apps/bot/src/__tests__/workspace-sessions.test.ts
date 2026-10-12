import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conversationKey } from "../claude/select";
import { loadConfig } from "../config";
import { ConversationStore, SCHEMA } from "../conversation-store";
import { History, type HistoryDrop } from "../history";
import { emptyUsage, type Message } from "../types";
import { SessionTable } from "../workspace/sessions";
import type { WorkspaceTotals } from "../workspace/usage";

// Decision record: #76. An Anthropic Workspace conversation is held by a cloud
// session, and the table is all that finds the session again: to continue it
// after a restart, to lower a spending ceiling a dead process left raised,
// and to remove it once its channel is done with it. "Restart" below is what
// a new process does: a new store and new objects on the file the previous
// ones wrote (as in conversation-store.test.ts). No test calls the API.

const config = loadConfig({
  PROVIDER: "custom", LLM_BASE_URL: "https://example.com/v1", LLM_API_KEY: "fixture", LLM_MODEL: "gpt-test",
});
const haiku = { provider: "anthropic_workspace", model: "claude-haiku-5-5", effort: "medium" };
const key = conversationKey(haiku, "workspace", "plain");
const ultraKey = conversationKey(haiku, "workspace", "ultra");
const START = 1_760_000_000_000;
const totals = (over: Partial<WorkspaceTotals> = {}): WorkspaceTotals => ({
  list_cost_cents: 0, active_seconds: 0, input_tokens: 0, cache_read_tokens: 0,
  cache_write_5m_tokens: 0, cache_write_1h_tokens: 0, output_tokens: 0,
  web_search_requests: 0, web_fetch_requests: 0, ...over,
});
const turn = (text: string): Message[] => [
  { role: "user", content: text, turnStart: true },
  { role: "assistant", content: "ok" },
];
const starts = (messages: Message[]) => messages.filter((m) => m.turnStart).map((m) => m.content);

const dirs: string[] = [];
const stores: ConversationStore[] = [];
afterEach(async () => {
  setSystemTime();
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function dbPath() {
  const dir = await mkdtemp(join(tmpdir(), "hibana-workspace-sessions-"));
  dirs.push(dir);
  return join(dir, "conversations.db");
}
function open(path: string, errors: unknown[] = []) {
  const store = new ConversationStore(path, (e) => errors.push(e));
  store.open();
  stores.push(store);
  return store;
}
type Wire = (history: History, table: SessionTable) => void;
/** One bot process after another on the same file. The table's clock is
 *  `clock.now`; History reads the system time. */
function startBot(path: string, options: { errors?: unknown[]; wire?: Wire } = {}) {
  const clock = { now: START };
  const boot = () => {
    const store = open(path, options.errors);
    const history = new History(config, store);
    const table = new SessionTable(store, () => clock.now);
    options.wire?.(history, table);
    return { store, history, table };
  };
  const bot = {
    clock,
    ...boot(),
    restart() {
      bot.store.close();
      Object.assign(bot, boot());
    },
  };
  return bot;
}
const session = (channelId: string, sessionId: string, guildId?: string) =>
  ({ channelId, guildId, key, sessionId, variant: "plain" as const });
/** What is on disk, read through a second connection while the bot's is open. */
function onDisk(path: string) {
  const raw = new Database(path, { readonly: true });
  try {
    return {
      sessions: raw.query("SELECT session_id, lease_ceiling_cents, lease_at FROM workspace_sessions ORDER BY session_id").all(),
      disposals: raw.query("SELECT session_id, mode, attempts FROM workspace_disposals ORDER BY session_id").all(),
    };
  } finally { raw.close(); }
}

describe("the session table", () => {
  test("a session row survives a restart", async () => {
    const bot = startBot(await dbPath());
    expect(bot.table.get("c1")).toBeUndefined();
    const saved = bot.table.save(session("c1", "sesn_1", "100"));
    expect(saved).toEqual({
      channelId: "c1", guildId: "100", key, sessionId: "sesn_1", variant: "plain", createdAt: START, usedAt: START,
    });
    // A DM has no guild. Haiku Ultra is its own agent, so its own key.
    bot.table.save({ channelId: "dm", key: ultraKey, sessionId: "sesn_2", variant: "ultra" });

    bot.clock.now += 5000;
    const used = totals({ list_cost_cents: 12, active_seconds: 41.5, input_tokens: 9000, output_tokens: 700, web_search_requests: 1 });
    const state = {
      contextDigest: "3f9a", turns: 1, toolsFingerprint: "77c0",
      openRuns: [{ id: "wrun_1", name: "survey" }], runOwners: { wrun_1: "20000" },
    };
    const patch = structuredClone({ totals: used, state });
    expect(bot.table.touch("c1", "sesn_1", patch)).toBe(true);
    const expected = { ...saved, usedAt: START + 5000, totals: used, state };
    expect(bot.table.get("c1")).toEqual(expected);

    // What a caller handed in, or holds, is not the table's copy.
    patch.totals.list_cost_cents = 9999;
    const held = bot.table.get("c1")!;
    held.state!.turns = 99;
    held.sessionId = "sesn_other";
    expect(bot.table.get("c1")).toEqual(expected);

    bot.restart();
    expect(bot.table.get("c1")).toEqual(expected);
    expect(bot.table.get("dm")).toEqual({
      channelId: "dm", key: ultraKey, sessionId: "sesn_2", variant: "ultra", createdAt: START, usedAt: START,
    });
    expect(bot.table.get("c2")).toBeUndefined();
  });

  test("a touch reaches only the session it names", async () => {
    const bot = startBot(await dbPath());
    const saved = bot.table.save(session("c1", "sesn_1", "100"));
    bot.clock.now += 1000;
    const late = { totals: totals({ list_cost_cents: 500 }), state: { turns: 7 }, lease: { ceilingCents: 600 } };
    expect(bot.table.touch("c1", "sesn_other", late)).toBe(false);
    expect(bot.table.touch("nowhere", "sesn_1", late)).toBe(false);
    expect(bot.table.get("c1")).toEqual(saved);
    expect(bot.table.leased()).toEqual([]);
    bot.restart();
    expect(bot.table.get("c1")).toEqual(saved);

    // The channel moved on while a turn was still finishing on the old
    // session: what that turn learned must not land on the new one.
    bot.table.retire("c1", "archive");
    bot.table.save(session("c1", "sesn_2", "100"));
    expect(bot.table.touch("c1", "sesn_1", late)).toBe(false);
    expect(bot.table.get("c1")).toMatchObject({ sessionId: "sesn_2", usedAt: START + 1000 });
    expect(bot.table.get("c1")!.totals).toBeUndefined();
    expect(bot.table.leased()).toEqual([]);
  });

  test("a lease is on disk at once, and is listed until it is released", async () => {
    const path = await dbPath();
    const bot = startBot(path);
    bot.table.save(session("c1", "sesn_1", "100"));
    bot.table.save(session("c2", "sesn_2", "100"));
    bot.clock.now += 1000;
    expect(bot.table.touch("c1", "sesn_1", { lease: { ceilingCents: 137 } })).toBe(true);
    // Nothing is awaited or closed between the call and this read: the lease
    // has to be there before the request that raises the ceiling is sent.
    expect(onDisk(path).sessions).toEqual([
      { session_id: "sesn_1", lease_ceiling_cents: 137, lease_at: START + 1000 },
      { session_id: "sesn_2", lease_ceiling_cents: null, lease_at: null },
    ]);
    const leases = () => bot.table.leased().map((row) => [row.sessionId, row.lease]);
    expect(leases()).toEqual([["sesn_1", { ceilingCents: 137, at: START + 1000 }]]);

    // The process dies in the turn. The next one finds the lease without the
    // channel being used again.
    bot.restart();
    expect(leases()).toEqual([["sesn_1", { ceilingCents: 137, at: START + 1000 }]]);
    // Other updates of the row leave the lease alone.
    bot.clock.now += 1000;
    bot.table.touch("c1", "sesn_1", { totals: totals({ list_cost_cents: 30 }), state: { turns: 1 } });
    expect(leases()).toEqual([["sesn_1", { ceilingCents: 137, at: START + 1000 }]]);
    // A new turn's ceiling replaces the old one.
    bot.table.touch("c1", "sesn_1", { lease: { ceilingCents: 230 } });
    expect(leases()).toEqual([["sesn_1", { ceilingCents: 230, at: START + 2000 }]]);

    expect(bot.table.touch("c1", "sesn_1", { lease: null })).toBe(true);
    expect(leases()).toEqual([]);
    expect(bot.table.get("c1")).toMatchObject({ totals: { list_cost_cents: 30 }, state: { turns: 1 } });
    bot.restart();
    expect(leases()).toEqual([]);
    expect(onDisk(path).sessions[0]).toEqual({ session_id: "sesn_1", lease_ceiling_cents: null, lease_at: null });
  });

  test("retiring a row moves it to the disposal queue in one step", async () => {
    const path = await dbPath();
    const bot = startBot(path);
    bot.table.save(session("c1", "sesn_1", "100"));
    const used = totals({ list_cost_cents: 12 });
    bot.table.touch("c1", "sesn_1", { totals: used, lease: { ceilingCents: 112 } });
    bot.clock.now += 60_000;

    const disposal = bot.table.retire("c1", "delete");
    expect(disposal).toEqual({
      sessionId: "sesn_1", mode: "delete", channelId: "c1", guildId: "100", key, variant: "plain",
      totals: used, allowedCents: 100, queuedAt: START + 60_000, attempts: 0,
    });
    expect(bot.table.get("c1")).toBeUndefined();
    // The queue is quiesced whatever its state, so the lease does not follow:
    // only what it still allowed beyond the 12 cents that were counted.
    expect(bot.table.leased()).toEqual([]);
    expect(bot.table.disposals()).toEqual([disposal!]);
    expect(onDisk(path)).toEqual({ sessions: [], disposals: [{ session_id: "sesn_1", mode: "delete", attempts: 0 }] });
    // Nothing is left to retire.
    expect(bot.table.retire("c1", "delete")).toBeUndefined();
    expect(bot.table.retire("never", "archive")).toBeUndefined();

    bot.restart();
    expect(bot.table.get("c1")).toBeUndefined();
    expect(bot.table.disposals()).toEqual([disposal!]);
  });

  test("a lease keeps how it was settled, and a retired row takes along only what its lease still owes", async () => {
    const path = await dbPath();
    const bot = startBot(path);
    const leaseOf = (channelId: string) => bot.table.get(channelId)!.lease;
    for (const [channelId, sessionId] of [["c1", "sesn_1"], ["c2", "sesn_2"], ["c3", "sesn_3"], ["c4", "sesn_4"]] as const) {
      bot.table.save(session(channelId, sessionId, "100"));
      bot.table.touch(channelId, sessionId, { totals: totals({ list_cost_cents: 12 }), lease: { ceilingCents: 112 } });
    }
    // Marking a lease leaves its ceiling and its time as they are.
    bot.clock.now += 1000;
    expect(bot.table.touch("c1", "sesn_1", { lease: { settled: "counted" } })).toBe(true);
    expect(bot.table.touch("c2", "sesn_2", { lease: { settled: "lowered" } })).toBe(true);
    expect(leaseOf("c1")).toEqual({ ceilingCents: 112, at: START, settled: "counted" });
    expect(leaseOf("c2")).toEqual({ ceilingCents: 112, at: START, settled: "lowered" });
    expect(leaseOf("c3")).toEqual({ ceilingCents: 112, at: START });
    // What was counted stays counted: marking it lowered must not make it owed again.
    bot.table.touch("c1", "sesn_1", { lease: { settled: "lowered" } });
    expect(leaseOf("c1")).toEqual({ ceilingCents: 112, at: START, settled: "counted" });
    // A row without a lease has nothing to mark.
    bot.table.touch("c4", "sesn_4", { lease: null });
    bot.table.touch("c4", "sesn_4", { lease: { settled: "counted" } });
    expect(leaseOf("c4")).toBeUndefined();

    bot.restart();
    expect(leaseOf("c1")).toEqual({ ceilingCents: 112, at: START, settled: "counted" });
    expect(leaseOf("c2")).toEqual({ ceilingCents: 112, at: START, settled: "lowered" });
    expect(leaseOf("c3")).toEqual({ ceilingCents: 112, at: START });
    // All three are still leases: the sweep has something to do for each.
    expect(bot.table.leased().map((row) => row.sessionId).sort()).toEqual(["sesn_1", "sesn_2", "sesn_3"]);
    // A new turn's ceiling is a new lease.
    bot.table.save(session("c5", "sesn_5", "100"));
    bot.table.touch("c5", "sesn_5", { lease: { ceilingCents: 50 } });
    bot.table.touch("c5", "sesn_5", { lease: { settled: "counted" } });
    bot.table.touch("c5", "sesn_5", { lease: { ceilingCents: 80 } });
    expect(leaseOf("c5")).toEqual({ ceilingCents: 80, at: START + 1000 });
    // Also on disk: read as counted after a restart, the new lease would
    // neither be held against the limits nor counted.
    bot.restart();
    expect(leaseOf("c5")).toEqual({ ceilingCents: 80, at: START + 1000 });

    // What was counted is not owed again; a lowered lease owes what a plain one does.
    const owed = () => bot.table.disposals().map((d) => [d.sessionId, d.allowedCents]);
    for (const channelId of ["c1", "c2", "c3", "c4"]) bot.table.retire(channelId, "archive");
    expect(owed()).toEqual([["sesn_1", undefined], ["sesn_2", 100], ["sesn_3", 100], ["sesn_4", undefined]]);
    bot.restart();
    expect(owed()).toEqual([["sesn_1", undefined], ["sesn_2", 100], ["sesn_3", 100], ["sesn_4", undefined]]);
  });

  test("a move that fails on disk loses no session id", async () => {
    const path = await dbPath(), errors: unknown[] = [];
    const bot = startBot(path, { errors });
    bot.table.save(session("c1", "sesn_1", "100"));
    const raw = new Database(path);
    raw.exec("DROP TABLE workspace_disposals");
    raw.close();

    expect(bot.table.retire("c1", "archive")).toMatchObject({ sessionId: "sesn_1", mode: "archive" });
    expect(errors).toHaveLength(1);
    // This process still knows what to remove.
    expect(bot.table.disposals().map((d) => d.sessionId)).toEqual(["sesn_1"]);
    // The delete was undone with the failed insert: a restart finds the
    // session in its channel, not nowhere.
    const check = new Database(path, { readonly: true });
    expect(check.query("SELECT session_id FROM workspace_sessions").all()).toEqual([{ session_id: "sesn_1" }]);
    check.close();
  });

  test("a guild change retires that guild's channels, also unread ones, and leaves DMs", async () => {
    const bot = startBot(await dbPath());
    bot.table.save(session("c1", "sesn_1", "100"));
    bot.table.save(session("c2", "sesn_2", "100"));
    bot.table.save(session("c3", "sesn_3", "200"));
    bot.table.save(session("dm", "sesn_4"));
    // Not read by this process yet: the rows go all the same.
    bot.restart();
    bot.clock.now += 1000;
    // c2 has a turn running; its owner retires it when the turn ends.
    const moved = bot.table.retireGuild("100", "archive", ["c2"]);
    expect(moved.map((d) => [d.channelId, d.sessionId, d.mode, d.queuedAt])).toEqual([["c1", "sesn_1", "archive", START + 1000]]);
    const sessions = () => ["c1", "c2", "c3", "dm"].map((id) => bot.table.get(id)?.sessionId);
    expect(sessions()).toEqual([undefined, "sesn_2", "sesn_3", "sesn_4"]);
    bot.restart();
    expect(sessions()).toEqual([undefined, "sesn_2", "sesn_3", "sesn_4"]);
    expect(bot.table.disposals().map((d) => d.sessionId)).toEqual(["sesn_1"]);
    expect(bot.table.retireGuild("300", "archive")).toEqual([]);

    // Without a guild, every channel: the reach of History.clearGuild.
    bot.restart();
    expect(bot.table.retireGuild(undefined, "archive").map((d) => d.sessionId).sort()).toEqual(["sesn_2", "sesn_3", "sesn_4"]);
    expect(sessions()).toEqual([undefined, undefined, undefined, undefined]);
    bot.restart();
    expect(bot.table.disposals().map((d) => d.sessionId)).toEqual(["sesn_1", "sesn_2", "sesn_3", "sesn_4"]);
  });

  test("a failed removal stays queued and is retried after a restart", async () => {
    const bot = startBot(await dbPath());
    bot.table.save(session("c1", "sesn_1", "100"));
    bot.table.save(session("c2", "sesn_2", "100"));
    bot.table.retire("c1", "delete");
    bot.clock.now += 1000;
    bot.table.retire("c2", "archive");
    const queue = () => bot.table.disposals().map((d) => [d.sessionId, d.mode, d.attempts]);
    expect(queue()).toEqual([["sesn_1", "delete", 0], ["sesn_2", "archive", 0]]);

    bot.table.failed("sesn_1");
    expect(queue()).toEqual([["sesn_1", "delete", 1], ["sesn_2", "archive", 0]]);
    bot.restart();
    // Before this process listed the queue, and after.
    bot.table.failed("sesn_1");
    expect(queue()).toEqual([["sesn_1", "delete", 2], ["sesn_2", "archive", 0]]);
    bot.table.failed("sesn_1");
    bot.table.disposed("sesn_2");
    expect(queue()).toEqual([["sesn_1", "delete", 3]]);
    bot.restart();
    expect(queue()).toEqual([["sesn_1", "delete", 3]]);

    bot.table.disposed("sesn_1");
    expect(queue()).toEqual([]);
    bot.restart();
    expect(queue()).toEqual([]);
  });

  test("a session that only a checkpoint still names is queued once, and never while a channel or the queue has it", async () => {
    const path = await dbPath();
    const bot = startBot(path);
    bot.table.save(session("c1", "sesn_1", "100"));
    // The channel's own session is not one to give up, whoever names it.
    expect(bot.table.holds("c1", "sesn_1")).toBe(true);
    expect(bot.table.abandon(session("c1", "sesn_1", "100"))).toBe(false);
    expect(bot.table.disposals()).toEqual([]);
    expect(bot.table.holds("c1", "sesn_lost")).toBe(false);

    bot.clock.now += 1000;
    expect(bot.table.abandon(session("c1", "sesn_lost", "100"))).toBe(true);
    // Archived, like every session that was not cleared. No totals: what the
    // ledger counted of it is not known, so its removal counts all of it.
    expect(bot.table.disposals()).toEqual([{
      sessionId: "sesn_lost", mode: "archive", channelId: "c1", guildId: "100", key, variant: "plain",
      queuedAt: START + 1000, attempts: 0,
    }]);
    expect(bot.table.disposals()[0]!.totals).toBeUndefined();
    // The channel keeps the session it uses.
    expect(bot.table.get("c1")!.sessionId).toBe("sesn_1");
    expect(onDisk(path)).toMatchObject({
      sessions: [{ session_id: "sesn_1" }], disposals: [{ session_id: "sesn_lost", mode: "archive", attempts: 0 }],
    });

    // Queued already, also when this process has not read the queue yet: the
    // entry and its count of attempts stay as they are.
    bot.table.failed("sesn_lost");
    bot.restart();
    expect(bot.table.holds("c1", "sesn_lost")).toBe(true);
    expect(bot.table.abandon(session("c1", "sesn_lost", "100"))).toBe(false);
    expect(bot.table.disposals().map((d) => [d.sessionId, d.mode, d.attempts])).toEqual([["sesn_lost", "archive", 1]]);
    // A session that was cleared stays queued to be deleted.
    bot.clock.now += 1000;
    bot.table.retire("c1", "delete");
    expect(bot.table.abandon(session("c1", "sesn_1", "100"))).toBe(false);
    expect(bot.table.disposals().map((d) => [d.sessionId, d.mode])).toEqual([["sesn_lost", "archive"], ["sesn_1", "delete"]]);

    // Without a store the queue is this process's own.
    const memory = new SessionTable();
    expect(memory.abandon(session("c1", "sesn_lost"))).toBe(true);
    expect(memory.abandon(session("c1", "sesn_lost"))).toBe(false);
    expect(memory.disposals().map((d) => d.sessionId)).toEqual(["sesn_lost"]);
    // Once it is removed, the table has nothing more to say about it.
    memory.disposed("sesn_lost");
    expect(memory.holds("c1", "sesn_lost")).toBe(false);
  });

  test("saving another session for a channel queues the one it had", async () => {
    const bot = startBot(await dbPath());
    bot.table.save(session("c1", "sesn_1", "100"));
    bot.table.touch("c1", "sesn_1", { totals: totals({ list_cost_cents: 8 }) });
    bot.table.save({ ...session("c1", "sesn_2", "100"), key: ultraKey, variant: "ultra" });
    expect(bot.table.get("c1")).toMatchObject({ sessionId: "sesn_2", variant: "ultra", key: ultraKey });
    expect(bot.table.disposals()).toMatchObject([{ sessionId: "sesn_1", mode: "archive", totals: { list_cost_cents: 8 } }]);
    // The same session again replaces its row and queues nothing.
    bot.table.save({ ...bot.table.get("c1")!, state: { turns: 2 } });
    expect(bot.table.disposals()).toHaveLength(1);
    bot.restart();
    expect(bot.table.get("c1")).toMatchObject({ sessionId: "sesn_2", state: { turns: 2 } });
    expect(bot.table.disposals().map((d) => d.sessionId)).toEqual(["sesn_1"]);
  });

  test("without a store, or before it is opened, the table works from memory", async () => {
    const path = await dbPath();
    const unopened = new ConversationStore(path);
    for (const table of [new SessionTable(), new SessionTable(new ConversationStore("")), new SessionTable(unopened, () => START)]) {
      table.save(session("c1", "sesn_1", "100"));
      table.save(session("c2", "sesn_2", "100"));
      table.save(session("dm", "sesn_3"));
      expect(table.touch("c1", "sesn_1", { totals: totals({ list_cost_cents: 3 }), lease: { ceilingCents: 103 } })).toBe(true);
      expect(table.leased().map((row) => row.sessionId)).toEqual(["sesn_1"]);
      expect(table.retire("c1", "delete")).toMatchObject({ sessionId: "sesn_1", totals: { list_cost_cents: 3 } });
      expect(table.retireGuild("100", "archive").map((d) => d.sessionId)).toEqual(["sesn_2"]);
      expect(table.get("c1")).toBeUndefined();
      expect(table.get("dm")).toMatchObject({ sessionId: "sesn_3" });
      table.failed("sesn_1");
      expect(table.disposals().map((d) => [d.sessionId, d.mode, d.attempts]).sort())
        .toEqual([["sesn_1", "delete", 1], ["sesn_2", "archive", 0]]);
      table.disposed("sesn_1");
      table.disposed("sesn_2");
      expect(table.disposals()).toEqual([]);
    }
    expect(existsSync(path)).toBe(false);
  });

  test("a column that cannot be read costs its value, not the session", async () => {
    const path = await dbPath(), errors: unknown[] = [];
    const bot = startBot(path, { errors });
    bot.table.save(session("c1", "sesn_1", "100"));
    bot.table.touch("c1", "sesn_1", { totals: totals({ list_cost_cents: 12 }), state: { turns: 3 }, lease: { ceilingCents: 112 } });
    bot.table.save(session("c2", "sesn_2", "100"));
    bot.table.touch("c2", "sesn_2", { totals: totals({ list_cost_cents: 5 }) });
    bot.table.retire("c2", "delete");
    const raw = new Database(path);
    raw.query("UPDATE workspace_sessions SET usage = '{cut off', state = '[3]'").run();
    raw.query("UPDATE workspace_disposals SET usage = '{cut off'").run();
    raw.close();

    bot.restart();
    // The ceiling can still be lowered and the session removed.
    const row = bot.table.leased()[0]!;
    expect(row).toMatchObject({ sessionId: "sesn_1", lease: { ceilingCents: 112 } });
    expect(row.totals).toBeUndefined();
    expect(row.state).toBeUndefined();
    expect(errors).toHaveLength(1);
    const [disposal] = bot.table.disposals();
    expect(disposal).toMatchObject({ sessionId: "sesn_2", mode: "delete" });
    expect(disposal!.totals).toBeUndefined();
    expect(errors).toHaveLength(2);
  });
});

describe("schema", () => {
  // The statements of the version before #76.
  const BEFORE = SCHEMA.filter((sql) => !sql.includes("workspace_"));

  test("an older database gains the tables and keeps its history", async () => {
    const path = await dbPath();
    expect(BEFORE).toHaveLength(4);
    const old = new Database(path, { create: true });
    for (const sql of BEFORE) old.exec(sql);
    old.query("INSERT INTO history_channels (channel_id, guild_id, key, usage) VALUES ('1', '100', 'key', NULL)").run();
    old.query("INSERT INTO history_turns (channel_id, seq, at, tokens, messages) VALUES ('1', 0, ?, 10, ?)")
      .run(Date.now(), JSON.stringify(turn("t0")));
    old.close();

    const errors: unknown[] = [];
    const bot = startBot(path, { errors });
    expect(starts(bot.history.get("1", "100", "key", false, 3600))).toEqual(["t0"]);
    bot.table.save(session("1", "sesn_1", "100"));
    bot.table.retire("1", "archive");
    bot.table.save(session("1", "sesn_2", "100"));
    bot.restart();
    expect(bot.table.get("1")).toMatchObject({ sessionId: "sesn_2" });
    expect(bot.table.disposals().map((d) => d.sessionId)).toEqual(["sesn_1"]);
    expect(starts(bot.history.get("1", "100", "key", false, 3600))).toEqual(["t0"]);
    expect(errors).toEqual([]);
  });

  test("a file from before a lease's settlement was kept gains the two columns, and its rows read as they did", async () => {
    const path = await dbPath(), errors: unknown[] = [];
    // The two tables as #76 first created them, with a leased row and a
    // queued session.
    const old = new Database(path, { create: true });
    for (const sql of SCHEMA) old.exec(sql);
    const columns = (table: string) => (old.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
    expect(columns("workspace_sessions")).not.toContain("lease_settled");
    expect(columns("workspace_disposals")).not.toContain("allowed_cents");
    old.query(`INSERT INTO workspace_sessions (channel_id, guild_id, key, session_id, variant, created_at, used_at, usage, lease_ceiling_cents, lease_at)
      VALUES ('c1', '100', ?, 'sesn_1', 'plain', ?, ?, ?, 112, ?)`).run(key, START, START, JSON.stringify(totals({ list_cost_cents: 12 })), START);
    old.query(`INSERT INTO workspace_disposals (session_id, mode, channel_id, guild_id, key, variant, usage, queued_at, attempts)
      VALUES ('sesn_0', 'delete', 'c0', '100', ?, 'plain', NULL, ?, 2)`).run(key, START);
    old.close();

    const bot = startBot(path, { errors });
    expect(bot.table.get("c1")).toEqual({
      channelId: "c1", guildId: "100", key, sessionId: "sesn_1", variant: "plain", createdAt: START, usedAt: START,
      totals: totals({ list_cost_cents: 12 }), lease: { ceilingCents: 112, at: START },
    });
    expect(bot.table.disposals()).toEqual([{
      sessionId: "sesn_0", mode: "delete", channelId: "c0", guildId: "100", key, variant: "plain", queuedAt: START, attempts: 2,
    }]);
    // And it is written like any other.
    bot.table.touch("c1", "sesn_1", { lease: { settled: "lowered" } });
    bot.table.retire("c1", "archive");
    // Opening it again adds nothing twice.
    bot.restart();
    expect(bot.table.disposals().map((d) => [d.sessionId, d.allowedCents])).toEqual([["sesn_0", undefined], ["sesn_1", 100]]);
    expect(errors).toEqual([]);
  });

  test("the previous version opens the newer file, and the rows wait for the redeploy", async () => {
    const path = await dbPath();
    const bot = startBot(path);
    bot.table.save(session("c1", "sesn_1", "100"));
    bot.table.touch("c1", "sesn_1", { lease: { ceilingCents: 112 } });
    bot.table.save(session("c2", "sesn_2", "100"));
    bot.table.retire("c2", "archive");
    bot.store.close();

    // A rollback (ADR-0006): the previous version runs its own statements on
    // the file and knows nothing of the two tables. Its History has no hook.
    const raw = new Database(path);
    for (const sql of BEFORE) raw.exec(sql);
    raw.close();
    const previous = new History(config, open(path));
    previous.get("c1", "100", "key", false, 3600);
    previous.put("c1", turn("during the rollback"), emptyUsage());
    // Known limit (#76): a clear made by that version ends the local record
    // only. The session is still the channel's when this version returns.
    previous.clear("c1");

    bot.restart();
    expect(bot.table.get("c1")).toMatchObject({ sessionId: "sesn_1", lease: { ceilingCents: 112 } });
    expect(bot.table.leased().map((row) => row.sessionId)).toEqual(["sesn_1"]);
    expect(bot.table.disposals().map((d) => d.sessionId)).toEqual(["sesn_2"]);
  });

  test("this version reads and writes a file that a newer one added to", async () => {
    const path = await dbPath(), errors: unknown[] = [];
    const bot = startBot(path, { errors });
    bot.table.save(session("c1", "sesn_1", "100"));
    bot.table.save(session("c2", "sesn_2", "100"));
    const raw = new Database(path);
    raw.exec("ALTER TABLE workspace_sessions ADD COLUMN note TEXT");
    raw.exec("ALTER TABLE workspace_sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
    raw.exec("ALTER TABLE workspace_disposals ADD COLUMN reason TEXT NOT NULL DEFAULT ''");
    raw.close();

    bot.restart();
    expect(bot.table.touch("c1", "sesn_1", { lease: { ceilingCents: 50 }, state: { turns: 1 } })).toBe(true);
    bot.table.retire("c2", "delete");
    bot.table.failed("sesn_2");
    bot.table.save(session("c3", "sesn_3", "100"));
    bot.restart();
    expect(bot.table.leased().map((row) => row.sessionId)).toEqual(["sesn_1"]);
    expect(bot.table.get("c3")).toMatchObject({ sessionId: "sesn_3" });
    expect(bot.table.disposals().map((d) => [d.sessionId, d.attempts])).toEqual([["sesn_2", 1]]);
    expect(errors).toEqual([]);
  });
});

describe("what ends a conversation is told to the hook", () => {
  const record = (drops: HistoryDrop[]): Wire => (history) => { history.onDrop = (drop) => drops.push(drop); };

  test("a reset, a clear and a guild change are named; a first turn drops nothing", async () => {
    setSystemTime(new Date("2026-10-01T00:00:00Z"));
    const drops: HistoryDrop[] = [];
    const bot = startBot(await dbPath(), { wire: record(drops) });
    // Nothing existed, and then nothing changed.
    bot.history.get("1", "100", "one", false, 3600);
    bot.history.get("1", "100", "one", false, 3600);
    bot.history.put("1", turn("t0"), emptyUsage());
    expect(starts(bot.history.get("1", "100", "one", false, 3600))).toEqual(["t0"]);
    expect(drops).toEqual([]);

    // Another model or mode, then another guild.
    expect(bot.history.get("1", "100", "other", false, 3600)).toEqual([]);
    expect(drops.splice(0)).toEqual([{ channelId: "1", cause: "reset" }]);
    bot.history.get("1", "200", "other", false, 3600);
    expect(drops.splice(0)).toEqual([{ channelId: "1", cause: "reset" }]);
    // Once per drop: the reads that follow in the same turn continue it.
    bot.history.get("1", "200", "other", false, 3600);
    expect(drops).toEqual([]);

    // A thread that idled past its age.
    bot.history.get("thread", "100", "one", true, 60);
    bot.history.put("thread", turn("t0"), emptyUsage());
    setSystemTime(new Date("2026-10-01T00:00:30Z"));
    bot.history.get("thread", "100", "one", true, 60);
    expect(drops).toEqual([]);
    setSystemTime(new Date("2026-10-01T00:02:00Z"));
    expect(bot.history.get("thread", "100", "one", true, 60)).toEqual([]);
    expect(drops.splice(0)).toEqual([{ channelId: "thread", cause: "reset" }]);

    // /clear and a deleted channel, also one this process never read.
    bot.history.clear("1");
    bot.history.clear("unread");
    expect(drops.splice(0)).toEqual([{ channelId: "1", cause: "clear" }, { channelId: "unread", cause: "clear" }]);
    // A settings change (Runtime.onChange).
    bot.history.clearGuild("100");
    expect(drops.splice(0)).toEqual([{ guildId: "100", cause: "guild" }]);
  });

  test("a conversation stored before a restart is reported when it is dropped", async () => {
    const drops: HistoryDrop[] = [];
    const bot = startBot(await dbPath(), { wire: record(drops) });
    bot.history.get("1", "100", "one", false, 3600);
    bot.history.put("1", turn("t0"), emptyUsage());
    bot.restart();
    expect(bot.history.get("1", "100", "other", false, 3600)).toEqual([]);
    expect(drops).toEqual([{ channelId: "1", cause: "reset" }]);
  });

  test("/clear and a deleted channel delete the session; a model change, another guild, an expired thread and a settings change archive it", async () => {
    setSystemTime(new Date("2026-10-01T00:00:00Z"));
    // The rule of #76: an explicit clear deletes, every other end archives.
    // (What to do while a turn is running on the channel is its owner's.)
    const bot = startBot(await dbPath(), {
      wire: (history, table) => {
        history.onDrop = (drop) => {
          if (drop.cause === "guild") table.retireGuild(drop.guildId, "archive");
          else table.retire(drop.channelId, drop.cause === "clear" ? "delete" : "archive");
        };
      },
    });
    const channels: [string, string | undefined, boolean][] = [
      ["cleared", "100", false], ["deleted", "100", false], ["model", "100", false], ["guild", "100", false],
      ["thread", "100", true], ["settings", "300", false], ["settings-unread", "300", false],
      ["kept", "200", false], ["dm", undefined, false],
    ];
    const sessions = () => Object.fromEntries(
      [...channels.map(([id]) => id), "first"].flatMap((id) => {
        const row = bot.table.get(id);
        return row ? [[id, row.sessionId]] : [];
      }),
    );
    for (const [id, guildId, thread] of channels) {
      bot.history.get(id, guildId, key, thread, 60);
      bot.history.put(id, turn(`in ${id}`), emptyUsage());
      bot.table.save(session(id, `sesn_${id}`, guildId));
    }
    // A first turn that failed left a session and no conversation.
    bot.table.save(session("first", "sesn_first", "100"));
    bot.restart();

    bot.history.clear("cleared");
    bot.history.clear("deleted");
    bot.history.get("model", "100", ultraKey, false, 60);
    bot.history.get("guild", "200", key, false, 60);
    setSystemTime(new Date("2026-10-01T00:02:00Z"));
    bot.history.get("thread", "100", key, true, 60);
    bot.history.get("settings", "300", key, false, 60);
    bot.history.clearGuild("300");
    // Continued, or nothing to drop.
    expect(starts(bot.history.get("kept", "200", key, false, 60))).toEqual(["in kept"]);
    expect(starts(bot.history.get("dm", undefined, key, false, 60))).toEqual(["in dm"]);
    expect(bot.history.get("first", "100", key, false, 60)).toEqual([]);

    const queued = () => Object.fromEntries(bot.table.disposals().map((d) => [d.channelId, d.mode]));
    const expected: Record<string, "delete" | "archive"> = {
      cleared: "delete", deleted: "delete", model: "archive", guild: "archive", thread: "archive",
      settings: "archive", "settings-unread": "archive",
    };
    expect(queued()).toEqual(expected);
    expect(sessions()).toEqual({ kept: "sesn_kept", dm: "sesn_dm", first: "sesn_first" });
    bot.restart();
    expect(queued()).toEqual(expected);
    expect(sessions()).toEqual({ kept: "sesn_kept", dm: "sesn_dm", first: "sesn_first" });
  });

  test("without a hook History does what it did", async () => {
    const bot = startBot(await dbPath());
    expect(bot.history.onDrop).toBeUndefined();
    bot.history.get("1", "100", "one", false, 3600);
    bot.history.put("1", turn("t0"), emptyUsage());
    expect(bot.history.get("1", "100", "other", false, 3600)).toEqual([]);
    bot.history.put("1", turn("t1"), emptyUsage());
    bot.history.clear("1");
    bot.history.clearGuild("100");
    bot.restart();
    expect(bot.history.info("1").turns).toBe(0);
  });
});

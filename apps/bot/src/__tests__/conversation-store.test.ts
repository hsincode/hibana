import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { Agent } from "../agent";
import { ROUTE_CACHE_TTL_MS, RouteMemory, routeLevel } from "../auto-route";
import { Hibana } from "../bot";
import { loadConfig } from "../config";
import { ConversationStore, SCHEMA } from "../conversation-store";
import { History } from "../history";
import { LlmClient, type RequestRecord } from "../llm";
import { Runtime } from "../runtime";
import { emptyUsage, type Context, type Json, type Message, type ToolDef } from "../types";

// Decision record #59: conversation history and auto routes outlive a restart
// of the bot, which every deploy is. "Restart" below is what a new process
// does: a new store and new objects on the file the previous ones wrote.

const selection = { provider: "custom", model: "gpt-test", effort: "none" };
const config = (env: Record<string, string> = {}) => loadConfig({
  PROVIDER: "custom", LLM_BASE_URL: "https://example.com/v1", LLM_API_KEY: "secret-test", LLM_MODEL: "gpt-test", ...env,
});
const tool: ToolDef = {
  type: "function",
  function: { name: "lookup", description: "Find a record", parameters: { type: "object", properties: {} } },
};
const ctx: Context = { channelId: "chan", userId: "2", botId: "3", thread: false, depth: 0, delivered: false };
const prefix: Message[] = [
  { role: "system", content: "You are Hibana." },
  { role: "developer", content: "Policy rebuilt from settings each turn." },
];
const turn = (text: string, size = 30): Message[] => [
  { role: "user", content: text, turnStart: true },
  { role: "assistant", content: "x".repeat(size) },
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
  const dir = await mkdtemp(join(tmpdir(), "hibana-conversations-"));
  dirs.push(dir);
  return join(dir, "conversations.db");
}
function open(path: string, errors: unknown[] = []) {
  const store = new ConversationStore(path, (e) => errors.push(e));
  store.open();
  stores.push(store);
  return store;
}
/** One bot process after another on the same file. */
function startBot(path: string, cfg = config(), errors: unknown[] = []) {
  let store = open(path, errors);
  const state = {
    history: new History(cfg, store),
    restart() {
      store.close();
      store = open(path, errors);
      state.history = new History(cfg, store);
    },
  };
  return state;
}

/** Runs turns the way Hibana.turn does (see history-cache.test.ts), with the
 *  process restarting before every turn after the first when `restart` is set. */
async function conversation(path: string | undefined, turns: number, restart: boolean) {
  const records: RequestRecord[] = [];
  const bodies: string[] = [];
  let call = 0;
  const client = new LlmClient(config(), async (_url, init) => {
    bodies.push(String(init?.body));
    return Response.json({
      choices: [{
        message: call++ % 2 === 0
          ? { role: "assistant", content: "", tool_calls: [{ id: `call-${call}`, type: "function", function: { name: "lookup", arguments: "{}" } }] }
          : { role: "assistant", content: `answer ${call}` },
      }],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    });
  }, { onCompletion: (record) => records.push(record) });
  const bot = path ? startBot(path) : undefined;
  let memory = new History(config());
  for (let i = 0; i < turns; i++) {
    if (restart && i > 0) {
      bot?.restart();
      memory = new History(config());
    }
    const history = bot?.history ?? memory;
    const messages: Message[] = [...prefix, ...history.get(ctx.channelId, undefined, "key", false, 3600)];
    const seed = messages.length;
    messages.push({ role: "user", content: `request ${i}`, turnStart: true });
    const result = await new Agent(client).run({
      selection, messages, tools: [tool], context: { ...ctx }, maxRounds: 4, temperature: 0.7, nativeSearch: false,
      jevTaskMode: () => false,
      execute: async () => "y".repeat(20000),
    });
    history.put(ctx.channelId, result.messages.slice(seed), result.usage);
  }
  return { records, bodies };
}

describe("a restart keeps the conversation", () => {
  test("the next request only appends to the last one before the restart", async () => {
    const restarted = await conversation(await dbPath(), 6, true);
    expect(restarted.records).toHaveLength(12);
    // The same measure as #31: every request repeats the whole previous one.
    expect(restarted.records.slice(1).map((r) => [r.prefix!.against, r.prefix!.diverged]))
      .toEqual(Array(11).fill(["lineage", null]));
    // And byte for byte what the conversation sends when nothing restarts.
    const uninterrupted = await conversation(undefined, 6, false);
    expect(restarted.bodies).toEqual(uninterrupted.bodies);
  });
  test("without a store the conversation starts over, as it did before", async () => {
    const { records } = await conversation(undefined, 2, true);
    // The first request after the restart no longer continues the last one.
    expect(records[2]!.prefix!.diverged).not.toBeNull();
  });
  test("a process that is killed keeps the turns it had stored", async () => {
    const path = await dbPath();
    const script = join(dirs.at(-1)!, "killed.ts");
    // No close(): the store has to be complete after each write on its own.
    await writeFile(script, `
      import { ConversationStore } from ${JSON.stringify(join(import.meta.dir, "..", "conversation-store.ts"))};
      import { History } from ${JSON.stringify(join(import.meta.dir, "..", "history.ts"))};
      import { loadConfig } from ${JSON.stringify(join(import.meta.dir, "..", "config.ts"))};
      import { emptyUsage } from ${JSON.stringify(join(import.meta.dir, "..", "types.ts"))};
      const store = new ConversationStore(process.argv[2]);
      store.open();
      const history = new History(loadConfig({ PROVIDER: "custom", LLM_BASE_URL: "https://example.com/v1", LLM_API_KEY: "secret-test", LLM_MODEL: "gpt-test" }), store);
      history.get("1", undefined, "key", false, 3600);
      for (const text of ["t0", "t1"])
        history.put("1", [{ role: "user", content: text, turnStart: true }, { role: "assistant", content: "ok" }], emptyUsage());
      process.kill(process.pid, "SIGKILL");
    `);
    const child = Bun.spawn([process.execPath, script, path], { stdout: "ignore", stderr: "ignore" });
    await child.exited;
    expect(child.signalCode).toBe("SIGKILL");
    const history = new History(config(), open(path));
    expect(starts(history.get("1", undefined, "key", false, 3600))).toEqual(["t0", "t1"]);
  });
  test("usage and turn counts are read back for /context", async () => {
    const bot = startBot(await dbPath());
    bot.history.get("1", "100", "key", false, 3600);
    bot.history.put("1", turn("t0"), { ...emptyUsage(), prompt_tokens: 42 });
    const before = bot.history.info("1");
    bot.restart();
    expect(bot.history.info("1")).toEqual(before);
    expect(before).toMatchObject({ turns: 1, usage: { prompt_tokens: 42 } });
  });
  test("trimming, halving and summaries are stored as they happen", async () => {
    const cfg = config({ HISTORY_MAX_TOKENS: "1000", HISTORY_KEEP_TOKENS: "500", THREAD_COMPACTION_TOKENS: "1000" });
    const bot = startBot(await dbPath(), cfg);
    const read = (channel: string, thread: boolean) => bot.history.get(channel, undefined, "key", thread, 3600);
    // A channel trims in get(), once it is over the limit.
    read("chan", false);
    for (let i = 0; i < 12; i++) {
      bot.history.put("chan", turn(`t${i}`, 600), emptyUsage());
      read("chan", false);
    }
    const trimmed = read("chan", false);
    expect(starts(trimmed)[0]).not.toBe("t0");
    bot.restart();
    expect(read("chan", false)).toEqual(trimmed);
    bot.history.shrink("chan");
    const halved = read("chan", false);
    expect(halved.length).toBeLessThan(trimmed.length);
    bot.restart();
    expect(read("chan", false)).toEqual(halved);
    // A thread is summarized instead.
    let summaries = 0;
    const llm = { complete: async () => (summaries++, { message: { role: "assistant", content: "summary" }, usage: emptyUsage(), incomplete: false }) };
    read("thread", true);
    for (let i = 0; i < 9; i++) bot.history.put("thread", turn(`t${i}`, 600), emptyUsage());
    await bot.history.compact("thread", llm as never, selection);
    const compacted = read("thread", true);
    expect(compacted[0]!.content).toStartWith("Conversation summary:");
    bot.restart();
    expect(read("thread", true)).toEqual(compacted);
    // The stored turn is still known to be a summary: it is not folded again.
    await bot.history.compact("thread", llm as never, selection);
    expect(summaries).toBe(1);
    // New turns follow the ones that were kept.
    bot.history.put("thread", turn("later"), emptyUsage());
    bot.restart();
    expect(read("thread", true)).toEqual([...compacted, ...turn("later")]);
  });
});

describe("what ends a conversation also removes it from disk", () => {
  test("/clear and a deleted channel", async () => {
    const bot = startBot(await dbPath());
    bot.history.get("1", "100", "key", false, 3600);
    bot.history.put("1", turn("t0"), emptyUsage());
    bot.restart();
    // Not read by this process yet: the rows go all the same.
    bot.history.clear("1");
    bot.restart();
    expect(bot.history.get("1", "100", "key", false, 3600)).toEqual([]);
  });
  test("a settings change clears that guild only, including channels not yet read", async () => {
    const bot = startBot(await dbPath());
    for (const [channel, guild] of [["1", "100"], ["2", "200"], ["dm", undefined]] as const) {
      bot.history.get(channel, guild, "key", false, 3600);
      bot.history.put(channel, turn(`in ${channel}`), emptyUsage());
    }
    bot.restart();
    bot.history.clearGuild("100");
    bot.restart();
    expect(bot.history.get("1", "100", "key", false, 3600)).toEqual([]);
    expect(starts(bot.history.get("2", "200", "key", false, 3600))).toEqual(["in 2"]);
    expect(starts(bot.history.get("dm", undefined, "key", false, 3600))).toEqual(["in dm"]);
  });
  test("a model change", async () => {
    const bot = startBot(await dbPath());
    bot.history.get("1", "100", "one", false, 3600);
    bot.history.put("1", turn("t0"), emptyUsage());
    bot.restart();
    expect(bot.history.get("1", "100", "other", false, 3600)).toEqual([]);
    bot.restart();
    // Going back does not bring the old conversation back either.
    expect(bot.history.get("1", "100", "one", false, 3600)).toEqual([]);
  });
  test("a thread that idled past its age while the bot was down", async () => {
    setSystemTime(new Date("2026-10-01T00:00:00Z"));
    const bot = startBot(await dbPath());
    bot.history.get("thread", "100", "key", true, 60);
    bot.history.put("thread", turn("t0"), emptyUsage());
    setSystemTime(new Date("2026-10-01T00:00:30Z"));
    bot.restart();
    expect(starts(bot.history.get("thread", "100", "key", true, 60))).toEqual(["t0"]);
    setSystemTime(new Date("2026-10-01T00:02:00Z"));
    bot.restart();
    expect(bot.history.get("thread", "100", "key", true, 60)).toEqual([]);
    bot.restart();
    expect(bot.history.info("thread").turns).toBe(0);
  });
  test("a stored conversation is not continued from another guild", async () => {
    const bot = startBot(await dbPath());
    bot.history.get("1", "100", "key", false, 3600);
    bot.history.put("1", turn("for guild 100"), emptyUsage());
    bot.restart();
    expect(bot.history.get("1", "200", "key", false, 3600)).toEqual([]);
    expect(bot.history.get("1", undefined, "key", false, 3600)).toEqual([]);
  });
  test("a summary that finishes after /clear does not bring the thread back", async () => {
    const bot = startBot(await dbPath(), config({ THREAD_COMPACTION_TOKENS: "1000" }));
    bot.history.get("thread", undefined, "key", true, 3600);
    for (let i = 0; i < 9; i++) bot.history.put("thread", turn(`t${i}`, 600), emptyUsage());
    const llm = { complete: async () => {
      bot.history.clear("thread");
      return { message: { role: "assistant", content: "summary" }, usage: emptyUsage(), incomplete: false };
    } };
    await bot.history.compact("thread", llm as never, selection);
    expect(bot.history.info("thread").turns).toBe(0);
    bot.restart();
    expect(bot.history.get("thread", undefined, "key", true, 3600)).toEqual([]);
  });
});

describe("a disk problem never stops the bot", () => {
  test("an unreadable row empties that channel only", async () => {
    const path = await dbPath(), errors: unknown[] = [];
    const bot = startBot(path, config(), errors);
    for (const channel of ["a", "b"]) {
      bot.history.get(channel, undefined, "key", false, 3600);
      for (const text of ["t0", "t1"]) bot.history.put(channel, turn(text), emptyUsage());
    }
    const raw = new Database(path);
    raw.query("UPDATE history_turns SET messages = '{cut off' WHERE channel_id = 'a' AND seq = 1").run();
    raw.close();
    bot.restart();
    expect(bot.history.get("a", undefined, "key", false, 3600)).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(starts(bot.history.get("b", undefined, "key", false, 3600))).toEqual(["t0", "t1"]);
    // The readable half of the damaged channel is gone too, not replayed later.
    bot.history.put("a", turn("fresh"), emptyUsage());
    bot.restart();
    expect(starts(bot.history.get("a", undefined, "key", false, 3600))).toEqual(["fresh"]);
  });
  test("a file that is not a database is left as it is, and history stays in memory", async () => {
    const path = await dbPath(), errors: unknown[] = [];
    const garbage = "not a database ".repeat(400);
    await writeFile(path, garbage);
    const store = open(path, errors);
    expect(store.opened).toBe(false);
    expect(errors).toHaveLength(1);
    const history = new History(config(), store);
    history.get("1", undefined, "key", false, 3600);
    history.put("1", turn("t0"), emptyUsage());
    expect(starts(history.get("1", undefined, "key", false, 3600))).toEqual(["t0"]);
    expect(await readFile(path, "utf8")).toBe(garbage);
    expect(errors).toHaveLength(1);
  });
  test("a write that fails is reported, and the turn still counts", async () => {
    const path = await dbPath(), errors: unknown[] = [];
    const bot = startBot(path, config(), errors);
    bot.history.get("1", undefined, "key", false, 3600);
    const raw = new Database(path);
    raw.exec("DROP TABLE history_turns");
    raw.close();
    bot.history.put("1", turn("t0"), emptyUsage());
    expect(errors).toHaveLength(1);
    expect(starts(bot.history.get("1", undefined, "key", false, 3600))).toEqual(["t0"]);
  });
  test("an empty path stores nothing", async () => {
    const store = new ConversationStore("");
    store.open();
    expect(store.opened).toBe(false);
    const history = new History(config(), store);
    history.get("1", undefined, "key", false, 3600);
    history.put("1", turn("t0"), emptyUsage());
    expect(history.info("1").turns).toBe(1);
    expect(config({ CONVERSATION_DB_PATH: "" }).conversationDbPath).toBe("");
    expect(config({ HIBANA_DATA_DIR: "/tmp/hibana-tests" }).conversationDbPath).toBe("/tmp/hibana-tests/conversations.db");
  });
  test("the file is readable by the bot's user only", async () => {
    const path = await dbPath();
    const bot = startBot(path);
    bot.history.get("1", undefined, "key", false, 3600);
    bot.history.put("1", turn("t0"), emptyUsage());
    for (const file of [path, `${path}-wal`])
      if (existsSync(file)) expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});

describe("schema", () => {
  // A failed deploy is rolled back to the previous commit (ADR-0006), which
  // then opens the file the newer version left. So the schema may only add.
  const ADDITIVE = [/^CREATE TABLE IF NOT EXISTS /, /^CREATE (UNIQUE )?INDEX IF NOT EXISTS /];
  test("only adds", () => {
    const statements = SCHEMA.map((sql) => sql.replace(/\s+/g, " ").trim());
    expect(statements.length).toBeGreaterThan(0);
    expect(statements.filter((sql) => !ADDITIVE.some((allowed) => allowed.test(sql)))).toEqual([]);
  });
  test("this version reads and writes a file that a newer one added to", async () => {
    const path = await dbPath();
    const bot = startBot(path);
    bot.history.get("1", undefined, "key", false, 3600);
    bot.history.put("1", turn("t0"), emptyUsage());
    const raw = new Database(path);
    raw.exec("ALTER TABLE history_turns ADD COLUMN note TEXT");
    raw.exec("ALTER TABLE history_channels ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
    raw.exec("CREATE TABLE later_feature (id TEXT PRIMARY KEY)");
    raw.close();
    bot.restart();
    bot.history.put("1", turn("t1"), emptyUsage());
    bot.restart();
    expect(starts(bot.history.get("1", undefined, "key", false, 3600))).toEqual(["t0", "t1"]);
  });
});

describe("auto route", () => {
  test("a route outlives a restart until the cache TTL passes since its last use", async () => {
    const path = await dbPath();
    let now = 1_000_000;
    let store = open(path);
    let memory = new RouteMemory(() => now, store);
    const restart = () => {
      store.close();
      store = open(path);
      memory = new RouteMemory(() => now, store);
    };
    const route = routeLevel(2);
    memory.set("c1", route);
    restart();
    now += ROUTE_CACHE_TTL_MS - 1;
    expect(memory.live("c1")).toEqual(route);
    // The renewal is stored too.
    memory.touch("c1");
    restart();
    now += ROUTE_CACHE_TTL_MS - 1;
    expect(memory.live("c1")).toEqual(route);
    now += 1;
    expect(memory.live("c1")).toBeUndefined();
    restart();
    expect(memory.live("c1")).toBeUndefined();
    memory.prune();
    expect(store.loadRoute("c1")).toBeUndefined();
    memory.set("c1", route);
    memory.clear("c1");
    restart();
    expect(memory.live("c1")).toBeUndefined();
  });
  test("a stored route that is no longer a routing level is not used", async () => {
    const store = open(await dbPath());
    const now = 1_000_000;
    store.saveRoute("retired", { selection: { provider: "anthropic", model: "claude-retired", effort: "medium", routed: true }, at: now });
    store.saveRoute("max", { selection: { provider: "anthropic", model: "claude-opus-5-5", effort: "max", routed: true }, at: now });
    store.saveRoute("other", { selection: { provider: "codex_plus", model: "gpt-6-luna", effort: "medium" }, at: now });
    // Sonnet is no longer a level (#35, 2026-10-10), but a conversation that
    // was on it, or asked for it, keeps it while its cache lasts.
    const sonnet = { provider: "anthropic", model: "claude-sonnet-5-5", effort: "high", routed: true };
    store.saveRoute("sonnet", { selection: sonnet, at: now });
    store.saveRoute("sonnet-xhigh", { selection: { ...sonnet, effort: "xhigh" }, at: now });
    const memory = new RouteMemory(() => now, store);
    for (const channel of ["retired", "max", "other", "sonnet-xhigh"]) expect(memory.live(channel)).toBeUndefined();
    expect(memory.live("sonnet")).toEqual(sonnet);
  });
});

describe("settings at start", () => {
  test("restoring the saved settings does not clear the stored conversations; a change still does", async () => {
    const path = await dbPath();
    const dir = dirs.at(-1)!;
    const cfg = loadConfig({ HIBANA_DATA_DIR: dir, CODEX_PLUS_API_KEY: "test" });
    const before = new Runtime(cfg);
    await before.patch("100", { preset: "sol", effort: "high" }, "300");
    const key = JSON.stringify(before.resolve("100").selection);
    const bot = startBot(path, cfg);
    bot.history.get("1", "100", key, false, 3600);
    bot.history.put("1", turn("t0"), emptyUsage());

    bot.restart();
    const runtime = new Runtime(cfg);
    const changed: (string | undefined)[] = [];
    // Wired as in Hibana.
    runtime.onChange = (id) => {
      changed.push(id);
      bot.history.clearGuild(id);
    };
    await runtime.load();
    expect(runtime.resolve("100").selection.model).toBe("gpt-6.1-sol");
    expect(changed).toEqual([]);
    expect(starts(bot.history.get("1", "100", key, false, 3600))).toEqual(["t0"]);

    await runtime.patch("100", { effort: "low" }, "300");
    expect(changed).toEqual(["100"]);
    bot.restart();
    expect(bot.history.get("1", "100", key, false, 3600)).toEqual([]);
  });
});

test("a restarted bot continues the conversation on the route it had", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hibana-restart-"));
  dirs.push(dir);
  const channel: Context = { channelId: "10000", userId: "20000", botId: "30000", thread: false, depth: 0, delivered: false };
  const usage = { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5, cached_tokens: 0, cache_write_tokens: 0 };
  const sent: string[] = [];
  const requests: { model: string; messages: Message[] }[] = [];
  let routings = 0, score = 5;
  const boot = () => {
    const bot = new Hibana(loadConfig({
      HIBANA_DATA_DIR: dir, PROVIDER: "anthropic", LLM_MODEL: "auto", ANTHROPIC_API_KEY: "anthropic-fixture",
      JEV_API_KEY: "jev-fixture", SANDBOX_ENABLED: "false", SKILLS_ENABLED: "false", LOG_DIR: "",
    }), pino({ enabled: false }));
    bot.runtime.snapshot.user_roles[channel.userId] = "premium";
    bot.client.channels.fetch = (async () => ({
      id: channel.channelId, isSendable: () => true, sendTyping: async () => {},
      send: async (value: { content: string }) => { sent.push(value.content); return { id: "40000", edit: async () => {} }; },
    })) as never;
    bot.tools.tools = () => [];
    bot.tools.jev.decide = (async (input: { questions: Json }) => {
      if (!input.questions.difficulty) throw new Error("not routing");
      routings++;
      return {
        model: "~typesafe/jev-latest", usage, cost: 0,
        answers: { difficulty: { type: "score" as const, score }, requested_model: { type: "choice" as const, choice: "none" } },
      };
    }) as never;
    bot.llm.complete = async (selection, messages) => {
      requests.push({ model: `${selection.model}/${selection.effort}`, messages: structuredClone(messages) });
      return { message: { role: "assistant", content: `reply ${requests.length}` }, usage, incomplete: false };
    };
    // start() opens the store; the rest of start() needs Discord.
    bot.conversations.open();
    return bot;
  };
  const first = boot();
  await first.respond("難しい設計の相談", { ...channel });
  expect(requests.at(-1)!.model).toBe("claude-opus-5-5/high");
  // SIGTERM during a deploy ends in close().
  await first.close();

  const second = boot();
  try {
    // An easy follow-up would be routed to Haiku if Jev were asked again.
    score = 0;
    await second.respond("ありがとう", { ...channel });
    const request = requests.at(-1)!;
    expect(request.model).toBe("claude-opus-5-5/high");
    expect(routings).toBe(1);
    expect(sent.filter((text) => text.startsWith("Auto Routing"))).toEqual(["Auto Routing: **Opus 5.5 High**"]);
    // The turn from before the restart is in the request, ahead of the new one.
    const said = request.messages.filter((m) => m.role === "user" || m.role === "assistant").map((m) => m.content);
    expect(said.slice(-3)).toEqual(["難しい設計の相談", "reply 1", "ありがとう"]);
  } finally { await second.close(); }
});

// What a conversation's later turns send ahead of its history (#177). Claude
// Fable 5.2 binds each thinking block to the `system`, `tools` and `messages`
// that preceded it and answers HTTP 400 when a block comes back after a
// different prefix. The settings at the head of the conversation therefore
// stay as its first request sent them, and a change is added after them.
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { emptyUserOverride } from "@hibana/shared/settings";
import { Hibana } from "../bot";
import { loadConfig } from "../config";
import { ConversationStore, SCHEMA } from "../conversation-store";
import { promptMessages, promptUpdates } from "../harness";
import { History } from "../history";
import { LlmClient, toAnthropic, toChat, type RequestRecord } from "../llm";
import { ProviderError } from "../llm-errors";
import {
  emptyUsage,
  type Context,
  type Json,
  type Message,
  type PromptSections,
} from "../types";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const ALICE = "20000";
const BOB = "20001";
const BOB_CONTEXT = "ボブの個人設定: 敬語を使わない。";

/** A bot whose model requests are recorded instead of sent. `dir` continues
 *  another bot's data directory, as a restart does. */
function turnBot(dir?: string, env: Record<string, string> = {}) {
  if (!dir) {
    dir = mkdtempSync(join(tmpdir(), "hibana-prefix-"));
    dirs.push(dir);
  }
  const bot = new Hibana(
    loadConfig({
      HIBANA_DATA_DIR: dir,
      PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "anthropic-fixture",
      LLM_MODEL: "claude-fable-5-2",
      SANDBOX_ENABLED: "false",
      SKILLS_ENABLED: "false",
      LOG_DIR: "",
      ...env,
    }),
    pino({ enabled: false }),
  );
  const ctx: Context = {
    guildId: "50000",
    channelId: "11000",
    userId: ALICE,
    botId: "30000",
    thread: false,
    depth: 0,
    delivered: false,
  };
  for (const user of [ALICE, BOB])
    bot.runtime.snapshot.user_roles[user] = "premium";
  bot.client.channels.fetch = (async (id: string) => ({
    id,
    guildId: ctx.guildId,
    guild: { members: { fetch: async () => ({}) } },
    permissionsFor: () => ({ has: () => true }),
    isSendable: () => true,
    sendTyping: async () => {},
    send: async () => ({ id: "40000", edit: async () => {} }),
  })) as never;
  bot.tools.tools = () => [];
  const seen: Message[][] = [];
  bot.llm.complete = async (_selection, messages) => {
    seen.push(structuredClone(messages));
    return {
      message: { role: "assistant", content: `reply ${seen.length}` },
      usage: {
        prompt_tokens: 4,
        completion_tokens: 1,
        total_tokens: 5,
        cached_tokens: 0,
        cache_write_tokens: 0,
      },
      incomplete: false,
    };
  };
  // start() opens the store; the rest of start() needs Discord.
  bot.conversations.open();
  return { bot, dir, ctx, seen };
}
/** Bob has personal context that replaces the persona; Alice has neither. */
function personalContext(bot: Hibana, text = BOB_CONTEXT) {
  bot.runtime.snapshot.user_overrides[BOB] = {
    ...emptyUserOverride(),
    context: { text, persona_override: true },
  };
}
const text = (messages: Message[]) =>
  messages.map((m) => m.content ?? "").join("\n");

test("a turn by a person with other settings sends the first turn's request unchanged and adds what differs after it", async () => {
  const t = turnBot();
  personalContext(t.bot);
  await t.bot.respond("一つ目", { ...t.ctx, userId: ALICE });
  await t.bot.respond("二つ目", { ...t.ctx, userId: BOB });
  const [first, second] = t.seen as [Message[], Message[]];
  expect(text(first)).not.toContain(BOB_CONTEXT);
  // Every message the first request sent comes back as it was, so the
  // thinking blocks of the first turn still follow the prefix they were
  // made after.
  expect(second.slice(0, first.length)).toEqual(first);
  // On the wire: the same `system`, and the same first user message.
  const wire = [first, second].map((messages) => toAnthropic(messages));
  expect(wire[1]!.system).toBe(wire[0]!.system);
  expect(wire[1]!.messages[0]).toEqual(wire[0]!.messages[0]!);
  // Bob's settings reach the model after his message.
  const added = second.slice(
    second.findIndex((m) => m.turnStart && m.content === "二つ目"),
  );
  expect(text(added)).toContain(BOB_CONTEXT);
});

const updates = (messages: Message[]) => messages.filter((m) => m.promptUpdate);

test("nothing is added while the settings stay the same, and a change back is added once", async () => {
  const t = turnBot();
  personalContext(t.bot);
  for (const [userId, said] of [
    [ALICE, "一"],
    [BOB, "二"],
    [BOB, "三"],
    [ALICE, "四"],
    [ALICE, "五"],
  ] as const)
    await t.bot.respond(said, { ...t.ctx, userId });
  // Each request repeats every message of the one before it.
  for (let i = 1; i < t.seen.length; i++)
    expect(t.seen[i]!.slice(0, t.seen[i - 1]!.length)).toEqual(t.seen[i - 1]!);
  expect(t.seen.map((messages) => updates(messages).length)).toEqual([
    0, 1, 1, 2, 2,
  ]);
  const [toBob, toAlice] = updates(t.seen[4]!) as [Message, Message];
  expect(toBob.role).toBe("user");
  expect(toBob.promptUpdate).toEqual({ persona: "", context: BOB_CONTEXT });
  expect(toBob.content).toContain(BOB_CONTEXT);
  // Back to the persona the conversation opened with, and no personal context.
  expect(toAlice.promptUpdate!.context).toBe("");
  expect(toAlice.promptUpdate!.persona).toContain("Hibana");
  expect(toAlice.content).toContain(toAlice.promptUpdate!.persona!);
  expect(toAlice.content).not.toContain(BOB_CONTEXT);
});

test("a setting that is stored between two turns leaves the note at the head in place and adds the new one after the history", async () => {
  // The Anthropic API runs without subagents, so its mode note never
  // changes; the Jev note follows a setting anyone can store.
  const t = turnBot(undefined, { JEV_API_KEY: "jev-fixture" });
  await t.bot.respond("一つ目", { ...t.ctx });
  expect(text(t.seen[0]!)).toContain("Jev evaluation is enabled.");
  t.bot.runtime.snapshot.user_overrides[ALICE] = {
    ...emptyUserOverride(),
    jev_enabled: false,
  };
  await t.bot.respond("二つ目", { ...t.ctx });
  const [first, second] = t.seen as [Message[], Message[]];
  expect(toAnthropic(second).system).toBe(toAnthropic(first).system);
  expect(second.slice(0, first.length)).toEqual(first);
  const [note] = updates(second);
  expect(note).toMatchObject({ role: "developer", sticky: true });
  expect(note!.content).toMatch(/^Jev evaluation is no longer enabled\./);
  // It stays in the conversation, so the next turn adds nothing.
  await t.bot.respond("三つ目", { ...t.ctx });
  expect(updates(t.seen[2]!)).toHaveLength(1);
});

test("a restart keeps what the conversation opened with", async () => {
  const before = turnBot();
  await before.bot.respond("一つ目", { ...before.ctx, userId: ALICE });
  await before.bot.close();
  const after = turnBot(before.dir);
  personalContext(after.bot);
  await after.bot.respond("二つ目", { ...after.ctx, userId: BOB });
  const first = before.seen[0]!;
  expect(after.seen[0]!.slice(0, first.length)).toEqual(first);
  expect(updates(after.seen[0]!)).toHaveLength(1);
  await after.bot.close();
});

test("a conversation stored before its opening was kept opens with the settings of its next turn from then on", async () => {
  const before = turnBot();
  await before.bot.respond("一つ目", { ...before.ctx, userId: ALICE });
  await before.bot.close();
  const raw = new Database(join(before.dir, "conversations.db"));
  raw.exec("UPDATE history_channels SET opening = NULL");
  raw.close();
  const after = turnBot(before.dir);
  personalContext(after.bot);
  await after.bot.respond("二つ目", { ...after.ctx, userId: BOB });
  await after.bot.respond("三つ目", { ...after.ctx, userId: ALICE });
  const [second, third] = after.seen as [Message[], Message[]];
  // What the first turn opened with is not on record, so the second turn
  // opens with Bob's settings and adds nothing.
  expect(updates(second)).toEqual([]);
  expect(second.find((m) => m.role === "user")!.content).toContain(BOB_CONTEXT);
  expect(third.slice(0, second.length)).toEqual(second);
  expect(updates(third)).toHaveLength(1);
  await after.bot.close();
});

test("a conversation that starts over opens with the settings of its first turn", async () => {
  const t = turnBot();
  personalContext(t.bot);
  await t.bot.respond("一つ目", { ...t.ctx, userId: ALICE });
  t.bot.history.clear(t.ctx.channelId);
  await t.bot.respond("二つ目", { ...t.ctx, userId: BOB });
  const second = t.seen[1]!;
  expect(updates(second)).toEqual([]);
  expect(second.find((m) => m.role === "user")!.content).toContain(BOB_CONTEXT);
});

describe("promptUpdates", () => {
  const opening: PromptSections = {
    persona: "You are Hibana.",
    operational: "Rules.",
    context: "",
    workspace: "Workspace: /workspace.",
    skills: "- deploy: Deploys.",
    multi_agent_mode: "<multi_agent_mode>explicit</multi_agent_mode>",
    multi_agent_team: "<multi_agent_team>protocol</multi_agent_team>",
    jev: "Jev evaluation is enabled.",
  };
  test("the same settings add nothing", () => {
    expect(promptUpdates(opening, { ...opening }, [])).toEqual([]);
    // A section missing from a stored opening is the empty string.
    const { context, ...stored } = opening;
    expect(promptUpdates(stored, opening, [])).toEqual([]);
  });
  test("policy parts go in one user message that names each part; a part that ended says so", () => {
    const current = {
      ...opening,
      persona: "",
      context: "Speak plainly.",
      skills: "- deploy: Deploys.\n- report: Writes a report.",
    };
    const added = promptUpdates(opening, current, []);
    expect(added).toHaveLength(1);
    const [update] = added as [Message];
    expect(update).toMatchObject({
      role: "user",
      internal: true,
      promptUpdate: {
        persona: "",
        context: "Speak plainly.",
        skills: current.skills,
      },
    });
    expect(update.turnStart).toBeUndefined();
    expect(update.content).toBe(
      [
        "# AGENTS.md instructions update",
        "<INSTRUCTIONS_UPDATE>",
        "Parts of the AGENTS.md instructions given at the start of this conversation have changed. From this point on, each part below replaces the same part as it was given before. Every part that is not listed still applies.",
        "",
        `<part replaces="the assistant's persona">`,
        "Nothing applies for this part now. Disregard what was given for it before.",
        "</part>",
        "",
        `<part replaces="the custom instructions of the server or of the person who is speaking now">`,
        "Speak plainly.",
        "</part>",
        "",
        `<part replaces="the Skills list">`,
        "## Skills",
        "- deploy: Deploys.",
        "- report: Writes a report.",
        "</part>",
        "</INSTRUCTIONS_UPDATE>",
      ].join("\n"),
    );
    // A resumed checkpoint drops the opening message by its heading
    // (checkpoint.ts) and must keep this one; a fork carries both along.
    expect(
      update.content!.startsWith("# AGENTS.md instructions\n<INSTRUCTIONS>"),
    ).toBe(false);
    expect(update.content!.startsWith("# AGENTS.md instructions")).toBe(true);
  });
  test("each mode note is a developer message that stays; a note whose setting went off gets a closing text", () => {
    const current = {
      ...opening,
      multi_agent_mode: "<multi_agent_mode>disabled</multi_agent_mode>",
      multi_agent_team: "",
      jev: "",
    };
    const added = promptUpdates(opening, current, []);
    expect(added.map((m) => [m.role, m.sticky, m.promptUpdate])).toEqual([
      ["developer", true, { multi_agent_mode: current.multi_agent_mode }],
      ["developer", true, { multi_agent_team: "" }],
      ["developer", true, { jev: "" }],
    ]);
    expect(added[0]!.content).toBe(current.multi_agent_mode);
    // forkMessages strips the team's notes from a child by this tag.
    expect(added[1]!.content).toMatch(
      /^<multi_agent_team>Multi-Agent team mode is no longer active\./,
    );
    expect(added[2]!.content).toMatch(/^Jev evaluation is no longer enabled\./);
  });
  test("the last message of the history decides what the model was told, and one that a summary dropped is added again", () => {
    const bob = { ...opening, context: "Bob" };
    const [toBob] = promptUpdates(opening, bob, []) as [Message];
    const history: Message[] = [
      { role: "user", content: "hi", turnStart: true },
      toBob,
      { role: "assistant", content: "ok" },
    ];
    expect(promptUpdates(opening, bob, history)).toEqual([]);
    const [back] = promptUpdates(opening, opening, history) as [Message];
    expect(back.promptUpdate).toEqual({ context: "" });
    expect(promptUpdates(opening, opening, [...history, back])).toEqual([]);
    // The summary replaced the turns that held the update.
    const summarized: Message[] = [
      { role: "user", content: "Conversation summary:\n..." },
    ];
    expect(promptUpdates(opening, bob, summarized)).toHaveLength(1);
  });
  test("the opening messages are the system text, the notes that are on and the AGENTS.md message", () => {
    expect(
      promptMessages("System.", { ...opening, multi_agent_team: "", jev: "" }),
    ).toEqual([
      { role: "system", content: "System." },
      { role: "developer", content: opening.multi_agent_mode! },
      {
        role: "user",
        content:
          "# AGENTS.md instructions\n<INSTRUCTIONS>\nYou are Hibana.\n\nRules.\n\nWorkspace: /workspace.\n\n## Skills\n- deploy: Deploys.\n</INSTRUCTIONS>",
      },
    ]);
  });
  test("the marker never reaches a provider", () => {
    const [update] = promptUpdates(
      opening,
      { ...opening, context: "Bob" },
      [],
    ) as [Message];
    expect(toChat(update)).toEqual({ role: "user", content: update.content });
    expect(JSON.stringify(toAnthropic([update]))).not.toContain("promptUpdate");
  });
});

describe("the opening on disk", () => {
  const key = "key";
  const config = loadConfig({});
  const sections: PromptSections = { persona: "P", context: "C" };
  const turn: Message[] = [
    { role: "user", content: "hi", turnStart: true },
    { role: "assistant", content: "ok" },
  ];
  function dbPath() {
    const dir = mkdtempSync(join(tmpdir(), "hibana-opening-"));
    dirs.push(dir);
    return join(dir, "conversations.db");
  }
  function start(path: string, errors: unknown[] = []) {
    const store = new ConversationStore(path, (e) => errors.push(e));
    store.open();
    return { store, history: new History(config, store) };
  }
  test("it is stored with the first turn and read back after a restart; before a turn is stored there is none", () => {
    const path = dbPath();
    const first = start(path);
    first.history.get("1", undefined, key, false, 3600);
    first.history.keepOpening("1", sections);
    // A first turn that failed stored nothing: the next one opens anew.
    expect(first.history.opening("1")).toBeUndefined();
    first.history.put("1", turn, emptyUsage());
    expect(first.history.opening("1")).toEqual(sections);
    first.store.close();
    const second = start(path);
    second.history.get("1", undefined, key, false, 3600);
    expect(second.history.opening("1")).toEqual(sections);
    // A later turn keeps it.
    second.history.put("1", turn, emptyUsage());
    second.store.close();
    const third = start(path);
    third.history.get("1", undefined, key, false, 3600);
    expect(third.history.opening("1")).toEqual(sections);
    // Another model ends the conversation, and its opening with it.
    third.history.get("1", undefined, "other", false, 3600);
    third.history.put("1", turn, emptyUsage());
    expect(third.history.opening("1")).toBeUndefined();
    third.store.close();
  });
  test("a file from before gains the column, and its conversations read as they did", () => {
    const path = dbPath();
    const old = new Database(path, { create: true });
    for (const sql of SCHEMA) old.exec(sql);
    const columns = () =>
      (
        old.query("PRAGMA table_info(history_channels)").all() as {
          name: string;
        }[]
      ).map((c) => c.name);
    expect(columns()).not.toContain("opening");
    old
      .query(
        "INSERT INTO history_channels (channel_id, guild_id, key, usage) VALUES ('1', NULL, ?, NULL)",
      )
      .run(key);
    old
      .query(
        "INSERT INTO history_turns (channel_id, seq, at, tokens, summary, messages) VALUES ('1', 0, ?, 5, 0, ?)",
      )
      .run(Date.now(), JSON.stringify(turn));
    old.close();
    const errors: unknown[] = [];
    const now = start(path, errors);
    expect(
      now.history.get("1", undefined, key, false, 3600).map((m) => m.content),
    ).toEqual(["hi", "ok"]);
    expect(now.history.opening("1")).toBeUndefined();
    now.history.keepOpening("1", sections);
    now.history.put("1", turn, emptyUsage());
    now.store.close();
    // The version before this one names the columns it writes, so its
    // statement still runs on the file and leaves the opening as it is.
    const raw = new Database(path);
    raw
      .query(
        `INSERT INTO history_channels (channel_id, guild_id, key, usage) VALUES ('1', NULL, ?, NULL)
        ON CONFLICT (channel_id) DO UPDATE SET guild_id = excluded.guild_id, key = excluded.key, usage = excluded.usage`,
      )
      .run(key);
    raw.close();
    const again = start(path, errors);
    again.history.get("1", undefined, key, false, 3600);
    expect(again.history.opening("1")).toEqual(sections);
    again.store.close();
    expect(errors).toEqual([]);
  });
  test("an opening that cannot be read counts as absent, and the conversation continues", () => {
    const path = dbPath();
    const first = start(path);
    first.history.get("1", undefined, key, false, 3600);
    first.history.keepOpening("1", sections);
    first.history.put("1", turn, emptyUsage());
    first.store.close();
    const raw = new Database(path);
    raw.exec("UPDATE history_channels SET opening = '{not json'");
    raw.close();
    const errors: unknown[] = [];
    const second = start(path, errors);
    expect(second.history.get("1", undefined, key, false, 3600)).toHaveLength(
      2,
    );
    expect(second.history.opening("1")).toBeUndefined();
    expect(errors).toHaveLength(1);
    second.store.close();
  });
});

test("a request to the Anthropic API lets the API drop a thinking block bound to another prefix, and its record counts the drops", async () => {
  const records: RequestRecord[] = [];
  const sent: { headers: Record<string, string>; body: Json }[] = [];
  const stream = [
    {
      type: "message_start",
      message: {
        usage: { input_tokens: 10, output_tokens: 0 },
        input_transformations: [
          {
            type: "thinking_dropped",
            path: "messages.1.content.0",
            reason: "prefix_binding_mismatch",
          },
          {
            type: "thinking_dropped",
            path: "messages.3.content.0",
            reason: "prefix_binding_mismatch",
          },
        ],
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "ok" },
    },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 2 },
    },
    { type: "message_stop" },
  ];
  const client = new LlmClient(
    loadConfig({ ANTHROPIC_API_KEY: "fixture", CLAUDE_MAX_API_KEY: "fixture" }),
    async (_url, init) => {
      sent.push({
        headers: init?.headers as Record<string, string>,
        body: JSON.parse(String(init?.body)),
      });
      return new Response(
        stream
          .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
          .join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
    { onCompletion: (record) => records.push(record) },
  );
  const messages: Message[] = [{ role: "user", content: "Hello" }];
  await client.complete(
    { provider: "anthropic", model: "claude-fable-5-2", effort: "medium" },
    messages,
    [],
    { trace: { channel: "1", agent: "root", round: 0 } },
  );
  expect(sent[0]!.headers["anthropic-beta"]).toBe(
    "thinking-binding-controls-2026-08-01",
  );
  expect(sent[0]!.body.thinking).toEqual({
    type: "adaptive",
    block_binding: { prefix_mismatch_behavior: "drop_block" },
  });
  expect(records[0]).toMatchObject({
    thinking_dropped: 2,
    thinking_drop_reasons: "prefix_binding_mismatch",
  });
});

test("Claude Max, and a request with thinking off, are sent without the beta", async () => {
  const sent: { headers: Record<string, string>; body: Json }[] = [];
  const client = new LlmClient(
    loadConfig({ ANTHROPIC_API_KEY: "fixture", CLAUDE_MAX_API_KEY: "fixture" }),
    async (_url, init) => {
      sent.push({
        headers: init?.headers as Record<string, string>,
        body: JSON.parse(String(init?.body)),
      });
      return Response.json({
        content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    },
  );
  const messages: Message[] = [{ role: "user", content: "Hello" }];
  await client.complete(
    { provider: "claude_max", model: "claude-fable-5-2", effort: "medium" },
    messages,
    [],
  );
  // `thinking.disabled` rejects `block_binding` with HTTP 400.
  await client.complete(
    { provider: "anthropic", model: "claude-haiku-5-5", effort: "none" },
    messages,
    [],
  );
  expect(sent.map((r) => "anthropic-beta" in r.headers)).toEqual([
    false,
    false,
  ]);
  expect(sent.map((r) => r.body.thinking)).toEqual([
    { type: "adaptive" },
    { type: "disabled" },
  ]);
});

test("a response without input_transformations leaves the count out, and an unknown entry is not counted", async () => {
  const records: RequestRecord[] = [];
  const bodies: Json[] = [
    { content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1 } },
    {
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 1 },
      input_transformations: [],
    },
    {
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 1 },
      input_transformations: [
        { type: "thinking_dropped", reason: "model_binding_mismatch" },
        { type: "thinking_dropped", reason: "Not A Code" },
        { type: "something_later", reason: "prefix_binding_mismatch" },
      ],
    },
  ];
  const client = new LlmClient(
    loadConfig({ ANTHROPIC_API_KEY: "fixture" }),
    async () =>
      Response.json(bodies.shift()!, {
        headers: {
          "anthropic-thinking-prefix-mismatch":
            "kind=blocks_modified; pattern=first_message_rewritten; changed_validated=messages.0.content.0",
        },
      }),
    { onCompletion: (record) => records.push(record) },
  );
  for (let i = 0; i < 3; i++)
    await client.complete(
      { provider: "anthropic", model: "claude-fable-5-2", effort: "medium" },
      [{ role: "user", content: "Hello" }],
      [],
      { trace: { channel: "1", agent: "root", round: i } },
    );
  expect(
    records.map((r) => [r.thinking_dropped, r.thinking_drop_reasons]),
  ).toEqual([
    [undefined, undefined],
    [0, undefined],
    [2, "model_binding_mismatch"],
  ]);
  expect(records[2]!.thinking_mismatch).toBe(
    "kind=blocks_modified; pattern=first_message_rewritten; changed_validated=messages.0.content.0",
  );
});

test("an HTTP 400 keeps the API's diagnosis of the changed prefix, and nothing of another shape", async () => {
  const failure = async (header: string) => {
    const client = new LlmClient(
      loadConfig({ ANTHROPIC_API_KEY: "fixture" }),
      async () =>
        Response.json(
          {
            type: "error",
            error: {
              type: "invalid_request_error",
              message:
                "messages.1.content.0: Invalid `signature` in `thinking` block.",
            },
          },
          {
            status: 400,
            headers: { "anthropic-thinking-prefix-mismatch": header },
          },
        ),
    );
    try {
      await client.complete(
        { provider: "anthropic", model: "claude-fable-5-2", effort: "medium" },
        [{ role: "user", content: "Hello" }],
        [],
      );
    } catch (error) {
      return error as ProviderError;
    }
    throw new Error("the request did not fail");
  };
  const diagnosed = await failure(
    "kind=blocks_modified; pattern=first_message_rewritten; changed_validated=messages.0.content.0",
  );
  expect(diagnosed).toBeInstanceOf(ProviderError);
  expect(diagnosed.status).toBe(400);
  expect(diagnosed.diagnostics).toMatchObject({
    type: "invalid_request_error",
    thinking_mismatch:
      "kind=blocks_modified; pattern=first_message_rewritten; changed_validated=messages.0.content.0",
  });
  const other = await failure('text="a user wrote this"');
  expect(other.diagnostics.thinking_mismatch).toBeUndefined();
});

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "discord.js";
import pino from "pino";
import { MODEL_PRESETS } from "@hibana/shared/catalog";
import { emptyUserOverride } from "@hibana/shared/settings";
import { Agent } from "../agent";
import { handleCommand } from "../commands";
import { loadConfig } from "../config";
import { DeprecationNotices, deprecationLine, refuseDeprecatedPreset } from "../deprecation";
import { LlmClient } from "../llm";
import { assertChildSelection, selectChild } from "../multi-agent-policy";
import { Runtime } from "../runtime";
import { ToolRegistry } from "../tools";
import type { Context, Json } from "../types";

// Decision record: #67, docs/adr/0010. Every provider except `anthropic` is
// deprecated: it keeps running, it is no longer a new choice, and whoever is
// on one by their own choice is told once.

const ANTHROPIC = ["anthropic-auto", "anthropic-haiku-5-5", "anthropic-sonnet-5-5", "anthropic-opus-5-5"];
const SOL = { provider: "codex_plus", model: "gpt-6.1-sol" };
const LUNA = { provider: "codex_plus", model: "gpt-6-luna" };

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "hibana-deprecation-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const config = (env: NodeJS.ProcessEnv = {}) =>
  loadConfig({
    PROVIDER: "codex_plus",
    CODEX_PLUS_API_KEY: "plus-fixture",
    CLAUDE_KIRO_API_KEY: "kiro-fixture",
    CLAUDE_MAX_API_KEY: "max-fixture",
    ANTHROPIC_API_KEY: "anthropic-fixture",
    SANDBOX_ENABLED: "false",
    SKILLS_ENABLED: "false",
    RUNTIME_STATE_PATH: "",
    HIBANA_DATA_DIR: dir,
    ...env,
  });
/** `owner` has the plan the Anthropic presets need; `member` is a free user. */
const runtimeWith = (env: NodeJS.ProcessEnv = {}) => {
  const runtime = new Runtime(config(env));
  runtime.snapshot.user_roles.owner = "premium";
  return runtime;
};
const context = (userId = "member"): Context => ({
  guildId: "g1", channelId: "c1", userId, botId: "bot", thread: false, depth: 0, delivered: false,
});

test("selectable is canSelect without the deprecated providers; canSelect and canUse keep their meaning", () => {
  const runtime = runtimeWith();
  for (const id of ["sol", "plus-luna", "opus-5"]) {
    expect(runtime.canSelect(id, "member")).toBe(true);
    expect(runtime.canUse(id, "g1", "member")).toBe(true);
    expect(runtime.selectable(id, "member")).toBe(false);
    expect(runtime.selectable(id, "owner")).toBe(false);
  }
  // A Premium-floor deprecated preset: the plan check is still canSelect's.
  expect(runtime.canSelect("fable-5", "owner")).toBe(true);
  expect(runtime.canSelect("fable-5", "member")).toBe(false);
  expect(runtime.selectable("fable-5", "owner")).toBe(false);
  // The four Anthropic presets, for whoever canSelect already allowed.
  expect(runtime.selectablePresets("owner").map((p): string => p.id)).toEqual(ANTHROPIC);
  expect(runtime.selectablePresets("member")).toEqual([]);
  for (const p of MODEL_PRESETS)
    expect(runtime.selectable(p.id, "owner")).toBe(p.provider === "anthropic" && runtime.canSelect(p.id, "owner"));
  // An unpublished Anthropic preset or a missing key is still not a choice.
  runtime.snapshot.unpublished_presets = [...runtime.snapshot.unpublished_presets, "anthropic-opus-5-5"];
  expect(runtime.selectable("anthropic-opus-5-5", "owner")).toBe(false);
  expect(runtimeWith({ ANTHROPIC_API_KEY: "" }).selectablePresets("owner")).toEqual([]);
  // A retired alias and an unknown id.
  expect(runtime.selectable("plus-6-luna", "owner")).toBe(false);
  expect(runtime.selectable("not-a-model", "owner")).toBe(false);
});

/** Runs one slash command against a real Runtime; only the fields
 *  handleCommand reads are faked. */
async function slash(runtime: Runtime, commandName: string, options: Record<string, string> = {}, userId = "owner", guildId: string | null = "g1") {
  let text = "";
  const i = {
    commandName, user: { id: userId }, guildId, channelId: "c1",
    client: { user: { id: "bot" } }, channel: { isThread: () => false },
    options: { getString: (name: string) => options[name] ?? null, getBoolean: () => null },
    deferReply: async () => {}, reply: async () => {},
    editReply: async (t: string) => { text = t; },
  };
  await handleCommand(i as never, runtime, {} as never, {} as never, {} as never, async () => {}, {} as never);
  return text;
}

test("/switch refuses a new deprecated preset and names the presets the user can pick", async () => {
  const runtime = runtimeWith();
  const refused = await slash(runtime, "switch", { preset: "sol" });
  expect(refused).toBe(
    "エラー: `sol` は非推奨のプロバイダのプリセットのため、新しく選べません。" +
    "選べるプリセット: `anthropic-auto`, `anthropic-haiku-5-5`, `anthropic-sonnet-5-5`, `anthropic-opus-5-5`。" +
    "現在の設定はそのまま使えます。");
  expect(runtime.guild("g1").selection).toMatchObject(LUNA);
  // A free user has nothing to move to, and is told so rather than shown a list.
  const free = await slash(runtime, "switch", { preset: "opus-5" }, "member");
  expect(free).toContain("`opus-5` は非推奨のプロバイダのプリセットのため、新しく選べません。");
  expect(free).toContain("このアカウントで選べる Anthropic のプリセットはありません。");
  expect(free).not.toContain("anthropic-");
  // An Anthropic preset still goes through canSelect: the plan decides.
  expect(await slash(runtime, "switch", { preset: "anthropic-opus-5-5" }, "member"))
    .toBe("エラー: This model is unavailable for your account");
  expect(runtime.guild("g1").selection).toMatchObject(LUNA);
  expect(await slash(runtime, "switch", { preset: "anthropic-opus-5-5" })).toContain('"claude-opus-5-5"');
  expect(runtime.guild("g1").selection).toMatchObject({ provider: "anthropic", model: "claude-opus-5-5" });
  // Having left the default, naming it is a new choice; reset is not.
  expect(await slash(runtime, "switch", { preset: "plus-luna" })).toContain("新しく選べません");
  expect(await slash(runtime, "switch", { preset: "reset" }, "member")).toContain('"gpt-6-luna"');
  expect(runtime.guild("g1").selection).toMatchObject(LUNA);
});

test("/switch keeps working for a server that is already on a deprecated preset", async () => {
  const runtime = runtimeWith();
  // The default server is on plus-luna without having chosen it.
  expect(await slash(runtime, "switch", { preset: "plus-luna", effort: "high" }, "member")).toContain('"effort": "high"');
  // A server that chose `sol` before the deprecation (Runtime.patch itself is unchanged).
  await runtime.patch("g1", { preset: "sol" }, "member");
  expect(await slash(runtime, "switch", { preset: "sol", effort: "low" }, "member")).toContain('"effort": "low"');
  expect(runtime.guild("g1").selection).toEqual({ ...SOL, effort: "low" });
  // Options that select no preset.
  expect(await slash(runtime, "switch", { effort: "high" }, "member")).toContain('"effort": "high"');
  expect(await slash(runtime, "switch", { ultra: "on" }, "member")).toContain('"ultra_mode": true');
  expect(await slash(runtime, "switch", {}, "member")).toContain('"gpt-6.1-sol"');
  expect(runtime.guild("g1").selection).toMatchObject(SOL);
  // Another deprecated preset is a new choice, also for the same model on another account.
  expect(await slash(runtime, "switch", { preset: "pro-sol" }, "member")).toContain("`pro-sol` は非推奨");
  expect(runtime.guild("g1").selection).toMatchObject(SOL);
  // Outside a server the command is refused as before.
  expect(await slash(runtime, "switch", { preset: "sol" }, "member", null)).toBe("エラー: サーバー内で使用してください。");
});

test("/info says the current provider is deprecated, the default included", async () => {
  const runtime = runtimeWith();
  const line = "現在のモデルのプロバイダ（codex_plus）は非推奨です。当面はこのまま使えます。";
  expect(deprecationLine(LUNA)).toBe(line);
  expect(deprecationLine({ provider: "anthropic" })).toBeUndefined();
  const info = await slash(runtime, "info", {}, "member");
  expect(info.startsWith(`${line}\n\`\`\`json\n`)).toBe(true);
  expect(info).toContain('"gpt-6-luna"');
  await runtime.patch("g1", { preset: "anthropic-haiku-5-5" }, "owner");
  expect((await slash(runtime, "info", {}, "member")).startsWith("```json\n")).toBe(true);
  // Other commands' replies are not touched.
  expect((await slash(runtimeWith(), "switch", {}, "member")).startsWith("```json\n")).toBe(true);
});

test("set_bot_model refuses a new deprecated preset, by id or by provider and model", async () => {
  const runtime = runtimeWith();
  const client = new Client({ intents: [] });
  const registry = new ToolRegistry(runtime, client, new Agent(new LlmClient(runtime.config)), pino({ level: "silent" }));
  const run = (args: Json, userId = "owner") => registry.execute("set_bot_model", args, context(userId));
  try {
    for (const args of [{ preset: "sol" }, { provider: "codex_plus", model: "gpt-6.1-sol" }, { preset: "opus-5", effort: "low" }]) {
      const refused = run(args);
      await expect(refused).rejects.toThrow("非推奨のプロバイダのプリセットのため、新しく選べません。");
      await expect(refused).rejects.toThrow("選べるプリセット: `anthropic-auto`, `anthropic-haiku-5-5`, `anthropic-sonnet-5-5`, `anthropic-opus-5-5`。");
    }
    await expect(run({ preset: "sol" }, "member")).rejects.toThrow("このアカウントで選べる Anthropic のプリセットはありません。");
    expect(runtime.guild("g1").selection).toMatchObject(LUNA);
    // The preset the server is on, with another effort; settings without a preset; reset.
    expect((await run({ preset: "plus-luna", effort: "high" }, "member") as Json).selection).toEqual({ ...LUNA, effort: "high" });
    expect((await run({ provider: "codex_plus", model: "gpt-6-luna" }, "member") as Json).selection).toMatchObject(LUNA);
    expect((await run({ ultra_mode: true }, "member") as Json).ultra_mode).toBe(true);
    expect((await run({ preset: "anthropic-haiku-5-5" }) as Json).selection).toMatchObject({ provider: "anthropic", model: "claude-haiku-5-5" });
    await expect(run({ preset: "plus-luna" })).rejects.toThrow("`plus-luna` は非推奨");
    expect((await run({ reset: true }, "member") as Json).selection).toMatchObject(LUNA);
    // What was refused before is refused the same way.
    await expect(run({ preset: "anthropic-haiku-5-5" }, "member")).rejects.toThrow("This model is unavailable for your account");
    await expect(run({ preset: "not-a-model" })).rejects.toThrow();
  } finally { await registry.close(); client.destroy(); }
});

test("a child agent still starts under a deprecated parent, inherited or fixed", async () => {
  const runtime = runtimeWith();
  const ctx = context("member");
  // Parents on a deprecated provider: the default, a chosen one, a Premium-floor one.
  for (const parent of [{ ...LUNA, effort: "max" }, { ...SOL, effort: "max" }, { provider: "claude_kiro", model: "claude-opus-5", effort: "high" }]) {
    expect(() => assertChildSelection(runtime, ctx, parent)).not.toThrow();
    expect(selectChild(runtime, ctx, parent, {})).toEqual(parent);
  }
  const fable = { provider: "claude_max", model: "claude-fable-5-1", effort: "medium" };
  expect(() => assertChildSelection(runtime, context("owner"), fable)).not.toThrow();
  expect(selectChild(runtime, context("owner"), fable, {})).toEqual(fable);
  // The plan floor is still the only thing that stops a child of that parent.
  expect(() => assertChildSelection(runtime, ctx, fable)).toThrow("unavailable");
  // A saved fixed subagent model on a deprecated provider keeps applying…
  await runtime.patch("g1", { subagent_model: { mode: "fixed", preset: "opus-5" } }, "member");
  expect(selectChild(runtime, ctx, { ...LUNA, effort: "max" }, {})).toMatchObject({ provider: "claude_kiro", model: "claude-opus-5" });
  // …and so does a model the parent asks for while the policy leaves it open.
  await runtime.patch("g1", { subagent_model: { mode: "auto" } }, "member");
  expect(selectChild(runtime, ctx, { ...LUNA, effort: "max" }, { model: "sol" })).toMatchObject(SOL);
});

test("refuseDeprecatedPreset ignores what is not a preset choice", () => {
  const runtime = runtimeWith();
  for (const preset of [undefined, null, 5, "reset", "not-a-model", "plus-luna", "anthropic-auto"])
    expect(() => refuseDeprecatedPreset(runtime, "g1", "owner", preset)).not.toThrow();
  expect(() => refuseDeprecatedPreset(runtime, "g1", "owner", "plus-6-sol")).toThrow("`sol` は非推奨");
});

/** A notices object with its posts collected, as turn() would use it. */
function notices(runtime: Runtime, path = join(dir, "notices.json")) {
  const sent: string[] = [];
  const errors: unknown[] = [];
  const store = new DeprecationNotices(runtime, (e) => errors.push(e), path, () => new Date("2026-10-11T00:00:00Z"));
  const announce = (guildId: string | undefined, userId: string) =>
    store.announce(guildId, userId, async (text) => { sent.push(text); });
  return { store, sent, errors, announce, path };
}

test("the notice goes once to a server that chose a deprecated model, through a user who can switch", async () => {
  const runtime = runtimeWith();
  const n = notices(runtime);
  // The default is nobody's choice: nothing is said, whoever asks.
  expect(await n.announce("g1", "owner")).toBe(false);
  expect(await n.announce(undefined, "owner")).toBe(false);
  await runtime.patch("g1", { preset: "sol" }, "member");
  await runtime.patch("g2", { preset: "opus-5" }, "member");
  // A free user cannot switch, so the turn stays quiet and the server is not marked as told.
  expect(await n.announce("g1", "member")).toBe(false);
  expect(n.sent).toEqual([]);
  expect(await n.announce("g1", "owner")).toBe(true);
  expect(n.sent).toEqual([
    "お知らせ: このサーバーで選択中のモデル（Codex Plus / GPT-6.1 Sol）は非推奨のプロバイダです。当面はこのまま使えます。" +
    "`/switch` またはダッシュボードのサーバー設定で Anthropic のプリセット（`anthropic-auto`, `anthropic-haiku-5-5`, `anthropic-sonnet-5-5`, `anthropic-opus-5-5`）に切り替えられます。" +
    "このお知らせは 1 回だけ表示します。",
  ]);
  // Once per server: later turns, other users and other channels say nothing.
  for (const user of ["owner", "member", "owner"]) expect(await n.announce("g1", user)).toBe(false);
  expect(n.sent.length).toBe(1);
  // Another server is another target.
  expect(await n.announce("g2", "owner")).toBe(true);
  expect(n.sent[1]).toContain("Claude Kiro / Claude Opus 5");
  expect(n.errors).toEqual([]);
  await n.store.flush();
  expect(JSON.parse(await readFile(n.path, "utf8"))).toEqual({
    version: 1,
    shown: { "guild:g1": "2026-10-11T00:00:00.000Z", "guild:g2": "2026-10-11T00:00:00.000Z" },
  });
});

test("the notice is not repeated after a restart", async () => {
  const runtime = runtimeWith();
  await runtime.patch("g1", { preset: "sol" }, "member");
  const first = notices(runtime);
  expect(await first.announce("g1", "owner")).toBe(true);
  await first.store.flush();
  // A new process reads the same file.
  const second = notices(runtime);
  expect(await second.announce("g1", "owner")).toBe(false);
  expect(second.sent).toEqual([]);
  // What the first process did not post is still owed.
  await runtime.patch("g2", { preset: "sol" }, "member");
  expect(await second.announce("g2", "owner")).toBe(true);
  await second.store.flush();
  const third = notices(runtime);
  expect(await third.announce("g1", "owner")).toBe(false);
  expect(await third.announce("g2", "owner")).toBe(false);
  expect(third.sent).toEqual([]);
  // The default location is the bot's data directory.
  const inDataDir = new DeprecationNotices(runtime);
  expect(await inDataDir.announce("g1", "owner", async () => {})).toBe(true);
  await inDataDir.flush();
  expect(Object.keys(JSON.parse(await readFile(join(dir, "deprecation_notices.json"), "utf8")).shown)).toEqual(["guild:g1"]);
});

test("a personal deprecated model is the user's own notice; a lapsed plan and Anthropic get none", async () => {
  const runtime = runtimeWith();
  const n = notices(runtime);
  const personal = (userId: string, selection: { provider: string; model: string; effort: string } | null) => {
    runtime.snapshot.user_overrides[userId] = { ...emptyUserOverride(), selection, effort: selection?.effort ?? null };
  };
  personal("owner", { ...SOL, effort: "max" });
  expect(await n.announce("g1", "owner")).toBe(true);
  expect(n.sent[0]).toContain("<@owner> さんのマイ設定で選択中のモデル（Codex Plus / GPT-6.1 Sol）は非推奨のプロバイダです。");
  expect(n.sent[0]).toContain("ダッシュボードのマイ設定で Anthropic のプリセット（`anthropic-auto`");
  // The same user in another server or a DM is the same target.
  expect(await n.announce("g2", "owner")).toBe(false);
  expect(await n.announce(undefined, "owner")).toBe(false);
  // It did not use up the server's own notice.
  await runtime.patch("g1", { preset: "opus-5" }, "member");
  runtime.snapshot.user_roles.other = "premium";
  expect(await n.announce("g1", "other")).toBe(true);
  expect(n.sent[1]).toContain("このサーバーで選択中のモデル（Claude Kiro / Claude Opus 5）");

  // A personal Premium-floor model without the plan runs on the default: nothing to say.
  personal("member", { provider: "claude_max", model: "claude-fable-5-1", effort: "medium" });
  expect(runtime.resolve("g3", "member").selection).toMatchObject(LUNA);
  expect(await n.announce("g3", "member")).toBe(false);
  // A personal model that equals the default is not told apart from the default.
  runtime.snapshot.user_roles.third = "premium";
  personal("third", { ...LUNA, effort: "max" });
  expect(await n.announce("g3", "third")).toBe(false);
  // Anthropic, personal or the server's.
  personal("third", { provider: "anthropic", model: "claude-opus-5-5", effort: "high" });
  expect(await n.announce("g1", "third")).toBe(false);
  await runtime.patch("g4", { preset: "anthropic-haiku-5-5" }, "owner");
  runtime.snapshot.user_roles.fourth = "premium";
  expect(await n.announce("g4", "fourth")).toBe(false);
  expect(n.sent.length).toBe(2);
  await n.store.flush();
  expect(Object.keys(JSON.parse(await readFile(n.path, "utf8")).shown).sort()).toEqual(["guild:g1", "user:owner"]);
});

test("without a preset to move to, nobody is told", async () => {
  const runtime = runtimeWith({ ANTHROPIC_API_KEY: "" });
  await runtime.patch("g1", { preset: "sol" }, "member");
  const n = notices(runtime);
  expect(n.store.due("g1", "owner")).toBeUndefined();
  expect(await n.announce("g1", "owner")).toBe(false);
  expect(n.sent).toEqual([]);
});

test("a notice that could not be sent is tried again, and concurrent turns post it once", async () => {
  const runtime = runtimeWith();
  await runtime.patch("g1", { preset: "sol" }, "member");
  const errors: unknown[] = [];
  const store = new DeprecationNotices(runtime, (e) => errors.push(e), join(dir, "n.json"));
  // Discord refused the message: the turn goes on, and the server is still owed the notice.
  expect(await store.announce("g1", "owner", async () => { throw new Error("Missing Permissions"); })).toBe(false);
  expect(errors.map(String)).toEqual(["Error: Missing Permissions"]);
  expect(store.due("g1", "owner")?.target).toBe("guild:g1");
  // Two turns of one server that start together.
  const sent: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const send = async (text: string) => { sent.push(text); await held; };
  const both = Promise.all([store.announce("g1", "owner", send), store.announce("g1", "owner", send)]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  release();
  expect((await both).sort()).toEqual([false, true]);
  expect(sent.length).toBe(1);
  expect(await store.announce("g1", "owner", send)).toBe(false);
});

test("an unreadable record keeps the bot quiet and is left as it is", async () => {
  const runtime = runtimeWith();
  await runtime.patch("g1", { preset: "sol" }, "member");
  const path = join(dir, "broken.json");
  await writeFile(path, "{ not json");
  const n = notices(runtime, path);
  // Posting anyway could tell every server a second time.
  expect(await n.announce("g1", "owner")).toBe(false);
  expect(await n.announce("g1", "owner")).toBe(false);
  expect(n.sent).toEqual([]);
  expect(n.errors.length).toBe(1);
  await n.store.flush();
  expect(await readFile(path, "utf8")).toBe("{ not json");
});

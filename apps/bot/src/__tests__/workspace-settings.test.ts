import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "discord.js";
import { MODEL_PRESETS, WORKSPACE_PROVIDER, deprecatedProvider, premiumPresetIds, unpublishedPresetIds } from "@hibana/shared/catalog";
import { SUBAGENT_MODES, emptyGuild, emptyUserOverride, subagentMode, subagentModePatch } from "@hibana/shared/settings";
import { Agent } from "../agent";
import { conversationKey, harnessFor, keyHarness, workspaceVariant } from "../claude/select";
import { loadConfig, WORKSPACE_MIN_TURN_CENTS, type Selection } from "../config";
import { refuseDeprecatedPreset } from "../deprecation";
import { assemblePrompt } from "../harness";
import { LlmClient } from "../llm";
import { selectChild } from "../multi-agent-policy";
import { Runtime } from "../runtime";
import { ToolRegistry } from "../tools";
import type { Context } from "../types";
import { turnSelection, ultracodeActive } from "../ultracode";

// Decision record: #76. Anthropic Workspace is a third way to run a turn. It
// has its own key and its own limits, and adding it must leave the two
// harnesses that exist exactly as they were.

const WORKSPACE = ["anthropic-workspace-haiku-5-5", "anthropic-workspace-sonnet-5-5", "anthropic-workspace-opus-5-5"];
const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  PROVIDER: "codex_plus",
  LLM_MODEL: "gpt-6-luna",
  CODEX_PLUS_API_KEY: "fixture",
  ANTHROPIC_API_KEY: "fixture",
  JEV_API_KEY: "fixture",
  SANDBOX_ENABLED: "false",
  SKILLS_ENABLED: "false",
  RUNTIME_STATE_PATH: "",
  // The default comes from the CPU count of the machine running the test.
  WORKFLOW_MAX_CONCURRENT_AGENTS: "8",
  ...extra,
});
/** A bot whose owner set the Workspace key and published the three presets,
 *  which is what production looks like once the provider is in use. `owner`
 *  has the plan the presets need; `member` is a free user. */
const published = (extra: NodeJS.ProcessEnv = {}) => {
  const runtime = new Runtime(loadConfig(env({ ANTHROPIC_WORKSPACE_API_KEY: "fixture", ...extra })));
  runtime.snapshot.unpublished_presets = runtime.snapshot.unpublished_presets.filter((id) => !WORKSPACE.includes(id));
  runtime.snapshot.user_roles.owner = "premium";
  return runtime;
};
const context = (userId = "owner"): Context => ({
  guildId: "g1", channelId: "c1", userId, botId: "bot", thread: false, depth: 0, delivered: false,
});
/** A server row on this provider and model (a catalog preset also fits) with
 *  one of the four stored modes. */
const row = ({ provider, model }: { provider: string; model: string }, mode: (typeof SUBAGENT_MODES)[number], effort = "medium") => ({
  ...emptyGuild(), selection: { provider, model, effort }, effort, ...subagentModePatch(mode),
});

test("the Workspace key is its own: ANTHROPIC_API_KEY never fills it", () => {
  // `ANTHROPIC_AUTH_TOKEN` is the Kiro key's alias in this bot.
  const other = loadConfig(env({ ANTHROPIC_AUTH_TOKEN: "kiro-fixture" }));
  expect(other.endpoints.anthropic_workspace).toEqual({ baseUrl: "https://api.anthropic.com", apiKey: "" });
  expect(other.endpoints.anthropic).toEqual({ baseUrl: "https://api.anthropic.com/v1", apiKey: "fixture" });
  expect(new Runtime(other).providerAvailable(WORKSPACE_PROVIDER)).toBe(false);
  // Nor the other way round.
  const own = loadConfig(env({ ANTHROPIC_API_KEY: "", ANTHROPIC_WORKSPACE_API_KEY: "workspace-fixture" }));
  expect(own.endpoints.anthropic_workspace!.apiKey).toBe("workspace-fixture");
  expect(own.endpoints.anthropic!.apiKey).toBe("");
  expect(new Runtime(own).providerAvailable(WORKSPACE_PROVIDER)).toBe(true);
  expect(new Runtime(own).providerAvailable("anthropic")).toBe(false);
  // The base URL can be replaced. Its form is the client's to normalize.
  expect(loadConfig(env({ ANTHROPIC_WORKSPACE_BASE_URL: "https://gateway.example/" })).endpoints.anthropic_workspace!.baseUrl)
    .toBe("https://gateway.example");
  expect(() => loadConfig(env({ ANTHROPIC_WORKSPACE_BASE_URL: "ftp://gateway.example" }))).toThrow("ANTHROPIC_WORKSPACE_BASE_URL is invalid");
});

test("the presets are a new choice only once they are published and the key is set", async () => {
  // As shipped: unpublished, so nobody is offered them and nobody can pick one.
  const shipped = new Runtime(loadConfig(env({ ANTHROPIC_WORKSPACE_API_KEY: "fixture" })));
  shipped.snapshot.user_roles.owner = "premium";
  for (const id of WORKSPACE) {
    expect(shipped.snapshot.unpublished_presets).toContain(id);
    expect(shipped.canSelect(id, "owner")).toBe(false);
    expect(shipped.selectable(id, "owner")).toBe(false);
  }
  expect(shipped.selectablePresets("owner").map((p): string => p.id))
    .toEqual(["anthropic-auto", "anthropic-haiku-5-5", "anthropic-sonnet-5-5", "anthropic-opus-5-5"]);
  await expect(shipped.patch("g1", { preset: WORKSPACE[0] }, "owner")).rejects.toThrow("This model is unavailable for your account");
  // Published without the key: still not a choice.
  const keyless = published({ ANTHROPIC_WORKSPACE_API_KEY: "" });
  for (const id of WORKSPACE) expect(keyless.canSelect(id, "owner")).toBe(false);

  const runtime = published();
  for (const id of WORKSPACE) {
    expect(runtime.selectable(id, "owner")).toBe(true);
    // The Premium floor is the one `anthropic` has.
    expect(runtime.canSelect(id, "member")).toBe(false);
    // Not deprecated, so `/switch` and `set_bot_model` let it through.
    expect(() => refuseDeprecatedPreset(runtime, "g1", "owner", id)).not.toThrow();
  }
  expect(runtime.selectablePresets("owner").map((p): string => p.id)).toEqual([
    "anthropic-auto", "anthropic-haiku-5-5", "anthropic-sonnet-5-5", "anthropic-opus-5-5", ...WORKSPACE,
  ]);
  expect((await runtime.patch("g1", { preset: "anthropic-workspace-haiku-5-5" }, "owner")).selection)
    .toEqual({ provider: WORKSPACE_PROVIDER, model: "claude-haiku-5-5", effort: "high" });
  // `server_shared`: every member of that server then runs on the server's pick.
  expect(runtime.canUse("anthropic-workspace-haiku-5-5", "g1", "member")).toBe(true);
  expect(runtime.canUse("anthropic-workspace-opus-5-5", "g1", "member")).toBe(false);
  expect(runtime.resolve("g1", "member").selection.provider).toBe(WORKSPACE_PROVIDER);
});

test("a state file from before the Workspace presets existed does not publish them on a bot without the settings API", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hibana-workspace-settings-"));
  try {
    const path = join(dir, "runtime_state.json");
    const others = (ids: string[]) => ids.filter((id) => !WORKSPACE.includes(id));
    // What the version before #76 persisted: the whole snapshot, with the two
    // lists of a catalog that had no Workspace presets. The other presets are
    // not at today's defaults either: opus-5-5 is published, anthropic-haiku-5-5
    // has no plan floor, and sol is unpublished and Premium.
    const stored = {
      guilds: {}, user_contexts: {}, user_overrides: {}, blocked_users: [], user_roles: { owner: "premium" },
      unpublished_presets: [...others(unpublishedPresetIds({})).filter((id) => id !== "opus-5-5"), "sol"],
      premium_presets: [...others(premiumPresetIds({})).filter((id) => id !== "anthropic-haiku-5-5"), "sol"],
    };
    const start = async (extra: NodeJS.ProcessEnv = {}) => {
      const runtime = new Runtime(loadConfig(env({ ANTHROPIC_WORKSPACE_API_KEY: "fixture", RUNTIME_STATE_PATH: path, ...extra })));
      await runtime.load();
      return runtime;
    };
    await writeFile(path, JSON.stringify(stored));
    const runtime = await start();
    // Nothing on this bot can publish a preset, so the key alone must not.
    for (const id of WORKSPACE) {
      expect(runtime.snapshot.unpublished_presets).toContain(id);
      expect(runtime.snapshot.premium_presets).toContain(id);
      for (const user of ["member", "owner"]) expect([id, user, runtime.canSelect(id, user)]).toEqual([id, user, false]);
    }
    for (const user of ["member", "owner"])
      expect(runtime.selectablePresets(user).filter((p) => p.provider === WORKSPACE_PROVIDER)).toEqual([]);
    await expect(runtime.patch("g1", { preset: "anthropic-workspace-opus-5-5" }, "member"))
      .rejects.toThrow("This model is unavailable for your account");
    expect(runtime.resolve("g1", "member").selection.provider).not.toBe(WORKSPACE_PROVIDER);
    // Every other preset keeps the state the file had.
    expect(others(runtime.snapshot.unpublished_presets)).toEqual(stored.unpublished_presets);
    expect(others(runtime.snapshot.premium_presets)).toEqual(stored.premium_presets);
    expect(runtime.snapshot.unpublished_presets).not.toContain("opus-5-5");
    expect(runtime.canSelect("anthropic-haiku-5-5", "member")).toBe(true);
    expect(runtime.canSelect("sol", "owner")).toBe(false);
    // The file is written back with them, and the next start adds nothing more.
    const saved = JSON.parse(await readFile(path, "utf8"));
    expect(saved.unpublished_presets).toEqual(runtime.snapshot.unpublished_presets);
    expect(saved.premium_presets).toEqual(runtime.snapshot.premium_presets);
    const again = await start();
    expect(again.snapshot.unpublished_presets).toEqual(runtime.snapshot.unpublished_presets);
    expect(again.snapshot.premium_presets).toEqual(runtime.snapshot.premium_presets);

    // With the settings API the lists are its to write: what the owner
    // published in the dashboard stays published in the saved snapshot.
    await writeFile(path, JSON.stringify(stored));
    const web = await start({ WEB_API_URL: "http://127.0.0.1:9", WEB_INTERNAL_TOKEN: "fixture" });
    expect(web.snapshot.unpublished_presets).toEqual(stored.unpublished_presets);
    expect(web.snapshot.premium_presets).toEqual(stored.premium_presets);
    expect(web.canSelect("anthropic-workspace-opus-5-5", "owner")).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("configuration is valid without the key, and limits outside their range stop the start", () => {
  const defaults = loadConfig({});
  // Nothing about the default provider changes.
  expect(defaults.selection).toEqual({ provider: "codex_plus", model: "gpt-6-luna", effort: "max" });
  expect(defaults.endpoints.anthropic_workspace!.apiKey).toBe("");
  expect(defaults.anthropicWorkspace).toEqual({
    turnBudgetCents: 100, ultraTurnBudgetCents: 300, dailyBudgetCents: 500, monthlyBudgetCents: 5000,
    turnTimeoutMs: 1_200_000, ultraTurnTimeoutMs: 3_600_000,
    concurrency: 2, inputMaxChars: 60_000,
    networking: "unrestricted", allowedHosts: [], web: true,
  });
  expect(loadConfig({
    ANTHROPIC_WORKSPACE_TURN_BUDGET_USD: "0.25", ANTHROPIC_WORKSPACE_ULTRA_TURN_BUDGET_USD: "1.1",
    ANTHROPIC_WORKSPACE_DAILY_BUDGET_USD: "0.01", ANTHROPIC_WORKSPACE_MONTHLY_BUDGET_USD: "200",
    ANTHROPIC_WORKSPACE_TURN_TIMEOUT_MS: "60000", ANTHROPIC_WORKSPACE_ULTRA_TURN_TIMEOUT_MS: "120000",
    ANTHROPIC_WORKSPACE_MAX_CONCURRENT: "3.9", ANTHROPIC_WORKSPACE_INPUT_MAX_CHARS: "1000",
    ANTHROPIC_WORKSPACE_NETWORKING: " Limited ", ANTHROPIC_WORKSPACE_ALLOWED_HOSTS: "cdn.discordapp.com, api.example.com ,",
    ANTHROPIC_WORKSPACE_WEB_ENABLED: "false",
  }).anthropicWorkspace).toEqual({
    // Whole cents, as the API takes them.
    turnBudgetCents: 25, ultraTurnBudgetCents: 110, dailyBudgetCents: 1, monthlyBudgetCents: 20_000,
    turnTimeoutMs: 60_000, ultraTurnTimeoutMs: 120_000,
    concurrency: 3, inputMaxChars: 1000,
    networking: "limited", allowedHosts: ["cdn.discordapp.com", "api.example.com"], web: false,
  });
  // A turn's limit starts where a turn can start: with less than this, every
  // turn would be refused as if the day's limit were reached. The day's and
  // the month's limits still go down to one cent, which is how to stop it all.
  expect(WORKSPACE_MIN_TURN_CENTS).toBe(5);
  expect(loadConfig({
    ANTHROPIC_WORKSPACE_TURN_BUDGET_USD: "0.05", ANTHROPIC_WORKSPACE_ULTRA_TURN_BUDGET_USD: "0.05",
    ANTHROPIC_WORKSPACE_DAILY_BUDGET_USD: "0.01", ANTHROPIC_WORKSPACE_MONTHLY_BUDGET_USD: "0.01",
  }).anthropicWorkspace).toMatchObject({
    turnBudgetCents: WORKSPACE_MIN_TURN_CENTS, ultraTurnBudgetCents: WORKSPACE_MIN_TURN_CENTS, dailyBudgetCents: 1, monthlyBudgetCents: 1,
  });
  expect(() => loadConfig({ ANTHROPIC_WORKSPACE_TURN_BUDGET_USD: "0.04" }))
    .toThrow("ANTHROPIC_WORKSPACE_TURN_BUDGET_USD must be between 0.05 and 100");
  expect(() => loadConfig({ ANTHROPIC_WORKSPACE_ULTRA_TURN_BUDGET_USD: "0.049" }))
    .toThrow("ANTHROPIC_WORKSPACE_ULTRA_TURN_BUDGET_USD must be between 0.05 and 100");
  // `limited` with no host is allowed: it is the tightest setting.
  expect(loadConfig({ ANTHROPIC_WORKSPACE_NETWORKING: "limited" }).anthropicWorkspace)
    .toMatchObject({ networking: "limited", allowedHosts: [] });

  for (const [key, value] of [
    ["ANTHROPIC_WORKSPACE_TURN_BUDGET_USD", "0"],
    ["ANTHROPIC_WORKSPACE_TURN_BUDGET_USD", "0.001"],
    // Below what a turn needs to start at all (`WORKSPACE_MIN_TURN_CENTS`).
    ["ANTHROPIC_WORKSPACE_TURN_BUDGET_USD", "0.01"],
    ["ANTHROPIC_WORKSPACE_TURN_BUDGET_USD", "0.04"],
    ["ANTHROPIC_WORKSPACE_TURN_BUDGET_USD", "100.01"],
    ["ANTHROPIC_WORKSPACE_TURN_BUDGET_USD", "one"],
    ["ANTHROPIC_WORKSPACE_ULTRA_TURN_BUDGET_USD", "-3"],
    ["ANTHROPIC_WORKSPACE_ULTRA_TURN_BUDGET_USD", "0.04"],
    ["ANTHROPIC_WORKSPACE_ULTRA_TURN_BUDGET_USD", "101"],
    ["ANTHROPIC_WORKSPACE_DAILY_BUDGET_USD", "0"],
    ["ANTHROPIC_WORKSPACE_DAILY_BUDGET_USD", "10001"],
    ["ANTHROPIC_WORKSPACE_MONTHLY_BUDGET_USD", "0"],
    ["ANTHROPIC_WORKSPACE_MONTHLY_BUDGET_USD", "100001"],
    ["ANTHROPIC_WORKSPACE_TURN_TIMEOUT_MS", "0"],
    ["ANTHROPIC_WORKSPACE_TURN_TIMEOUT_MS", "86400001"],
    ["ANTHROPIC_WORKSPACE_ULTRA_TURN_TIMEOUT_MS", "0"],
    ["ANTHROPIC_WORKSPACE_MAX_CONCURRENT", "0"],
    ["ANTHROPIC_WORKSPACE_MAX_CONCURRENT", "65"],
    ["ANTHROPIC_WORKSPACE_INPUT_MAX_CHARS", "0"],
    ["ANTHROPIC_WORKSPACE_INPUT_MAX_CHARS", "1000001"],
    ["ANTHROPIC_WORKSPACE_NETWORKING", "open"],
    ["ANTHROPIC_WORKSPACE_WEB_ENABLED", "maybe"],
  ] as const)
    expect(() => loadConfig({ [key]: value })).toThrow(key);
  // A host list that would not be applied, or that is not host names.
  expect(() => loadConfig({ ANTHROPIC_WORKSPACE_ALLOWED_HOSTS: "api.example.com" }))
    .toThrow("ANTHROPIC_WORKSPACE_ALLOWED_HOSTS requires ANTHROPIC_WORKSPACE_NETWORKING=limited");
  for (const hosts of ["https://api.example.com", "api.example.com:443", "api.example.com/v1", "api example.com"])
    expect(() => loadConfig({ ANTHROPIC_WORKSPACE_NETWORKING: "limited", ANTHROPIC_WORKSPACE_ALLOWED_HOSTS: hosts }))
      .toThrow("ANTHROPIC_WORKSPACE_ALLOWED_HOSTS must be a comma-separated list of host names");

  // As the default provider it needs no key to load either, and starts on Haiku.
  const chosen = loadConfig({ PROVIDER: "anthropic_workspace" });
  expect(chosen.selection).toEqual({ provider: WORKSPACE_PROVIDER, model: "claude-haiku-5-5", effort: "high" });
  expect(loadConfig({ PROVIDER: "anthropic_workspace", LLM_MODEL: "claude-opus-5-5" }).selection.model).toBe("claude-opus-5-5");
  // "auto" is Jev's routing among `anthropic` models and is not extended here.
  expect(() => loadConfig({ PROVIDER: "anthropic_workspace", LLM_MODEL: "auto" }))
    .toThrow("LLM_MODEL=auto is only available with PROVIDER=anthropic");
  expect(loadConfig({ PROVIDER: "anthropic", LLM_MODEL: "auto" }).selection.model).toBe("auto");
});

test("which harness, and keys that never continue another harness's conversation", () => {
  const on = loadConfig(env()), off = loadConfig(env({ ANTHROPIC_HARNESS: "codex" }));
  // `ANTHROPIC_HARNESS` is about `anthropic` only.
  for (const config of [on, off]) expect(harnessFor({ provider: WORKSPACE_PROVIDER }, config)).toBe("workspace");
  expect(harnessFor({ provider: "anthropic" }, on)).toBe("claude");
  expect(harnessFor({ provider: "anthropic" }, off)).toBe("codex");
  for (const p of MODEL_PRESETS.filter((p) => deprecatedProvider(p.provider)))
    for (const config of [on, off]) expect(harnessFor(p, config)).toBe("codex");

  // The two existing keys, byte for byte: stored conversations and
  // checkpoints are filed under these strings.
  const opus: Selection = { provider: "anthropic", model: "claude-opus-5-5", effort: "high" };
  const luna: Selection = { provider: "codex_plus", model: "gpt-6-luna", effort: "max" };
  expect(conversationKey(luna, "codex")).toBe('{"provider":"codex_plus","model":"gpt-6-luna","effort":"max"}');
  expect(conversationKey(opus, "codex")).toBe('{"provider":"anthropic","model":"claude-opus-5-5","effort":"high"}');
  expect(conversationKey(opus, "claude")).toBe('{"provider":"anthropic","model":"claude-opus-5-5","effort":"high","harness":"claude"}');
  expect(conversationKey({ ...opus, routed: true }, "claude"))
    .toBe('{"provider":"anthropic","model":"claude-opus-5-5","effort":"high","routed":true,"harness":"claude"}');
  // The variant belongs to Workspace keys only.
  expect(conversationKey(luna, "codex", "ultra")).toBe(conversationKey(luna, "codex"));
  expect(conversationKey(opus, "claude", "ultra")).toBe(conversationKey(opus, "claude"));

  const haiku: Selection = { provider: WORKSPACE_PROVIDER, model: "claude-haiku-5-5", effort: "high" };
  const plain = conversationKey(haiku, "workspace"), ultra = conversationKey(haiku, "workspace", "ultra");
  expect(plain).toBe('{"provider":"anthropic_workspace","model":"claude-haiku-5-5","effort":"high","harness":"workspace","variant":"plain"}');
  expect(conversationKey(haiku, "workspace", "plain")).toBe(plain);
  expect(ultra).toBe('{"provider":"anthropic_workspace","model":"claude-haiku-5-5","effort":"high","harness":"workspace","variant":"ultra"}');
  // The same model under each of the three is three conversations, and a
  // change of model, effort or variant is another one.
  const same = { ...haiku, provider: "anthropic" };
  const keys = [
    conversationKey(same, "codex"), conversationKey(same, "claude"), conversationKey(haiku, "codex"), plain, ultra,
    conversationKey({ ...haiku, effort: "low" }, "workspace"), conversationKey({ ...haiku, model: "claude-opus-5-5" }, "workspace"),
  ];
  expect(new Set(keys).size).toBe(keys.length);

  expect(keyHarness(plain)).toBe("workspace");
  expect(keyHarness(ultra)).toBe("workspace");
  expect(keyHarness(conversationKey(opus, "claude"))).toBe("claude");
  expect(keyHarness(conversationKey(opus, "codex"))).toBe("codex");
  // Checkpoints written before any of this existed, and anything unknown.
  expect(keyHarness(JSON.stringify([opus, "auto"]))).toBe("codex");
  expect(keyHarness(JSON.stringify({ ...haiku, harness: "other" }))).toBe("codex");
  expect(keyHarness("not json")).toBe("codex");

  expect(workspaceVariant({})).toBe("plain");
  expect(workspaceVariant({ workspace_ultra: false })).toBe("plain");
  expect(workspaceVariant({ workspace_ultra: true })).toBe("ultra");
});

test("resolve turns Hibana's own delegation off for Workspace and reports Haiku Ultra apart", () => {
  const runtime = published();
  const keys = [...Object.keys(emptyGuild()), "ultracode", "workspace_ultra"];
  for (const preset of MODEL_PRESETS.filter((p) => p.provider === WORKSPACE_PROVIDER))
    for (const mode of SUBAGENT_MODES) {
      runtime.snapshot.guilds.g1 = row(preset, mode);
      const settings = runtime.resolve("g1", "member");
      const ultra = preset.model === "claude-haiku-5-5" && mode === "ultra";
      expect(settings.selection).toEqual({ provider: WORKSPACE_PROVIDER, model: preset.model, effort: "medium" });
      // No Agent tool, no Workflow tool, no team, whatever is stored.
      expect([preset.model, mode, settings.subagent_enabled, settings.ultra_mode, settings.multi_agent, settings.ultracode])
        .toEqual([preset.model, mode, false, false, false, false]);
      expect([preset.model, mode, settings.workspace_ultra]).toEqual([preset.model, mode, ultra]);
      expect(workspaceVariant(settings)).toBe(ultra ? "ultra" : "plain");
      expect(Object.keys(settings)).toEqual(keys);
      // Ultra here never forces xhigh: the effort stays the stored one.
      expect(turnSelection(settings.selection, settings.ultracode)).toEqual(settings.selection);
      expect(turnSelection(settings.selection, ultracodeActive(runtime.config, settings))).toEqual(settings.selection);
      // The stored switches are untouched and apply again under another model.
      expect(subagentMode(runtime.guild("g1"))).toBe(mode);
    }

  // One person's own Ultra on a server that is not on Ultra, and the reverse.
  const haiku = { provider: WORKSPACE_PROVIDER, model: "claude-haiku-5-5" };
  runtime.snapshot.guilds.g1 = row(haiku, "on");
  runtime.snapshot.user_overrides.owner = { ...emptyUserOverride(), ...subagentModePatch("ultra") };
  expect(runtime.resolve("g1", "owner").workspace_ultra).toBe(true);
  expect(runtime.resolve("g1", "member").workspace_ultra).toBe(false);
  runtime.snapshot.guilds.g1 = row(haiku, "ultra");
  runtime.snapshot.user_overrides.owner = { ...emptyUserOverride(), subagent_enabled: false };
  expect(runtime.resolve("g1", "owner").workspace_ultra).toBe(false);
  runtime.snapshot.user_overrides.owner = { ...emptyUserOverride(), multi_agent: true };
  expect(runtime.resolve("g1", "owner").workspace_ultra).toBe(false);
  expect(runtime.resolve("g1", "member").workspace_ultra).toBe(true);
  // Their own Workspace model on a server that runs something else.
  runtime.snapshot.guilds.g1 = row({ provider: "codex_plus", model: "gpt-6-luna" }, "ultra", "max");
  runtime.snapshot.user_overrides.owner = { ...emptyUserOverride(), selection: { ...haiku, effort: "low" }, effort: "low" };
  expect(runtime.resolve("g1", "owner")).toMatchObject({
    selection: { ...haiku, effort: "low" }, subagent_enabled: false, ultra_mode: false, ultracode: false, workspace_ultra: true,
  });
  // Without the plan, a personal Workspace model falls back to the default,
  // and the result is an ordinary Codex-side one.
  runtime.snapshot.user_overrides.member = { ...emptyUserOverride(), selection: { ...haiku, effort: "low" }, effort: "low" };
  const fallen = runtime.resolve("g1", "member");
  expect(fallen.selection).toEqual(runtime.config.selection);
  expect("workspace_ultra" in fallen).toBe(false);
  expect(fallen).toMatchObject({ subagent_enabled: true, ultra_mode: true, ultracode: true });

  // The process switches that stop Hibana's own workflows stop Haiku Ultra too.
  for (const off of [{ WORKFLOWS_ENABLED: "false" }, { SUBAGENT_ENABLED: "false" }, { TOOLS_ENABLED: "false" }]) {
    const stopped = published(off);
    stopped.snapshot.guilds.g1 = row(haiku, "ultra");
    // SUBAGENT_ENABLED seeds new rows only; this row stores Ultra explicitly.
    expect(subagentMode(stopped.guild("g1"))).toBe("ultra");
    expect([off, stopped.resolve("g1", "member").workspace_ultra]).toEqual([off, false]);
  }
  // A DM follows the process default.
  const dm = new Runtime(loadConfig({ PROVIDER: "anthropic_workspace", ULTRA_MODE: "true", RUNTIME_STATE_PATH: "" }));
  expect(dm.resolve(undefined, "owner")).toMatchObject({
    selection: { ...haiku, effort: "high" }, subagent_enabled: false, ultra_mode: false, multi_agent: false, ultracode: false, workspace_ultra: true,
  });
});

test("other providers resolve to exactly the same object as before", () => {
  const keys = [...Object.keys(emptyGuild()), "ultracode"];
  for (const extra of [{}, { ANTHROPIC_HARNESS: "codex" }]) {
    const runtime = published(extra);
    const claudeHarness = runtime.config.anthropicHarness === "claude";
    for (const preset of MODEL_PRESETS.filter((p) => p.provider !== WORKSPACE_PROVIDER))
      for (const mode of SUBAGENT_MODES) {
        runtime.snapshot.guilds.g1 = row(preset, mode);
        const settings = runtime.resolve("g1", "owner");
        const stored = subagentModePatch(mode);
        // What `resolve` returned for these three before Workspace existed:
        // the stored switches, except that an Anthropic turn has the Agent
        // tool only (#68) or, on the Codex-style harness, no subagents (#35).
        const expected = preset.provider !== "anthropic"
          ? stored
          : claudeHarness
            ? { subagent_enabled: stored.subagent_enabled, ultra_mode: false, multi_agent: false }
            : { ...stored, subagent_enabled: false };
        expect([preset.id, mode, {
          subagent_enabled: settings.subagent_enabled, ultra_mode: settings.ultra_mode, multi_agent: settings.multi_agent,
        }]).toEqual([preset.id, mode, expected]);
        expect([preset.id, mode, settings.ultracode]).toEqual([preset.id, mode, mode === "ultra" && expected.ultra_mode && expected.subagent_enabled]);
        expect(settings.selection).toEqual({ provider: preset.provider, model: preset.model, effort: "medium" });
        // No new key: `/info` and `get_bot_settings` print this object.
        expect(Object.keys(settings)).toEqual(keys);
        expect("workspace_ultra" in settings).toBe(false);
        expect(workspaceVariant(settings)).toBe("plain");
      }
  }
});

test("with the Workspace key and the presets published, the tool surface of both harnesses is byte-identical", async () => {
  /** Everything a turn sends that is built from the catalog: the tool list,
   *  the prompt, and the workflow reference. */
  const surfaces = async (runtime: Runtime) => {
    const client = new Client({ intents: [] });
    const registry = new ToolRegistry(runtime, client, new Agent(new LlmClient(runtime.config)));
    registry.sandbox.available = true;
    runtime.snapshot.user_roles.u1 = "administrator";
    const out: Record<string, unknown> = {};
    try {
      for (const selection of [
        { provider: "codex_plus", model: "gpt-6-luna" },
        { provider: "claude_max", model: "claude-opus-5-5" },
        { provider: "anthropic", model: "claude-haiku-5-5" },
      ])
        for (const mode of SUBAGENT_MODES) {
          runtime.snapshot.guilds.g1 = row(selection, mode, "high");
          const claude = harnessFor(selection, runtime.config) === "claude";
          const ctx: Context = { ...context("u1"), ...(claude ? { harness: "claude" as const } : { team: {} as Context["team"] }) };
          out[`${selection.provider} ${mode}`] = {
            tools: registry.tools(ctx),
            prompt: await assemblePrompt(runtime, ctx, "- example-skill: An example."),
            reference: registry.workflowReference(ctx),
            settings: runtime.resolve(ctx.guildId, ctx.userId),
          };
        }
    } finally { await registry.close(); client.destroy(); }
    return out;
  };
  const without = new Runtime(loadConfig(env()));
  const withKey = published();
  // The comparison means something only if the presets could be listed.
  for (const id of WORKSPACE) {
    expect(without.canSelect(id, "u1")).toBe(false);
    withKey.snapshot.user_roles.u1 = "administrator";
    expect(withKey.canSelect(id, "u1")).toBe(true);
  }
  const before = await surfaces(without), after = await surfaces(withKey);
  expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  // The Codex-side texts do list presets, and the reader of them is a child's
  // model argument: the Workspace presets must not appear there.
  const spawn = (after["codex_plus on"] as { tools: { function: { name: string; description: string } }[] }).tools
    .find((t) => t.function.name === "agents__spawn_agent")!.function.description;
  expect(spawn).toContain("Available model presets: ");
  expect(spawn).toContain("anthropic-haiku-5-5");
  expect(JSON.stringify(after)).not.toContain("anthropic-workspace");
  expect(JSON.stringify(after)).not.toContain(WORKSPACE_PROVIDER);
});

test("a child cannot be given a Workspace preset, and claude-haiku-5-5 by name still resolves to anthropic", async () => {
  const runtime = published();
  const ctx = context();
  const parent: Selection = { provider: "codex_plus", model: "gpt-6-luna", effort: "max" };
  // Two presets now carry this model name. A child asked for it by name gets
  // the one it always got, from a parent on any provider.
  expect(MODEL_PRESETS.filter((p) => p.model === "claude-haiku-5-5").map((p): string => p.provider))
    .toEqual(["anthropic", WORKSPACE_PROVIDER]);
  expect(selectChild(runtime, ctx, parent, { model: "claude-haiku-5-5" }))
    .toEqual({ provider: "anthropic", model: "claude-haiku-5-5", effort: "high" });
  expect(selectChild(runtime, ctx, parent, { model: "anthropic-haiku-5-5" }))
    .toEqual({ provider: "anthropic", model: "claude-haiku-5-5", effort: "high" });
  // Naming a Workspace preset is refused with the message an unknown id gets.
  for (const id of WORKSPACE)
    expect(() => selectChild(runtime, ctx, parent, { model: id }))
      .toThrow("Unknown or ambiguous subagent model; use an available preset id");
  // A fixed policy cannot store one: the PATCH is refused before anything is saved.
  for (const patch of [
    { subagent_model: { mode: "fixed", preset: "anthropic-workspace-haiku-5-5" } },
    { multi_agent_roles: { worker: { model: { mode: "fixed", preset: "anthropic-workspace-opus-5-5" } } } },
  ])
    await expect(runtime.patch("g1", patch, "owner")).rejects.toThrow("Anthropic Workspace presets cannot be a subagent model");
  expect(runtime.guild("g1").subagent_model).toEqual({ mode: "auto" });
  // The same model on `anthropic` is still a fixed child model.
  expect((await runtime.patch("g1", { subagent_model: { mode: "fixed", preset: "anthropic-haiku-5-5" } }, "owner")).subagent_model)
    .toEqual({ mode: "fixed", preset: "anthropic-haiku-5-5" });
});

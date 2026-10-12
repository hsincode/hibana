import { expect, test } from "bun:test";
import {
  MODEL_PRESETS,
  PRESET_IDS,
  SELECTABLE_PRESETS,
  catalogPublished,
  deprecatedPreset,
  deprecatedProvider,
  isPresetId,
  subagentsUnsupported,
} from "../catalog";
import {
  applyPatch,
  applyUserOverridePatch,
  defaultMultiAgentRoles,
  emptyGuild,
  emptyUserOverride,
  guildPatchSchema,
  newlyDeprecatedPresetIds,
  normalizeGuild,
  normalizeUserOverride,
  settingsDefaults,
  userOverridePatchSchema,
  type GuildPatch,
  type GuildRow,
  type SavedPresets,
  type UserOverrideRow,
} from "../settings";

// Decision record: #67, ADR-0010. `anthropic_workspace` is Anthropic's own
// API too and is not deprecated (#76).

/** Typed as the PATCH body the API and the bot pass in. */
const refused = (saved: SavedPresets | null, patch: GuildPatch) => newlyDeprecatedPresetIds(saved, patch);

test("every provider except anthropic and anthropic_workspace is deprecated, and presets follow their provider", () => {
  expect(deprecatedProvider("anthropic")).toBe(false);
  expect(deprecatedProvider("anthropic_workspace")).toBe(false);
  for (const provider of ["codex_plus", "codex_pro", "chatgpt", "claude_max", "claude_kiro", "deepseek",
    "grok_free", "grok_heavy", "codex_gemini", "openai", "xai", "openrouter", "orca_router", "custom"])
    expect(deprecatedProvider(provider)).toBe(true);
  for (const p of MODEL_PRESETS)
    expect(deprecatedPreset(p.id)).toBe(!["anthropic", "anthropic_workspace"].includes(p.provider));
  expect(MODEL_PRESETS.filter((p) => !deprecatedPreset(p.id)).map((p) => p.id))
    .toEqual(["anthropic-auto", "anthropic-haiku-5-5", "anthropic-sonnet-5-5", "anthropic-opus-5-5",
      "anthropic-workspace-haiku-5-5", "anthropic-workspace-sonnet-5-5", "anthropic-workspace-opus-5-5"]);
  // A retired alias is judged as the preset it now points at.
  expect(deprecatedPreset("plus-6-luna")).toBe(true);
  // Not a preset at all: the PATCH schemas reject it before this is asked.
  expect(deprecatedPreset("not-a-model")).toBe(false);
});

test("deprecation leaves the catalog's other answers alone", () => {
  // Still presets: saved fixed subagent models would otherwise be dropped on read.
  for (const id of ["sol", "plus-luna", "fable-5", "opus-5", "ds-deepseek-flash"]) {
    expect(isPresetId(id)).toBe(true);
    expect(PRESET_IDS).toContain(id as (typeof PRESET_IDS)[number]);
    // Not `published: false`: that would also stop `canUse` in the bot.
    expect(catalogPublished(id)).toBe(true);
  }
  expect(SELECTABLE_PRESETS.length).toBe(MODEL_PRESETS.filter((p) => p.provider !== "grok_free").length);
  expect(subagentsUnsupported("anthropic")).toBe(true);
  expect(subagentsUnsupported("codex_plus")).toBe(false);
  // The schemas accept them too: /internal routes and the bot still write them.
  for (const schema of [guildPatchSchema, userOverridePatchSchema])
    expect(schema.safeParse({ preset: "sol", subagent_model: { mode: "fixed", preset: "opus-5" } }).success).toBe(true);
});

test("the default and saved deprecated selections are not converted", () => {
  expect(emptyGuild().selection).toEqual({ provider: "codex_plus", model: "gpt-6-luna", effort: "max" });
  expect(settingsDefaults({}).selection).toEqual({ provider: "codex_plus", model: "gpt-6-luna", effort: "max" });
  const roles = {
    ...defaultMultiAgentRoles(),
    reviewer: { model: { mode: "fixed" as const, preset: "fable-5" }, effort: { mode: "default" as const } },
  };
  for (const selection of [
    { provider: "codex_plus", model: "gpt-6.1-sol", effort: "max" },
    { provider: "claude_max", model: "claude-fable-5-1", effort: "medium" },
    { provider: "claude_kiro", model: "claude-opus-5", effort: "high" },
    { provider: "deepseek", model: "deepseek-flash", effort: "max" },
  ]) {
    const saved = { selection, effort: selection.effort, subagent_model: { mode: "fixed" as const, preset: "sol" }, multi_agent_roles: roles };
    const guild = normalizeGuild(saved);
    expect(guild.selection).toEqual(selection);
    expect(guild.subagent_model).toEqual({ mode: "fixed", preset: "sol" });
    expect(guild.multi_agent_roles).toEqual(roles);
    const user = normalizeUserOverride(saved);
    expect(user.selection).toEqual(selection);
    expect(user.subagent_model).toEqual({ mode: "fixed", preset: "sol" });
    expect(user.multi_agent_roles).toEqual(roles);
    // A PATCH of something else keeps them as well.
    expect(applyPatch(guild, { jev_enabled: false }).selection).toEqual(selection);
    expect(applyUserOverridePatch(user, { jev_enabled: false }).selection).toEqual(selection);
  }
});

test("reset passes and still restores the deprecated default", () => {
  const onSol: GuildRow = { ...emptyGuild(), selection: { provider: "codex_plus", model: "gpt-6.1-sol", effort: "max" } };
  const onOpus: GuildRow = { ...emptyGuild(), selection: { provider: "anthropic", model: "claude-opus-5-5", effort: "high" } };
  for (const row of [onSol, onOpus, emptyGuild()]) {
    expect(refused(row, { preset: "reset" })).toEqual([]);
    expect(applyPatch(row, { preset: "reset" }).selection).toEqual(emptyGuild().selection);
  }
  const personal: UserOverrideRow = { ...emptyUserOverride(), selection: onSol.selection };
  expect(refused(personal, { preset: "reset" })).toEqual([]);
  expect(applyUserOverridePatch(personal, { preset: "reset" }).selection).toBeNull();
  // Clearing the other slots selects nothing either.
  expect(refused(onSol, { subagent_model: null, multi_agent_roles: null })).toEqual([]);
  expect(refused(onSol, { subagent_model: { mode: "auto" } })).toEqual([]);
});

test("the main preset: the saved one passes, another deprecated one is refused", () => {
  const onSol: GuildRow = { ...emptyGuild(), selection: { provider: "codex_plus", model: "gpt-6.1-sol", effort: "low" } };
  expect(refused(onSol, { preset: "sol" })).toEqual([]);
  expect(refused(onSol, { preset: "sol", effort: "high" })).toEqual([]);
  // The same model on another account is another preset.
  expect(refused(onSol, { preset: "pro-sol" })).toEqual(["pro-sol"]);
  expect(refused(onSol, { preset: "plus-luna" })).toEqual(["plus-luna"]);
  expect(refused(onSol, { preset: "anthropic-opus-5-5" })).toEqual([]);
  // The default row is on plus-luna, so naming it again changes nothing.
  expect(refused(emptyGuild(), { preset: "plus-luna" })).toEqual([]);
  expect(refused(emptyGuild(), { preset: "plus-6-luna" })).toEqual([]);
  expect(refused(emptyGuild(), { preset: "sol" })).toEqual(["sol"]);
  // A saved wire id from before a rename still counts as the same preset.
  const legacy = { selection: { provider: "codex_plus", model: "gpt-6-sol" } };
  expect(refused(legacy, { preset: "sol" })).toEqual([]);
  // A personal row that follows the server has no saved preset: any deprecated one is new.
  expect(refused(emptyUserOverride(), { preset: "plus-luna" })).toEqual(["plus-luna"]);
  expect(refused(null, { preset: "fable-5" })).toEqual(["fable-5"]);
  expect(refused(null, { preset: "anthropic-auto" })).toEqual([]);
  // A PATCH that selects no preset is never refused.
  expect(refused(onSol, { effort: "high" })).toEqual([]);
});

test("subagent and role presets are compared slot by slot", () => {
  const roles = {
    ...defaultMultiAgentRoles(),
    reviewer: { model: { mode: "fixed" as const, preset: "sol" }, effort: { mode: "default" as const } },
  };
  const saved: GuildRow = { ...emptyGuild(), subagent_model: { mode: "fixed", preset: "opus-5" }, multi_agent_roles: roles };
  expect(refused(saved, { subagent_model: { mode: "fixed", preset: "opus-5" } })).toEqual([]);
  expect(refused(saved, { subagent_model: { mode: "fixed", preset: "sol" } })).toEqual(["sol"]);
  expect(refused(saved, { subagent_model: { mode: "fixed", preset: "anthropic-haiku-5-5" } })).toEqual([]);
  expect(refused(emptyGuild(), { subagent_model: { mode: "fixed", preset: "opus-5" } })).toEqual(["opus-5"]);

  // The dashboard sends every role on each edit: the unchanged reviewer passes.
  expect(refused(saved, { multi_agent_roles: {
    ...roles, explorer: { model: { mode: "same" }, effort: { mode: "fixed", effort: "low" } },
  } })).toEqual([]);
  expect(refused(saved, { multi_agent_roles: {
    ...roles, explorer: { model: { mode: "fixed", preset: "anthropic-haiku-5-5" } },
  } })).toEqual([]);
  // The same deprecated preset in a role that did not have it is a new choice.
  expect(refused(saved, { multi_agent_roles: {
    ...roles, worker: { model: { mode: "fixed", preset: "sol" } },
  } })).toEqual(["sol"]);
  expect(refused(saved, { multi_agent_roles: { reviewer: { model: { mode: "fixed", preset: "fable-5" } } } }))
    .toEqual(["fable-5"]);
  // A personal row with no role table yet has nothing saved to keep.
  expect(refused(emptyUserOverride(), { multi_agent_roles: roles })).toEqual(["sol"]);
  // Every offending id is reported once, in the order the slots are read.
  expect(refused(emptyGuild(), {
    preset: "sol",
    subagent_model: { mode: "fixed", preset: "pro-luna" },
    multi_agent_roles: { reviewer: { model: { mode: "fixed", preset: "sol" } }, worker: { model: { mode: "fixed", preset: "fable-5" } } },
  })).toEqual(["sol", "pro-luna", "fable-5"]);
});

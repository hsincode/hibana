import { expect, test } from "bun:test";
import {
  AUTO_ROUTE_PROVIDER,
  MODEL_PRESETS,
  WORKSPACE_PROVIDER,
  WORKSPACE_ULTRA_MODEL,
  agentToolOnly,
  catalogPremium,
  catalogPublished,
  deprecatedPreset,
  isAutoRoute,
  isChildPresetId,
  isPresetId,
  premiumPresetIds,
  serverShared,
  subagentsUnsupported,
  ultraSupported,
  unpublishedPresetIds,
} from "../catalog";
import {
  SUBAGENT_MODES,
  applyPatch,
  applyUserOverridePatch,
  defaultMultiAgentRoles,
  effectiveSubagentMode,
  emptyGuild,
  emptyUserOverride,
  guildPatchSchema,
  newlyDeprecatedPresetIds,
  normalizeGuild,
  normalizeUserOverride,
  roleModelSchema,
  settingsDefaults,
  subagentModePatch,
  subagentModelSchema,
  userOverridePatchSchema,
  type SubagentMode,
} from "../settings";

// Decision record: #76. Anthropic Workspace is a provider of its own: the
// models `anthropic` has, run as Claude Managed Agents sessions.

const WORKSPACE = ["anthropic-workspace-haiku-5-5", "anthropic-workspace-sonnet-5-5", "anthropic-workspace-opus-5-5"];
const workspace = (model: string) => ({ provider: WORKSPACE_PROVIDER, model });

test("the three Workspace presets are unpublished, Premium-floor and server-shared, Haiku first", () => {
  const presets = MODEL_PRESETS.filter((p) => p.provider === WORKSPACE_PROVIDER);
  expect(presets.map((p): string => p.id)).toEqual(WORKSPACE);
  // The models are the ones `anthropic` offers, under the same wire ids.
  expect(presets.map((p): string => p.model)).toEqual(["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"]);
  for (const p of presets)
    expect(MODEL_PRESETS.some((a) => a.provider === "anthropic" && a.model === p.model)).toBe(true);
  // The dashboard finds a provider by the first half of a label.
  for (const p of presets) expect(p.label.startsWith("Anthropic Workspace / ")).toBe(true);
  for (const id of WORKSPACE) {
    expect(isPresetId(id)).toBe(true);
    expect(catalogPublished(id)).toBe(false);
    expect(catalogPremium(id)).toBe(true);
    expect(serverShared(id)).toBe(true);
    expect(deprecatedPreset(id)).toBe(false);
    expect(unpublishedPresetIds({})).toContain(id);
    expect(premiumPresetIds({})).toContain(id);
    // Publishing is the existing admin override; nothing else is needed.
    expect(unpublishedPresetIds({ [id]: true })).not.toContain(id);
    // Selecting one as the main model is an ordinary preset PATCH.
    expect(newlyDeprecatedPresetIds(emptyGuild(), { preset: id })).toEqual([]);
  }
  const row = applyPatch(emptyGuild(), { preset: "anthropic-workspace-haiku-5-5" });
  expect(row.selection).toEqual({ provider: WORKSPACE_PROVIDER, model: "claude-haiku-5-5", effort: "high" });
  // Each provider + model pair still names exactly one preset.
  const pairs = MODEL_PRESETS.map((p) => `${p.provider} ${p.model}`);
  expect(new Set(pairs).size).toBe(pairs.length);
});

test("auto routing is not extended to Workspace", () => {
  expect(MODEL_PRESETS.some((p) => p.provider === WORKSPACE_PROVIDER && (p.model as string) === "auto")).toBe(false);
  expect(AUTO_ROUTE_PROVIDER).toBe("anthropic");
  expect(isAutoRoute(workspace("auto"))).toBe(false);
  // Neither of the two `anthropic` predicates covers the new provider.
  expect(subagentsUnsupported(WORKSPACE_PROVIDER)).toBe(false);
  expect(agentToolOnly(WORKSPACE_PROVIDER)).toBe(false);
});

test("Ultra applies to Workspace only on Haiku 5.5", () => {
  expect(WORKSPACE_ULTRA_MODEL).toBe("claude-haiku-5-5");
  expect(ultraSupported(workspace("claude-haiku-5-5"))).toBe(true);
  expect(ultraSupported(workspace("claude-sonnet-5-5"))).toBe(false);
  expect(ultraSupported(workspace("claude-opus-5-5"))).toBe(false);
  // Elsewhere it says what it always meant: the Agent tool has no Ultra.
  expect(ultraSupported({ provider: "anthropic", model: "claude-haiku-5-5" })).toBe(false);
  expect(ultraSupported({ provider: "codex_plus", model: "gpt-6-luna" })).toBe(true);

  const table: [{ provider: string; model: string } | null, Record<SubagentMode, SubagentMode>][] = [
    [workspace("claude-haiku-5-5"), { off: "off", on: "off", ultra: "ultra", multi: "off" }],
    [workspace("claude-sonnet-5-5"), { off: "off", on: "off", ultra: "off", multi: "off" }],
    [workspace("claude-opus-5-5"), { off: "off", on: "off", ultra: "off", multi: "off" }],
    [{ provider: "anthropic", model: "claude-haiku-5-5" }, { off: "off", on: "on", ultra: "on", multi: "on" }],
    [{ provider: "anthropic", model: "auto" }, { off: "off", on: "on", ultra: "on", multi: "on" }],
    [{ provider: "codex_plus", model: "gpt-6-luna" }, { off: "off", on: "on", ultra: "ultra", multi: "multi" }],
    [{ provider: "claude_max", model: "claude-opus-5-5" }, { off: "off", on: "on", ultra: "ultra", multi: "multi" }],
    [null, { off: "off", on: "on", ultra: "ultra", multi: "multi" }],
  ];
  for (const [selection, expected] of table)
    for (const mode of SUBAGENT_MODES)
      expect([selection, mode, effectiveSubagentMode(subagentModePatch(mode), selection)])
        .toEqual([selection, mode, expected[mode]]);
  expect(effectiveSubagentMode(subagentModePatch("ultra"), undefined)).toBe("ultra");
  // A stale Ultra flag under "off" stays off, as in subagentMode().
  expect(effectiveSubagentMode({ subagent_enabled: false, ultra_mode: true }, workspace("claude-haiku-5-5"))).toBe("off");
  // The stored switches are not what changes: another model uses them again.
  const row = applyPatch(applyPatch(emptyGuild(), subagentModePatch("multi")), { preset: "anthropic-workspace-opus-5-5" });
  expect([row.subagent_enabled, row.ultra_mode, row.multi_agent]).toEqual([true, true, true]);
  expect(effectiveSubagentMode(row, row.selection)).toBe("off");
  expect(effectiveSubagentMode(row, applyPatch(row, { preset: "sol" }).selection)).toBe("multi");
});

test("a Workspace preset cannot be a fixed subagent or role model, and a saved one is dropped on read", () => {
  const message = "Anthropic Workspace presets cannot be a subagent model";
  for (const id of WORKSPACE) {
    expect(isChildPresetId(id)).toBe(false);
    for (const schema of [subagentModelSchema, roleModelSchema]) {
      const result = schema.safeParse({ mode: "fixed", preset: id });
      expect(result.success).toBe(false);
      expect(result.error!.issues.map((issue) => issue.message)).toEqual([message]);
    }
    for (const schema of [guildPatchSchema, userOverridePatchSchema]) {
      expect(schema.safeParse({ subagent_model: { mode: "fixed", preset: id } }).success).toBe(false);
      expect(schema.safeParse({ multi_agent_roles: { reviewer: { model: { mode: "fixed", preset: id } } } }).success).toBe(false);
      // The main model is where a Workspace preset belongs.
      expect(schema.safeParse({ preset: id }).success).toBe(true);
    }
  }
  // Every other preset is a child preset exactly as before, aliases included.
  for (const p of MODEL_PRESETS.filter((p) => p.provider !== WORKSPACE_PROVIDER))
    expect([p.id, isChildPresetId(p.id)]).toEqual([p.id, isPresetId(p.id)]);
  expect(isChildPresetId("plus-6-luna")).toBe(true);
  expect(isChildPresetId("not-a-model")).toBe(false);
  for (const id of ["sol", "opus-5", "fable-5", "anthropic-haiku-5-5", "plus-6-luna"]) {
    expect(subagentModelSchema.safeParse({ mode: "fixed", preset: id }).success).toBe(true);
    expect(roleModelSchema.safeParse({ mode: "fixed", preset: id }).success).toBe(true);
  }
  // An id the catalog does not know is reported as unknown, and only as that.
  expect(subagentModelSchema.safeParse({ mode: "fixed", preset: "not-a-model" }).error!.issues.map((i) => i.message))
    .toEqual(["unknown subagent preset"]);
  expect(roleModelSchema.safeParse({ mode: "fixed", preset: "not-a-model" }).error!.issues.map((i) => i.message))
    .toEqual(["unknown role preset"]);

  // A row that somehow stores one reads as the default policy; the other
  // roles' saved choices are kept.
  const fixed = { mode: "fixed" as const, preset: "anthropic-workspace-haiku-5-5" };
  const roles = {
    ...defaultMultiAgentRoles(),
    explorer: { model: fixed, effort: { mode: "fixed" as const, effort: "low" as const } },
    reviewer: { model: { mode: "fixed" as const, preset: "fable-5" }, effort: { mode: "default" as const } },
  };
  const guild = normalizeGuild({ subagent_model: fixed, multi_agent_roles: roles });
  expect(guild.subagent_model).toEqual({ mode: "auto" });
  expect(guild.multi_agent_roles!.explorer).toEqual({ model: { mode: "default" }, effort: { mode: "fixed", effort: "low" } });
  expect(guild.multi_agent_roles!.reviewer.model).toEqual({ mode: "fixed", preset: "fable-5" });
  const user = normalizeUserOverride({ ...emptyUserOverride(), subagent_model: fixed, multi_agent_roles: roles });
  expect(user.subagent_model).toBeNull();
  expect(user.multi_agent_roles!.explorer.model).toEqual({ mode: "default" });
  // The retired `subagent_preset` field is read through the same check.
  expect(normalizeGuild({ subagent_preset: "anthropic-workspace-opus-5-5" } as never).subagent_model).toEqual({ mode: "auto" });
  expect(normalizeGuild({ subagent_preset: "sol" } as never).subagent_model).toEqual({ mode: "fixed", preset: "sol" });
  // A patch that was built without the schema still cannot store one.
  expect(applyPatch(emptyGuild(), { subagent_model: fixed }).subagent_model).toEqual({ mode: "auto" });
  expect(applyUserOverridePatch(emptyUserOverride(), { subagent_model: fixed }).subagent_model).toBeNull();
});

test("PROVIDER=anthropic_workspace seeds Haiku", () => {
  const row = settingsDefaults({ PROVIDER: "anthropic_workspace" });
  expect(row.selection).toEqual({ provider: WORKSPACE_PROVIDER, model: "claude-haiku-5-5", effort: "high" });
  expect(row.effort).toBe("high");
  expect(settingsDefaults({ PROVIDER: "ANTHROPIC_WORKSPACE", LLM_MODEL: "claude-opus-5-5", LLM_EFFORT: "medium" }).selection)
    .toEqual({ provider: WORKSPACE_PROVIDER, model: "claude-opus-5-5", effort: "medium" });
  // The default provider is what it was.
  expect(settingsDefaults({}).selection).toEqual({ provider: "codex_plus", model: "gpt-6-luna", effort: "max" });
});

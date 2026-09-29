import { z } from "zod";
import {
  BUILTIN_TRIGGERS,
  EFFORTS,
  EXA_MODES,
  MODEL_PRESETS,
  TRIGGER_EXTRA_MAX,
  TRIGGER_WORD_MAX_CHARS,
  canonicalModel,
  canonicalPresetId,
  isPresetId,
} from "./catalog";

const USER_CONTEXT_MAX = 4000;

// "ultrafast" is OpenAI's premium low-latency tier (about 6x the standard
// price, limited models and accounts). Unentitled requests may come back as
// HTTP 200 with a lower `service_tier` rather than an error.
export const SERVICE_TIERS = ["auto", "default", "priority", "flex", "ultrafast"] as const;
export const serviceTierSchema = z.enum(SERVICE_TIERS);
export type ServiceTier = z.infer<typeof serviceTierSchema>;

export const effortSchema = z.enum(EFFORTS);
export const exaSchema = z.enum(EXA_MODES);

// Each policy is atomic so a personal "auto" choice can override a guild's
// fixed value without accidentally retaining that guild's model or effort.
export const subagentModelSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("auto") }).strict(),
  z.object({ mode: z.literal("same") }).strict(),
  z
    .object({
      mode: z.literal("fixed"),
      preset: z
        .string()
        .refine(isPresetId, { message: "unknown subagent preset" })
        .transform(canonicalPresetId),
    })
    .strict(),
]);
export const subagentEffortSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("auto") }).strict(),
  z.object({ mode: z.literal("same") }).strict(),
  z.object({ mode: z.literal("fixed"), effort: effortSchema }).strict(),
]);
export type SubagentModel = z.infer<typeof subagentModelSchema>;
export type SubagentEffort = z.infer<typeof subagentEffortSchema>;

/** Multi-Agent roles. The bot's role catalog (instructions, tools) keys on these ids. */
export const MULTI_AGENT_ROLES = ["explorer", "worker", "reviewer"] as const;
export type MultiAgentRole = (typeof MULTI_AGENT_ROLES)[number];

// Per-role overrides of the common subagent policies. "default" follows
// subagent_model / subagent_effort, so one role (e.g. only the reviewer on a
// stronger model) can differ without copying the other settings.
export const roleModelSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("default") }).strict(),
  z.object({ mode: z.literal("same") }).strict(),
  z
    .object({
      mode: z.literal("fixed"),
      preset: z
        .string()
        .refine(isPresetId, { message: "unknown role preset" })
        .transform(canonicalPresetId),
    })
    .strict(),
]);
export const roleEffortSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("default") }).strict(),
  z.object({ mode: z.literal("same") }).strict(),
  z.object({ mode: z.literal("fixed"), effort: effortSchema }).strict(),
]);
const rolePolicySchema = z.object({ model: roleModelSchema, effort: roleEffortSchema }).strict();
export type RoleModel = z.infer<typeof roleModelSchema>;
export type RoleEffort = z.infer<typeof roleEffortSchema>;
export type RolePolicy = z.infer<typeof rolePolicySchema>;
export type MultiAgentRoles = Record<MultiAgentRole, RolePolicy>;
/** PATCH merges per role and per field, so one picker never resets another. */
export const multiAgentRolesPatchSchema = z
  .object(Object.fromEntries(MULTI_AGENT_ROLES.map((r) => [r, rolePolicySchema.partial().strict()])) as
    Record<MultiAgentRole, ReturnType<typeof rolePolicySchema.partial>>)
  .partial()
  .strict();
export type MultiAgentRolesPatch = z.infer<typeof multiAgentRolesPatchSchema>;

export const defaultMultiAgentRoles = (): MultiAgentRoles =>
  Object.fromEntries(MULTI_AGENT_ROLES.map((r) => [r, { model: { mode: "default" }, effort: { mode: "default" } }])) as MultiAgentRoles;

export const selectionSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  effort: z.string().nullable().optional(),
});

/**
 * One wake word. Caps and separators match the bot so a dashboard save
 * cannot store a token `set_triggers` would reject (comma is EXTRA_TRIGGERS
 * / tool-list separator; mention tokens would steal the mention path).
 */
export const triggerWordSchema = z
  .string()
  .trim()
  .min(1)
  .max(TRIGGER_WORD_MAX_CHARS)
  .refine((s) => !s.includes(",") && !s.includes("\0") && !s.includes("<@"), {
    message: "trigger must not contain a comma, NUL, or mention token",
  });

/** ASCII is case-insensitive so `DS` disables builtin `ds`, same as the bot. */
export function triggerNamesEqual(a: string, b: string): boolean {
  const ascii = (s: string) => [...s].every((ch) => ch.charCodeAt(0) < 128);
  return ascii(a) && ascii(b) ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function canonicalBuiltin(word: string): string | undefined {
  return BUILTIN_TRIGGERS.find((b) => triggerNamesEqual(b, word));
}

function dedupeTriggers(words: string[]): string[] {
  const out: string[] = [];
  for (const w of words) {
    if (!out.some((e) => triggerNamesEqual(e, w))) out.push(w);
  }
  return out;
}

/** Partial PATCH body. Legacy null writes are materialized as default values. */
export const guildPatchSchema = z
  .object({
    mcp_enabled: z.boolean().nullable(),
    mcp_url: z
      .string()
      .trim()
      .max(2048)
      .url()
      .refine(
        (value) => {
          try {
            const url = new URL(value);
            // The bot additionally resolves and pins public DNS addresses on connect.
            return (
              url.protocol === "https:" &&
              !url.username &&
              !url.password &&
              !url.search &&
              !url.hash &&
              url.hostname !== "localhost" &&
              !url.hostname.endsWith(".localhost") &&
              !url.hostname.endsWith(".local") &&
              !url.hostname.endsWith(".internal") &&
              !url.hostname.startsWith("[") &&
              !/^\d+(\.\d+){3}$/.test(url.hostname)
            );
          } catch {
            return false;
          }
        },
        {
          message:
            "MCP URL must be public HTTPS without credentials, query or fragment",
        },
      )
      .nullable(),
    preset: z.string().refine((s) => s === "reset" || isPresetId(s), {
      message: "unknown preset",
    }),
    subagent_model: subagentModelSchema.nullable(),
    subagent_effort: subagentEffortSchema.nullable(),
    jev_enabled: z.boolean().nullable(),
    jev_task_enabled: z.boolean().nullable(),
    service_tier: serviceTierSchema.nullable(),
    subagent_enabled: z.boolean().nullable(),
    // Ultra is Claude Code's Ultracode in the bot (xhigh + standing workflows).
    ultra_mode: z.boolean().nullable(),
    // Multi-Agent (a fixed role team) stores ultra_mode=true too; see subagentMode().
    multi_agent: z.boolean().nullable(),
    multi_agent_roles: multiAgentRolesPatchSchema.nullable(),
    effort: effortSchema.nullable(),
    server_tools: z.boolean(),
    // 利用無効化措置。true = このサーバーでは一切応答しない（トリガーも無視）。
    // thread_only と違い「静かにする」ではなく「止める」なので、BOT 側は
    // トリガー判定より前に見る。
    bot_disabled: z.boolean(),
    thread_only: z.boolean(),
    // true disables Discord URL previews.
    suppress_embeds: z.boolean().nullable(),
    voice_mode: z.enum(["stt", "s2s"]),
    filler_removal: z.boolean(),
    temperature: z.number().min(0).max(2).nullable(),
    exa_mode: exaSchema.nullable(),
    thread_history_max_age_secs: z.number().int().min(0).nullable(),
    extra_triggers: z
      .array(triggerWordSchema)
      .max(TRIGGER_EXTRA_MAX)
      .nullable(),
    disabled_triggers: z.array(triggerWordSchema).max(BUILTIN_TRIGGERS.length),
    context_text: z.string().max(USER_CONTEXT_MAX).nullable(),
    persona_override: z.boolean(),
    context_clear: z.boolean(),
  })
  .partial()
  .strict();

export type GuildPatch = z.infer<typeof guildPatchSchema>;

export type GuildRow = {
  mcp_enabled: boolean | null;
  mcp_url: string | null;
  server_tools: boolean;
  bot_disabled: boolean;
  thread_only: boolean;
  suppress_embeds: boolean | null;
  voice_mode: "stt" | "s2s";
  filler_removal: boolean;
  selection: { provider: string; model: string; effort?: string | null } | null;
  effort: string | null;
  service_tier: ServiceTier | null;
  subagent_enabled: boolean | null;
  ultra_mode: boolean | null;
  multi_agent: boolean | null;
  multi_agent_roles: MultiAgentRoles | null;
  subagent_model: SubagentModel | null;
  subagent_effort: SubagentEffort | null;
  jev_enabled: boolean | null;
  jev_task_enabled: boolean | null;
  extra_triggers: string[] | null;
  disabled_triggers: string[];
  context: { text: string; persona_override: boolean } | null;
  temperature: number | null;
  exa_mode: string | null;
  thread_history_max_age_secs: number | null;
};

export const emptyGuild = (): GuildRow => ({
  mcp_enabled: true,
  mcp_url: "https://ww.hsincode.com/api/mcp",
  server_tools: true,
  bot_disabled: false,
  thread_only: false,
  suppress_embeds: false,
  voice_mode: "stt",
  filler_removal: true,
  selection: { provider: "codex_plus", model: "gpt-6-luna", effort: "max" },
  effort: "max",
  service_tier: "auto",
  subagent_enabled: true,
  ultra_mode: false,
  multi_agent: false,
  multi_agent_roles: defaultMultiAgentRoles(),
  subagent_model: { mode: "auto" },
  subagent_effort: { mode: "auto" },
  jev_enabled: true,
  jev_task_enabled: false,
  extra_triggers: [],
  disabled_triggers: [],
  context: { text: "", persona_override: false },
  temperature: 0.7,
  exa_mode: "auto",
  thread_history_max_age_secs: 3600,
});

export function modelEffort(model: string): string {
  if (model === "ox-alpha-free") return "default";
  if (model.includes("fable")) return "medium";
  return /gpt-|deepseek/.test(model) ? "max" : "high";
}

/** Environment values seed new rows once; saved rows never consult them again. */
export function settingsDefaults(env: Record<string, string | undefined>): GuildRow {
  const row = emptyGuild();
  const provider = (env.PROVIDER || env.LLM_PROVIDER || "codex_plus").toLowerCase();
  const models: Record<string, string> = {
    codex_plus: "gpt-6-luna", openai: "gpt-4o-mini", xai: "grok-3-mini",
    orca_router: "obsidian/Qwen3.8-27B",
  };
  const fallback = env.LLM_MODEL || models[provider] || MODEL_PRESETS.find(p => p.provider === provider)?.model;
  // Leftover LLM_MODEL=gpt-5.6-* / claude-fable-5 must not keep calling the retired SKU.
  const model = fallback ? canonicalModel(provider, fallback) : fallback;
  if (!model) throw new Error("LLM_MODEL is required for the default provider");
  const effort = env.LLM_EFFORT || modelEffort(model);
  row.selection = { provider, model, effort: effort === "ultra" ? "max" : effort };
  row.effort = row.selection.effort!;
  const flag = (name: string, fallback: boolean) => {
    const value = env[name]?.trim().toLowerCase();
    if (!value) return fallback;
    if (["1", "true", "yes", "on"].includes(value)) return true;
    if (["0", "false", "no", "off"].includes(value)) return false;
    throw new Error(`${name} must be a boolean`);
  };
  row.subagent_enabled = flag("SUBAGENT_ENABLED", true);
  row.ultra_mode = flag("ULTRA_MODE", effort === "ultra");
  row.multi_agent = flag("MULTI_AGENT", false);
  // Multi-Agent rows also store ultra_mode=true (it began as a superset of
  // the Codex Ultra mode); the bot tells the two apart with subagentMode().
  if (row.multi_agent) row.ultra_mode = true;
  row.jev_enabled = flag("JEV_ENABLED", true);
  row.jev_task_enabled = flag("JEV_TASK_ENABLED", false);
  row.suppress_embeds = flag("DISCORD_SUPPRESS_EMBEDS", false);
  row.exa_mode = env.EXA_ENABLED === undefined ? "auto" : flag("EXA_ENABLED", true) ? "on" : "off";
  row.temperature = env.LLM_TEMPERATURE?.trim() ? Number(env.LLM_TEMPERATURE) : 0.7;
  row.thread_history_max_age_secs = env.THREAD_HISTORY_MAX_AGE_SECS?.trim() ? Number(env.THREAD_HISTORY_MAX_AGE_SECS) : 3600;
  row.extra_triggers = (env.EXTRA_TRIGGERS || "").split(",").map(x => x.trim()).filter(Boolean);
  // Reuse public validation without including credentials in settings or errors.
  guildPatchSchema.parse({ temperature: row.temperature, thread_history_max_age_secs: row.thread_history_max_age_secs, effort: row.effort });
  return row;
}

export const SUBAGENT_MODES = ["off", "on", "ultra", "multi"] as const;
export type SubagentMode = (typeof SUBAGENT_MODES)[number];

type ModeFields = {
  subagent_enabled?: boolean | null;
  ultra_mode?: boolean | null;
  multi_agent?: boolean | null;
};

/** The single dashboard choice derived from the three stored switches. */
export function subagentMode(row: ModeFields): SubagentMode {
  // Disabling subagents wins so a stale Ultra/Multi flag never re-enables tools.
  if (row.subagent_enabled === false) return "off";
  if (row.multi_agent) return "multi";
  return row.ultra_mode ? "ultra" : "on";
}

/** PATCH body for one dashboard choice; always writes all three switches. */
export function subagentModePatch(mode: SubagentMode) {
  return {
    subagent_enabled: mode !== "off",
    ultra_mode: mode === "ultra" || mode === "multi",
    multi_agent: mode === "multi",
  };
}

function applyMultiAgentPatch(
  next: { multi_agent: boolean | null },
  patch: { ultra_mode?: boolean | null; multi_agent?: boolean | null },
) {
  if (patch.multi_agent !== undefined) {
    next.multi_agent = patch.multi_agent;
    return;
  }
  // Older clients (`/switch ultra:off`, set_bot_model) only know ultra_mode.
  // Leaving Ultra must also leave its superset; a reset (null) restores both.
  if (patch.ultra_mode === false) next.multi_agent = false;
  if (patch.ultra_mode === null) next.multi_agent = null;
}

function mergeMultiAgentRoles(
  current: MultiAgentRoles | null,
  patch: MultiAgentRolesPatch | null,
): MultiAgentRoles {
  // null restores every role to the common policy.
  if (patch === null) return defaultMultiAgentRoles();
  const base = normalizeMultiAgentRoles(current);
  for (const role of MULTI_AGENT_ROLES) {
    const change = patch[role];
    if (change) base[role] = { ...base[role], ...change } as RolePolicy;
  }
  return base;
}

/** Every preset a PATCH would select, for plan/visibility checks in API and bot. */
export function patchPresetIds(patch: {
  preset?: string;
  subagent_model?: { mode: string; preset?: string } | null;
  multi_agent_roles?: Partial<Record<string, { model?: { mode: string; preset?: string } }>> | null;
}): string[] {
  const ids: string[] = [];
  if (patch.preset && patch.preset !== "reset") ids.push(canonicalPresetId(patch.preset));
  if (patch.subagent_model?.mode === "fixed" && patch.subagent_model.preset)
    ids.push(canonicalPresetId(patch.subagent_model.preset));
  for (const role of Object.values(patch.multi_agent_roles ?? {}))
    if (role?.model?.mode === "fixed" && role.model.preset)
      ids.push(canonicalPresetId(role.model.preset));
  return ids;
}

export function applyPatch(row: GuildRow, patch: GuildPatch, defaults = emptyGuild()): GuildRow {
  const clean = normalizeGuild(row, defaults);
  const next = { ...clean, disabled_triggers: [...clean.disabled_triggers] };
  if (patch.mcp_enabled !== undefined) next.mcp_enabled = patch.mcp_enabled;
  if (patch.mcp_url !== undefined) next.mcp_url = patch.mcp_url;
  if (patch.server_tools !== undefined) next.server_tools = patch.server_tools;
  if (patch.bot_disabled !== undefined) next.bot_disabled = patch.bot_disabled;
  if (patch.thread_only !== undefined) next.thread_only = patch.thread_only;
  if (patch.suppress_embeds !== undefined)
    next.suppress_embeds = patch.suppress_embeds;
  if (patch.voice_mode !== undefined) next.voice_mode = patch.voice_mode;
  if (patch.filler_removal !== undefined)
    next.filler_removal = patch.filler_removal;
  if (patch.jev_enabled !== undefined) next.jev_enabled = patch.jev_enabled;
  if (patch.jev_task_enabled !== undefined) next.jev_task_enabled = patch.jev_task_enabled;
  if (patch.subagent_model !== undefined)
    next.subagent_model = normalizeSubagentModel(patch.subagent_model);
  if (patch.subagent_effort !== undefined)
    next.subagent_effort = normalizeSubagentEffort(patch.subagent_effort);
  if (patch.temperature !== undefined) next.temperature = patch.temperature;
  if (patch.exa_mode !== undefined) next.exa_mode = patch.exa_mode;
  if (patch.thread_history_max_age_secs !== undefined) {
    next.thread_history_max_age_secs = patch.thread_history_max_age_secs;
  }
  if (
    patch.extra_triggers !== undefined ||
    patch.disabled_triggers !== undefined
  ) {
    // Canonicalize here so Neon stores what the bot match loop will actually
    // use: builtins never live in `extra`, and `DS` persists as `ds`.
    let extra =
      patch.extra_triggers !== undefined
        ? patch.extra_triggers
        : next.extra_triggers;
    let disabled =
      patch.disabled_triggers !== undefined
        ? [...patch.disabled_triggers]
        : [...next.disabled_triggers];
    if (extra !== null) {
      const reenabled: string[] = [];
      extra = extra.filter((w) => {
        const canon = canonicalBuiltin(w);
        if (canon) {
          reenabled.push(canon);
          return false;
        }
        return true;
      });
      extra = dedupeTriggers(extra).slice(0, TRIGGER_EXTRA_MAX);
      if (reenabled.length > 0) {
        disabled = disabled.filter(
          (d) => !reenabled.some((r) => triggerNamesEqual(d, r)),
        );
      }
    }
    disabled = dedupeTriggers(
      disabled.flatMap((w) => {
        const canon = canonicalBuiltin(w);
        return canon ? [canon] : [];
      }),
    );
    if (patch.extra_triggers !== undefined) next.extra_triggers = extra;
    next.disabled_triggers = disabled;
  }
  if (patch.context_clear) {
    next.context = { text: "", persona_override: false };
  } else if (
    patch.context_text !== undefined ||
    patch.persona_override !== undefined
  ) {
    const prev = next.context ?? { text: "", persona_override: false };
    next.context = {
      text:
        patch.context_text === undefined
          ? prev.text
          : (patch.context_text ?? ""),
      persona_override:
        patch.persona_override === undefined
          ? prev.persona_override
          : patch.persona_override,
    };
  }
  if (patch.preset === "reset") {
    next.selection = defaults.selection;
    next.effort = defaults.effort;
  } else if (typeof patch.preset === "string") {
    const presetId = canonicalPresetId(patch.preset);
    const p = MODEL_PRESETS.find((x) => x.id === presetId);
    if (p) {
      next.selection = {
        provider: p.provider,
        model: p.model,
        effort: patch.effort ?? modelEffort(p.model),
      };
      next.effort = next.selection.effort ?? modelEffort(p.model);
    }
  } else if (patch.effort !== undefined && next.selection) {
    next.selection = { ...next.selection, effort: patch.effort };
  }
  if (patch.effort !== undefined) next.effort = patch.effort;
  if (patch.effort === "ultra" && patch.ultra_mode === undefined) next.ultra_mode = true;
  if (patch.ultra_mode !== undefined) next.ultra_mode = patch.ultra_mode;
  applyMultiAgentPatch(next, patch);
  if (patch.multi_agent_roles !== undefined)
    next.multi_agent_roles = mergeMultiAgentRoles(next.multi_agent_roles, patch.multi_agent_roles);
  if (patch.service_tier !== undefined) next.service_tier = patch.service_tier;
  if (patch.subagent_enabled !== undefined) next.subagent_enabled = patch.subagent_enabled;
  return normalizeGuild(next, defaults);
}

/**
 * Personal settings overlay one guild field at a time.
 * null is デフォルト: that field follows the server (in a DM, the process default).
 * A non-null value is an intentional override and is the only thing that
 * replaces the server. Rows are not copied from the environment, so a later
 * server edit still reaches anyone who has not touched that control.
 */
export type UserOverrideRow = {
  selection: { provider: string; model: string; effort?: string | null } | null;
  effort: string | null;
  service_tier: ServiceTier | null;
  subagent_enabled: boolean | null;
  ultra_mode: boolean | null;
  multi_agent: boolean | null;
  multi_agent_roles: MultiAgentRoles | null;
  subagent_model: SubagentModel | null;
  subagent_effort: SubagentEffort | null;
  jev_enabled: boolean | null;
  jev_task_enabled: boolean | null;
  context: { text: string; persona_override: boolean } | null;
};

/** Same PATCH shape as the guild subset, so the dashboard can reuse pickers. */
export const userOverridePatchSchema = z
  .object({
    preset: z.string().refine((s) => s === "reset" || isPresetId(s), {
      message: "unknown preset",
    }),
    jev_enabled: z.boolean().nullable(),
    jev_task_enabled: z.boolean().nullable(),
    service_tier: serviceTierSchema.nullable(),
    subagent_enabled: z.boolean().nullable(),
    ultra_mode: z.boolean().nullable(),
    multi_agent: z.boolean().nullable(),
    multi_agent_roles: multiAgentRolesPatchSchema.nullable(),
    // null clears the personal rung back to デフォルト (the server's effort).
    effort: effortSchema.nullable(),
    subagent_model: subagentModelSchema.nullable(),
    subagent_effort: subagentEffortSchema.nullable(),
    context_text: z.string().max(USER_CONTEXT_MAX).nullable(),
    // null clears a stored persona flag. Combined with an empty text it
    // returns the whole context to デフォルト rather than blocking the server.
    persona_override: z.boolean().nullable(),
    context_clear: z.boolean(),
  })
  .partial()
  .strict();

export type UserOverridePatch = z.infer<typeof userOverridePatchSchema>;

function emptyContext(
  ctx: { text: string; persona_override: boolean } | null,
): boolean {
  return !ctx || (!ctx.text.trim() && !ctx.persona_override);
}

/** The デフォルト personal row: every field inherits until the user changes it. */
export const emptyUserOverride = (): UserOverrideRow => ({
  selection: null,
  effort: null,
  service_tier: null,
  subagent_enabled: null,
  ultra_mode: null,
  multi_agent: null,
  multi_agent_roles: null,
  subagent_model: null,
  subagent_effort: null,
  jev_enabled: null,
  jev_task_enabled: null,
  context: null,
});

export function isEmptyUserOverride(row: UserOverrideRow): boolean {
  return (
    row.selection == null &&
    row.effort == null &&
    row.service_tier == null &&
    row.subagent_enabled == null &&
    row.ultra_mode == null &&
    row.multi_agent == null &&
    row.multi_agent_roles == null &&
    row.subagent_model == null &&
    row.subagent_effort == null &&
    row.jev_enabled == null &&
    row.jev_task_enabled == null &&
    emptyContext(row.context)
  );
}

export function applyUserOverridePatch(
  row: UserOverrideRow,
  patch: UserOverridePatch,
  _defaults = emptyGuild(),
): UserOverrideRow {
  // Keep untouched fields exactly as stored. Filling them from the process
  // default would turn one click into a full copy that stops following the server.
  const next: UserOverrideRow = normalizeUserOverride(row);
  if (patch.jev_enabled !== undefined) next.jev_enabled = patch.jev_enabled;
  if (patch.jev_task_enabled !== undefined) next.jev_task_enabled = patch.jev_task_enabled;
  if (patch.subagent_model !== undefined)
    next.subagent_model = patch.subagent_model === null
      ? null
      : normalizeSubagentModel(patch.subagent_model);
  if (patch.subagent_effort !== undefined)
    next.subagent_effort = patch.subagent_effort === null
      ? null
      : normalizeSubagentEffort(patch.subagent_effort);
  if (patch.context_clear) {
    next.context = null;
  } else if (
    patch.context_text !== undefined ||
    patch.persona_override !== undefined
  ) {
    const prev = next.context ?? { text: "", persona_override: false };
    const ctx = {
      text:
        patch.context_text === undefined
          ? prev.text
          : (patch.context_text ?? ""),
      persona_override:
        patch.persona_override === undefined
          ? prev.persona_override
          : Boolean(patch.persona_override),
    };
    // An empty personal context is デフォルト again, so the server text applies.
    next.context = emptyContext(ctx) ? null : ctx;
  }
  if (patch.preset === "reset") {
    next.selection = null;
    next.effort = null;
  } else if (typeof patch.preset === "string") {
    const presetId = canonicalPresetId(patch.preset);
    const p = MODEL_PRESETS.find((x) => x.id === presetId);
    if (p) {
      next.selection = {
        provider: p.provider,
        model: p.model,
        effort: patch.effort ?? modelEffort(p.model),
      };
      next.effort = next.selection.effort ?? modelEffort(p.model);
    }
  } else if (patch.effort !== undefined && next.selection) {
    next.selection = { ...next.selection, effort: patch.effort };
  }
  if (patch.effort !== undefined) next.effort = patch.effort;
  if (patch.effort === "ultra" && patch.ultra_mode === undefined) next.ultra_mode = true;
  if (patch.ultra_mode !== undefined) next.ultra_mode = patch.ultra_mode;
  applyMultiAgentPatch(next, patch);
  if (patch.multi_agent_roles !== undefined)
    next.multi_agent_roles = patch.multi_agent_roles === null
      ? null
      : mergeMultiAgentRoles(next.multi_agent_roles, patch.multi_agent_roles);
  if (patch.service_tier !== undefined) next.service_tier = patch.service_tier;
  if (patch.subagent_enabled !== undefined) next.subagent_enabled = patch.subagent_enabled;
  return normalizeUserOverride(next);
}

/** Whitelist persisted keys when reading legacy JSONB. Retired fields never reappear in API responses. */
export function normalizeGuild(
  raw: Partial<GuildRow> | null | undefined,
  defaults: GuildRow = emptyGuild(),
): GuildRow {
  const row = Object.fromEntries(
    Object.entries(defaults).map(([key, value]) => [
      key,
      raw?.[key as keyof GuildRow] ?? value,
    ]),
  ) as GuildRow;
  row.selection = normalizeSelection(row.selection) ?? defaults.selection;
  // Resolve old nulls once. They must never resume following another row.
  row.effort = raw?.effort ?? raw?.selection?.effort ??
    (raw?.selection ? modelEffort(row.selection!.model) : defaults.effort);
  row.ultra_mode = raw?.ultra_mode ??
    (row.effort === "ultra" ? true : defaults.ultra_mode);
  row.service_tier = serviceTierSchema.safeParse(row.service_tier).data ?? defaults.service_tier;
  row.subagent_model = normalizeSubagentModel(raw?.subagent_model, raw) ?? defaults.subagent_model;
  row.subagent_effort = normalizeSubagentEffort(row.subagent_effort) ?? defaults.subagent_effort;
  row.multi_agent_roles = normalizeMultiAgentRoles(raw?.multi_agent_roles ?? defaults.multi_agent_roles);
  return normalizeMode(row);
}

function normalizeMode<T extends Pick<GuildRow, "selection" | "effort" | "ultra_mode" | "multi_agent">>(row: T): T {
  // Store effort independently so model and reasoning depth have separate controls.
  // Keep selection.effort synchronized for older dashboard/bot clients.
  row.effort ??= row.selection?.effort ?? null;
  if (row.effort === "ultra") {
    row.effort = "max";
    row.ultra_mode ??= true;
  }
  // Multi-Agent keeps ultra_mode=true: code that only knows ultra_mode (logs,
  // older clients) must still see delegation on. Behavior comes from
  // subagentMode(), which keeps Multi-Agent apart from Ultra (Ultracode).
  if (row.multi_agent) row.ultra_mode = true;
  if (row.selection) row.selection = { ...row.selection, effort: row.effort };
  return row;
}

/** Fill missing roles and drop invalid ones individually, so one stale
 *  preset id cannot discard the other roles' saved choices. */
function normalizeMultiAgentRoles(value: unknown): MultiAgentRoles {
  const out = defaultMultiAgentRoles();
  if (!value || typeof value !== "object") return out;
  for (const role of MULTI_AGENT_ROLES) {
    const raw = (value as Record<string, { model?: unknown; effort?: unknown } | undefined>)[role];
    const model = roleModelSchema.safeParse(raw?.model);
    const effort = roleEffortSchema.safeParse(raw?.effort);
    if (model.success) out[role].model = model.data;
    if (effort.success)
      out[role].effort = effort.data.mode === "fixed" && effort.data.effort === "ultra"
        ? { mode: "fixed", effort: "max" }
        : effort.data;
  }
  return out;
}

function normalizeSubagentEffort(value: unknown): SubagentEffort | null {
  const policy = subagentEffortSchema.safeParse(value).data ?? null;
  // Children inherit the parent's delegation instructions separately. The old
  // fixed ultra effort only contributed max to their provider requests.
  return policy?.mode === "fixed" && policy.effort === "ultra"
    ? { mode: "fixed", effort: "max" }
    : policy;
}

function normalizeSelection(
  selection: GuildRow["selection"],
): GuildRow["selection"] {
  // Removed endpoints cannot be selected; normalization installs the default.
  if (
    selection?.provider === "codex_sale" ||
    selection?.provider === "opencode_go"
  )
    return null;
  if (!selection) return selection;
  const model = canonicalModel(selection.provider, selection.model);
  return model === selection.model ? selection : { ...selection, model };
}

function normalizeSubagentModel(
  value: unknown,
  raw?: unknown,
): SubagentModel | null {
  // Read legacy JSONB without retaining the retired field in new API responses.
  // An explicit null on the new key clears the old fixed preset too.
  if (
    raw &&
    typeof raw === "object" &&
    !("subagent_model" in raw) &&
    "subagent_preset" in raw
  ) {
    const legacy = raw.subagent_preset;
    if (typeof legacy === "string" && isPresetId(legacy))
      value = { mode: "fixed", preset: legacy };
  }
  const result = subagentModelSchema.safeParse(value);
  if (!result.success) return null;
  return result.data.mode === "fixed"
    ? { mode: "fixed", preset: canonicalPresetId(result.data.preset) }
    : result.data;
}

export function normalizeUserOverride(
  raw: Partial<UserOverrideRow> | null | undefined,
  _defaults: GuildRow = emptyGuild(),
): UserOverrideRow {
  // Do not borrow guild/env defaults here. A missing personal field must stay
  // null so resolve() can follow the server the user is actually talking in.
  const src = (raw ?? {}) as Partial<UserOverrideRow>;
  let selection = normalizeSelection(src.selection ?? null);
  let effort = src.effort ?? null;
  let ultra = src.ultra_mode ?? null;
  let multi = src.multi_agent ?? null;
  if (effort === "ultra") {
    effort = "max";
    ultra = true;
  }
  if (selection?.effort === "ultra") {
    selection = { ...selection, effort: "max" };
    effort = effort ?? "max";
    ultra = true;
  }
  // An explicit Multi choice still implies Ultra, even if that switch was left null.
  if (multi === true) ultra = true;
  if (selection && effort != null) selection = { ...selection, effort };
  const context = src.context && !emptyContext(src.context)
    ? {
        text: typeof src.context.text === "string" ? src.context.text : "",
        persona_override: Boolean(src.context.persona_override),
      }
    : null;
  return {
    selection,
    effort,
    service_tier: src.service_tier == null
      ? null
      : serviceTierSchema.safeParse(src.service_tier).data ?? null,
    subagent_enabled: typeof src.subagent_enabled === "boolean" ? src.subagent_enabled : null,
    ultra_mode: typeof ultra === "boolean" ? ultra : null,
    multi_agent: typeof multi === "boolean" ? multi : null,
    multi_agent_roles: src.multi_agent_roles == null
      ? null
      : normalizeMultiAgentRoles(src.multi_agent_roles),
    subagent_model: normalizeSubagentModel(src.subagent_model, src),
    subagent_effort: normalizeSubagentEffort(src.subagent_effort),
    jev_enabled: typeof src.jev_enabled === "boolean" ? src.jev_enabled : null,
    jev_task_enabled: typeof src.jev_task_enabled === "boolean" ? src.jev_task_enabled : null,
    context,
  };
}

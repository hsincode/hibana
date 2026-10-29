// The model the settings switch to once the month's budget is nearly spent
// (decision record: #89), the threshold that counts as nearly spent (#95),
// and the switch itself (#121). The settings API decides whether it is
// (`/internal/budget`, from the cost report and today's estimate) and, when it
// turns so, rewrites the stored settings once a billing month (#128); the bot
// runs what is stored and says so in Discord; the dashboard shows both values
// and an Administrator edits them.

import { z } from "zod";
import {
  AUTO_ROUTE_MODEL,
  MODEL_PRESETS,
  SELECTABLE_PRESETS,
  WORKSPACE_PROVIDER,
  canonicalPresetId,
} from "./catalog";

/** Turns switch once this month's remaining budget, today's estimate taken
 *  off, is below the threshold. This is the value of #89, used until
 *  an Administrator stores another on the dashboard (#95). */
export const DEFAULT_BUDGET_FALLBACK_THRESHOLD_USD = 10;

/** The provider of the fallback (#89): the one billed against the budget the
 *  cost report shows. The switch also moves Anthropic Workspace choices, to
 *  the fallback's model there (#121). */
export const BUDGET_FALLBACK_PROVIDER = "anthropic";

/** Efforts the fallback may run at. `none` is left out: Claude 5.x cannot
 *  switch thinking off (the bot sends low instead), so it would only mislead. */
export const BUDGET_FALLBACK_EFFORTS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

/**
 * Presets the fallback may be: Anthropic API models, not the auto route.
 * A conversation keeps its provider's own blocks (Anthropic thinking blocks),
 * so the history of an `anthropic` turn can be continued by another
 * `anthropic` model but not sent to another provider's protocol.
 */
export function isBudgetFallbackPreset(raw: string): boolean {
  const id = canonicalPresetId(raw);
  return SELECTABLE_PRESETS.some(
    (p) =>
      p.id === id &&
      p.provider === BUDGET_FALLBACK_PROVIDER &&
      p.model !== AUTO_ROUTE_MODEL,
  );
}

export const budgetFallbackSchema = z
  .object({
    preset: z
      .string()
      .refine(isBudgetFallbackPreset, {
        message: "fallback must be an Anthropic API preset other than Auto",
      })
      .transform(canonicalPresetId),
    effort: z.enum(BUDGET_FALLBACK_EFFORTS),
  })
  .strict();
export type BudgetFallback = z.infer<typeof budgetFallbackSchema>;

/** The default (#89): Anthropic API, Claude Haiku 5.5, effort high. */
export const DEFAULT_BUDGET_FALLBACK: BudgetFallback = {
  preset: "anthropic-haiku-5-5",
  effort: "high",
};

/** A stored value, or the default when there is none or it no longer parses
 *  (a preset removed from the catalog). */
export function parseBudgetFallback(raw: unknown): BudgetFallback {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return { ...DEFAULT_BUDGET_FALLBACK };
    }
  }
  const parsed = budgetFallbackSchema.safeParse(value);
  return parsed.success ? parsed.data : { ...DEFAULT_BUDGET_FALLBACK };
}

/** The selection a fallback runs as. */
export function budgetFallbackSelection(fallback: BudgetFallback): {
  provider: string;
  model: string;
  effort: string;
} {
  const preset = MODEL_PRESETS.find((p) => p.id === fallback.preset)!;
  return {
    provider: preset.provider,
    model: preset.model,
    effort: fallback.effort,
  };
}

/**
 * A threshold an Administrator may store (#95): whole cents from $0 to
 * `maxUsd`, the monthly budget. Above the budget every turn would switch from
 * the first day; at $0 turns switch only once the budget is exceeded. The
 * value is rounded to the cent it names, so 0.1 + 0.2 is stored as 0.3.
 */
export function budgetThresholdSchema(maxUsd: number) {
  return z
    .number()
    .finite()
    .min(0, { message: "threshold must not be negative" })
    .max(maxUsd, { message: `threshold must be at most ${maxUsd}` })
    .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, {
      message: "threshold must be in whole cents",
    })
    .transform((v) => Math.round(v * 100) / 100);
}

/** A stored threshold, or the default when there is none or it no longer
 *  parses (the monthly budget was lowered below it). */
export function parseBudgetThreshold(raw: unknown, maxUsd: number): number {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return DEFAULT_BUDGET_FALLBACK_THRESHOLD_USD;
    }
  }
  const parsed = budgetThresholdSchema(maxUsd).safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_BUDGET_FALLBACK_THRESHOLD_USD;
}

/** Whether a remaining amount, today's estimate already taken off, is low:
 *  going from not low to low switches the settings (#121). */
export function budgetLow(
  remainingAfterTodayUsd: number,
  thresholdUsd: number,
): boolean {
  return remainingAfterTodayUsd < thresholdUsd;
}

/** "$10" or "$7.50": a threshold as the Discord notice writes it. */
export function formatThreshold(usd: number): string {
  return Number.isInteger(usd) ? `$${usd}` : `$${usd.toFixed(2)}`;
}

/**
 * Rewriting the settings once the budget is low (#121). The settings API does
 * it once a billing month, when `/internal/budget` first turns low in it
 * (#128); nothing swaps a request after that, so a model picked afterwards
 * (Haiku 5.5 Xhigh, say) runs as picked. Settings are not put back when the
 * budget recovers.
 *
 * Every stored choice of an `anthropic` preset (Auto included) or an
 * Anthropic Workspace preset is rewritten (decision record #121): the
 * main model of a server and of a person, a fixed subagent or role model, and
 * a server's Text Generation Model. Other providers are left as they are.
 */
export type BudgetSwitchTarget = {
  /** The fallback: an `anthropic` preset. */
  preset: string;
  effort: (typeof BUDGET_FALLBACK_EFFORTS)[number];
  /** The Workspace preset of the fallback's model, or null when it is
   *  unpublished (it may not have a live wire id): Workspace choices then
   *  take the fallback itself. */
  workspacePreset: string | null;
};

/** What the switch writes. A stored fallback that was hidden since runs the
 *  default instead, as the bot's notice names it (runtime.ts). */
export function budgetSwitchTarget(
  fallback: BudgetFallback,
  unpublished: readonly string[],
): BudgetSwitchTarget {
  const chosen = unpublished.includes(fallback.preset)
    ? DEFAULT_BUDGET_FALLBACK
    : fallback;
  const model = MODEL_PRESETS.find((p) => p.id === chosen.preset)!.model;
  const workspace = MODEL_PRESETS.find(
    (p) => p.provider === WORKSPACE_PROVIDER && p.model === model,
  );
  return {
    preset: chosen.preset,
    effort: chosen.effort,
    workspacePreset:
      workspace && !unpublished.includes(workspace.id) ? workspace.id : null,
  };
}

const providerOf = (presetId: string) =>
  MODEL_PRESETS.find((p) => p.id === canonicalPresetId(presetId))?.provider;

type MainFields = {
  selection: { provider: string; model: string; effort?: string | null } | null;
  effort: string | null;
};
type MainPatch = {
  preset?: string;
  effort?: (typeof BUDGET_FALLBACK_EFFORTS)[number];
  ultra_mode?: boolean;
  multi_agent?: boolean;
};

/** The main model. A Workspace choice moves to the Workspace preset of the
 *  fallback's model and leaves Ultra and Multi-Agent: on Haiku 5.5 a stored
 *  Ultra would start Managed Agents' dynamic workflows (#76), which a server
 *  on Opus with Ultra stored never ran (#121). A row already on the target is
 *  left alone, so its conversations are kept. */
function mainPatch(row: MainFields, target: BudgetSwitchTarget): MainPatch {
  const selection = row.selection;
  if (!selection) return {};
  const workspace = selection.provider === WORKSPACE_PROVIDER;
  if (!workspace && selection.provider !== BUDGET_FALLBACK_PROVIDER) return {};
  const id = workspace
    ? (target.workspacePreset ?? target.preset)
    : target.preset;
  const preset = MODEL_PRESETS.find((p) => p.id === id)!;
  const same =
    selection.provider === preset.provider &&
    selection.model === preset.model &&
    (selection.effort ?? row.effort) === target.effort &&
    row.effort === target.effort;
  if (same) return {};
  return {
    preset: id,
    effort: target.effort,
    ...(workspace ? { ultra_mode: false, multi_agent: false } : {}),
  };
}

type ChildModel = { mode: string; preset?: string } | null | undefined;
type ChildEffort = { mode: string; effort?: string } | null | undefined;

/** A fixed child model of Anthropic API runs as the fallback, at its effort,
 *  as the request swap did before #121. "auto" and "same" are not stored
 *  models and are left as they are. Workspace presets cannot be a child. */
function childPatch(
  model: ChildModel,
  effort: ChildEffort,
  target: BudgetSwitchTarget,
) {
  if (
    model?.mode !== "fixed" ||
    !model.preset ||
    providerOf(model.preset) !== BUDGET_FALLBACK_PROVIDER
  )
    return null;
  if (
    canonicalPresetId(model.preset) === target.preset &&
    effort?.mode === "fixed" &&
    effort.effort === target.effort
  )
    return null;
  return {
    model: { mode: "fixed" as const, preset: target.preset },
    effort: { mode: "fixed" as const, effort: target.effort },
  };
}

type ChildFields = {
  subagent_model: ChildModel;
  subagent_effort: ChildEffort;
  multi_agent_roles: Record<
    string,
    { model: ChildModel; effort: ChildEffort }
  > | null;
};

function childrenPatch(row: ChildFields, target: BudgetSwitchTarget) {
  const patch: {
    subagent_model?: { mode: "fixed"; preset: string };
    subagent_effort?: { mode: "fixed"; effort: BudgetSwitchTarget["effort"] };
    multi_agent_roles?: Record<
      string,
      {
        model: { mode: "fixed"; preset: string };
        effort: { mode: "fixed"; effort: BudgetSwitchTarget["effort"] };
      }
    >;
  } = {};
  const common = childPatch(row.subagent_model, row.subagent_effort, target);
  if (common) {
    patch.subagent_model = common.model;
    patch.subagent_effort = common.effort;
  }
  for (const [role, policy] of Object.entries(row.multi_agent_roles ?? {})) {
    const change = childPatch(policy.model, policy.effort, target);
    if (change) (patch.multi_agent_roles ??= {})[role] = change;
  }
  return patch;
}

/** The PATCH (`guildPatchSchema`) that switches a server, or null when it
 *  names no Anthropic API or Workspace model that differs from the target. */
export function budgetSwitchGuildPatch(
  row: MainFields &
    ChildFields & { text_model: { preset: string; effort: string } },
  target: BudgetSwitchTarget,
) {
  const patch: ReturnType<typeof childrenPatch> &
    MainPatch & {
      text_model?: { preset: string; effort: BudgetSwitchTarget["effort"] };
    } = { ...mainPatch(row, target), ...childrenPatch(row, target) };
  // Text Generation Model presets are Anthropic API ones only (#118).
  if (
    canonicalPresetId(row.text_model.preset) !== target.preset ||
    row.text_model.effort !== target.effort
  )
    patch.text_model = { preset: target.preset, effort: target.effort };
  return Object.keys(patch).length ? patch : null;
}

/** The PATCH (`userOverridePatchSchema`) that switches a person's own
 *  settings, or null. A field left to the server (null) is not touched: it
 *  follows the server, which is switched on its own. */
export function budgetSwitchUserPatch(
  row: MainFields & ChildFields,
  target: BudgetSwitchTarget,
) {
  const patch = { ...mainPatch(row, target), ...childrenPatch(row, target) };
  return Object.keys(patch).length ? patch : null;
}

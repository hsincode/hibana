// The settings switch of #121: once this month's budget turns low, every
// stored Anthropic API and Anthropic Workspace choice is rewritten to the
// fallback, once. Nothing swaps a request afterwards, so whatever is picked
// after the switch runs as picked; the settings are not put back when the
// budget recovers. Which fields change is `budgetSwitchGuildPatch` and
// `budgetSwitchUserPatch` (packages/shared/src/budget.ts).

import {
  budgetSwitchGuildPatch,
  budgetSwitchTarget,
  budgetSwitchUserPatch,
  parseBudgetFallback,
} from "@hibana/shared/budget";
import {
  applyPatch,
  applyUserOverridePatch,
  guildPatchSchema,
  userOverridePatchSchema,
} from "@hibana/shared/settings";
import type { Store } from "./store";

/**
 * "true" while the switch of the current low spell is done; "false" (or no
 * row) otherwise. Only `/internal/budget` writes it, with `compareMeta`, so
 * two answers at once (two Vercel instances) switch once.
 */
export const BUDGET_SWITCH_META = "budget_fallback_switched";

export type BudgetSwitchResult = { guilds: number; users: number };

/**
 * Called with each decision `/internal/budget` answers. Low and not yet
 * switched: switch, and return how many rows changed. Not low: clear the
 * mark, so the next time the budget goes below the threshold switches again.
 * The caller does not call it when there is no decision (no Admin API key, a
 * report failed): the mark stays as it was.
 */
export async function observeBudget(
  store: Store,
  low: boolean,
  unpublished: readonly string[],
): Promise<BudgetSwitchResult | null> {
  const mark = await store.getMeta(BUDGET_SWITCH_META);
  if (!low) {
    if (mark === "true")
      await store.compareMeta(BUDGET_SWITCH_META, "true", "false");
    return null;
  }
  if (mark === "true") return null;
  // Claimed before the rows are written: another instance answering at the
  // same moment sees "true" and leaves them to this one.
  if (!(await store.compareMeta(BUDGET_SWITCH_META, mark, "true"))) return null;
  try {
    return await switchSettings(store, unpublished);
  } catch (e) {
    // Not marked as done, so the next poll tries again. Rows written before
    // the failure are on the target already and are skipped then.
    await store.compareMeta(BUDGET_SWITCH_META, "true", "false");
    throw e;
  }
}

async function switchSettings(
  store: Store,
  unpublished: readonly string[],
): Promise<BudgetSwitchResult> {
  const target = budgetSwitchTarget(
    parseBudgetFallback(await store.getMeta("budget_fallback")),
    unpublished,
  );
  const result: BudgetSwitchResult = { guilds: 0, users: 0 };
  for (const [id, row] of Object.entries(await store.allGuilds())) {
    const patch = budgetSwitchGuildPatch(row, target);
    if (!patch) continue;
    // Through the schema the dashboard's PATCH goes through, so a patch it
    // would refuse throws here instead of being stored.
    await store.putGuild(
      id,
      applyPatch(row, guildPatchSchema.parse(patch), store.defaults),
    );
    result.guilds++;
  }
  for (const [id, row] of Object.entries(await store.allUserOverrides())) {
    const patch = budgetSwitchUserPatch(row, target);
    if (!patch) continue;
    await store.putUserOverride(
      id,
      applyUserOverridePatch(
        row,
        userOverridePatchSchema.parse(patch),
        store.defaults,
      ),
    );
    result.users++;
  }
  return result;
}

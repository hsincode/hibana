// The settings switch of #121: once this month's budget turns low, every
// stored Anthropic API and Anthropic Workspace choice is rewritten to the
// fallback, once a billing month (#128). Nothing swaps a request afterwards,
// so whatever is picked after the switch runs as picked; the settings are not
// put back when the budget recovers. Which fields change is
// `budgetSwitchGuildPatch` and `budgetSwitchUserPatch`
// (packages/shared/src/budget.ts).

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
 * The billing month (`YYYY-MM`, #81) whose switch is done. A month switches
 * once, however often its remaining budget goes back above the threshold and
 * below it again (#128): just after midnight UTC the day before is in neither
 * figure until the cost report has it, and an Administrator may move the
 * threshold. While rows a switch could not write are left, it is JSON,
 * `{"month","guilds","users"}`, and the next low answer tries those again,
 * and only those. "true", which #122 wrote, is read as the current month's
 * switch and rewritten as it; anything else ("false", none) is no switch
 * yet. Only `/internal/budget` writes it, with `compareMeta`, so two answers
 * at once (two Vercel instances) switch once.
 */
export const BUDGET_SWITCH_META = "budget_fallback_switched";

export type BudgetSwitchResult = {
  guilds: number;
  users: number;
  /** Rows left for the next low answer to try again. */
  failed: number;
};

type Pending = { guilds: string[]; users: string[] };

function readMark(
  raw: string | null,
  month: string,
): { month: string | null; pending: Pending | null } {
  if (raw === "true") return { month, pending: null };
  if (raw && /^\d{4}-\d{2}$/.test(raw)) return { month: raw, pending: null };
  if (raw?.startsWith("{")) {
    try {
      const v = JSON.parse(raw);
      if (
        typeof v.month === "string" &&
        Array.isArray(v.guilds) &&
        Array.isArray(v.users)
      )
        return {
          month: v.month,
          pending: { guilds: v.guilds.map(String), users: v.users.map(String) },
        };
    } catch {
      // Not a mark this version writes: read as no switch yet.
    }
  }
  return { month: null, pending: null };
}

/**
 * Called with each decision `/internal/budget` answers, and the billing month
 * it is for. Low and this month not switched yet: switch, and return how many
 * rows changed. Not low: the mark stays, so the month does not switch again;
 * the next billing month does once it is low. The caller does not call it
 * when there is no decision (no Admin API key, a report failed).
 */
export async function observeBudget(
  store: Store,
  low: boolean,
  month: string,
  unpublished: readonly string[],
): Promise<BudgetSwitchResult | null> {
  let raw = await store.getMeta(BUDGET_SWITCH_META);
  // "true" is left by #122 only while its low spell went on (a low answer
  // wrote it, the next one that was not low cleared it): it is this month's
  // switch. It becomes the month on the first answer, low or not, so this
  // month does not switch again and the next one does.
  if (
    raw === "true" &&
    (await store.compareMeta(BUDGET_SWITCH_META, "true", month))
  )
    raw = month;
  if (!low) return null;
  const mark = readMark(raw, month);
  const retry = mark.month === month ? mark.pending : null;
  if (mark.month === month && !retry) return null;
  // Claimed before the rows are written: another instance answering at the
  // same moment sees the month and leaves them to this one.
  if (!(await store.compareMeta(BUDGET_SWITCH_META, raw, month))) return null;
  let result: { guilds: number; users: number; failed: Pending };
  try {
    result = await switchSettings(store, unpublished, retry);
  } catch (e) {
    // Thrown before a row was written (the settings could not be read): put
    // the mark back, so the next poll tries again.
    await store.compareMeta(BUDGET_SWITCH_META, month, raw ?? "");
    throw e;
  }
  const failed = result.failed.guilds.length + result.failed.users.length;
  if (failed)
    await store.compareMeta(
      BUDGET_SWITCH_META,
      month,
      JSON.stringify({ month, ...result.failed }),
    );
  return { guilds: result.guilds, users: result.users, failed };
}

/** Rewrites every row, or only the rows in `only` when it is a retry. A row
 *  that fails is left for the next poll; the rows written are not written
 *  again this month, so a model or effort picked on them afterwards stays. */
async function switchSettings(
  store: Store,
  unpublished: readonly string[],
  only: Pending | null,
) {
  const target = budgetSwitchTarget(
    parseBudgetFallback(await store.getMeta("budget_fallback")),
    unpublished,
  );
  // Both read before anything is written, so a failure here leaves no row
  // switched.
  const [guilds, users] = await Promise.all([
    store.allGuilds(),
    store.allUserOverrides(),
  ]);
  const result = {
    guilds: 0,
    users: 0,
    failed: { guilds: [], users: [] } as Pending,
  };
  const fail = (kind: "guild" | "user", id: string, e: unknown) => {
    console.error(
      `Budget switch: ${kind} ${id} not switched:`,
      e instanceof Error ? e.message : String(e),
    );
    result.failed[kind === "guild" ? "guilds" : "users"].push(id);
  };
  for (const [id, row] of Object.entries(guilds)) {
    if (only && !only.guilds.includes(id)) continue;
    try {
      const patch = budgetSwitchGuildPatch(row, target);
      if (!patch) continue;
      // Through the schema the dashboard's PATCH goes through, so a patch it
      // would refuse fails here instead of being stored.
      await store.putGuild(
        id,
        applyPatch(row, guildPatchSchema.parse(patch), store.defaults),
      );
      result.guilds++;
    } catch (e) {
      fail("guild", id, e);
    }
  }
  for (const [id, row] of Object.entries(users)) {
    if (only && !only.users.includes(id)) continue;
    try {
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
    } catch (e) {
      fail("user", id, e);
    }
  }
  return result;
}

import { atomicJson, readJson, Serial } from "../io";

/** A session's cumulative usage in the ledger's own names. Every field only
 *  grows over the life of a session. */
export type WorkspaceTotals = {
  /** List cost in whole US cents: model tokens, web searches and session
   *  running time at Anthropic's public prices. */
  list_cost_cents: number;
  /** Seconds the session was running, which is what its runtime is billed on. */
  active_seconds: number;
  input_tokens: number;
  cache_read_tokens: number;
  cache_write_5m_tokens: number;
  cache_write_1h_tokens: number;
  output_tokens: number;
  web_search_requests: number;
  web_fetch_requests: number;
};

/** The usage a session reports, on the session itself and in its usage
 *  events. Both shapes of the official SDK fit; this file does not import it. */
export type SessionUsageLike = {
  active_seconds?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number } | null;
  cache_read_input_tokens?: number;
  input_tokens?: number;
  list_cost?: { amount: string; currency: string } | null;
  output_tokens?: number;
  server_tool_use?: { web_search_requests?: number; web_fetch_requests?: number } | null;
};

// A stored or reported value that is missing, negative or not a number adds nothing.
const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
const emptyTotals = (): WorkspaceTotals => ({
  list_cost_cents: 0, active_seconds: 0, input_tokens: 0, cache_read_tokens: 0,
  cache_write_5m_tokens: 0, cache_write_1h_tokens: 0, output_tokens: 0,
  web_search_requests: 0, web_fetch_requests: 0,
});
const TOTAL_KEYS = Object.keys(emptyTotals()) as (keyof WorkspaceTotals)[];

/** A session's reported usage as totals. `cost` is false when it carries no
 *  list cost, or one that is not whole US cents; `list_cost_cents` is then 0,
 *  which means unknown, not free. The API sends the amount as a string of
 *  minor units. */
export function sessionTotals(usage: SessionUsageLike | null | undefined): { totals: WorkspaceTotals; cost: boolean } {
  const listed = usage?.list_cost;
  const cents = listed?.currency === "USD" && typeof listed.amount === "string" && /^\d+$/.test(listed.amount)
    ? Number(listed.amount)
    : NaN;
  const cost = Number.isSafeInteger(cents);
  return {
    cost,
    totals: {
      list_cost_cents: cost ? cents : 0,
      active_seconds: count(usage?.active_seconds),
      input_tokens: count(usage?.input_tokens),
      cache_read_tokens: count(usage?.cache_read_input_tokens),
      cache_write_5m_tokens: count(usage?.cache_creation?.ephemeral_5m_input_tokens),
      cache_write_1h_tokens: count(usage?.cache_creation?.ephemeral_1h_input_tokens),
      output_tokens: count(usage?.output_tokens),
      web_search_requests: count(usage?.server_tool_use?.web_search_requests),
      web_fetch_requests: count(usage?.server_tool_use?.web_fetch_requests),
    },
  };
}

/** What a session used between two of its cumulative totals. A field that
 *  went down (a reading without a list cost, a stale one) counts as nothing
 *  rather than as a refund. */
export function totalsDelta(now: WorkspaceTotals, before?: WorkspaceTotals | null): WorkspaceTotals {
  const delta = emptyTotals();
  for (const key of TOTAL_KEYS) delta[key] = Math.max(0, count(now[key]) - count(before?.[key]));
  return delta;
}

/** The totals to keep as the next "before": the larger of each field. A
 *  reading that lacks a field must not lower what was already counted, or
 *  the next delta would add the same spend a second time. */
export function totalsMax(now: WorkspaceTotals, before?: WorkspaceTotals | null): WorkspaceTotals {
  const kept = emptyTotals();
  for (const key of TOTAL_KEYS) kept[key] = Math.max(count(now[key]), count(before?.[key]));
  return kept;
}

/** One model's totals for one UTC day. */
export type WorkspaceBucket = WorkspaceTotals & {
  turns: number;
  ultra_turns: number;
  /** Sessions created. */
  sessions: number;
  /** Entries whose session reported no list cost: their cost is missing from
   *  `list_cost_cents`, not zero. */
  unreported_turns: number;
  /** The part of `list_cost_cents` that Haiku Ultra sessions added. */
  ultra_list_cost_cents: number;
  /** Cents the day's and the month's limits count on top of
   *  `list_cost_cents` (`limitCents`). Not a cost, and never shown as one. */
  limit_extra_cents: number;
};
type LedgerFile = { version: 1; days: Record<string, Record<string, WorkspaceBucket>> };

/** What one stretch of a session added. */
export type LedgerEntry = {
  model: string;
  /** The session runs with dynamic workflows (Haiku Ultra). */
  ultra: boolean;
  delta: WorkspaceTotals;
  /** Whether the session reported a list cost for this stretch. Without one
   *  the cost in `delta` is ignored and the entry is counted as unreported. */
  cost_reported: boolean;
  /** `false` for a settlement that is not a turn, such as what a session
   *  still added when it was closed. */
  turn?: boolean;
  new_session?: boolean;
  /** What the stretch was allowed to add, in cents. The limits count it in
   *  place of a cost the session did not report. Left out for a stretch in
   *  which the session reported no usage at all, which is taken as none. */
  allowed_cents?: number;
};

// The same horizon as the request ledger (usage-ledger.ts).
const RETAIN_DAYS = 400;
// `/usage` puts the lines above its JSON in one Discord message.
const LINE_MAX_CHARS = 600;
// A session reports its cost in whole cents, rounded to the nearest: one that
// stays under half a cent reads as free, however many of them are created.
// The limits count this much for each new session instead.
const NEW_SESSION_CENTS = 1;
const day = (date: Date) => date.toISOString().slice(0, 10);
const emptyBucket = (): WorkspaceBucket => ({
  ...emptyTotals(), turns: 0, ultra_turns: 0, sessions: 0, unreported_turns: 0, ultra_list_cost_cents: 0,
  limit_extra_cents: 0,
});
function add(into: WorkspaceBucket, from: Partial<WorkspaceBucket>) {
  for (const key of Object.keys(into) as (keyof WorkspaceBucket)[]) into[key] += count(from[key]);
}
const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/**
 * What Anthropic Workspace sessions cost (decision record: #76). Unlike the
 * request ledger, nothing is priced here: each session reports its own
 * cumulative list cost, and a caller records the difference since it last
 * looked. The list cost is at public prices and is not the invoice. Days are
 * UTC.
 *
 * Counting once is the caller's order: read the session's totals, take
 * `totalsDelta` against the totals stored for that session, `record`, then
 * store `totalsMax` of the two, with no `await` between the last two steps.
 * A crash can then lose one stretch but never count one twice.
 *
 * The day's and the month's limits are checked against `limitCents`, which
 * is the reported cost plus what a report can miss: a cent for each new
 * session, and the whole allowance of a stretch whose session reported usage
 * but no cost. What the owner is shown (`line`, `spentCents`) stays the
 * reported cost.
 */
export class WorkspaceUsage {
  private data: LedgerFile = { version: 1, days: {} };
  private serial = new Serial();
  private queued = false;
  // Until the stored file is merged, a write would replace it with only the
  // turns seen since startup. A file that fails to load is never written.
  private merged = false;
  constructor(
    private path: string,
    private now: () => Date = () => new Date(),
    private onError: (error: unknown) => void = () => {},
  ) {}
  /** Whether the stored file was read. While it was not, `spentCents` only
   *  knows what this process recorded. */
  get loaded() {
    return this.merged;
  }
  async load() {
    const stored = await readJson<LedgerFile>(this.path, { version: 1, days: {} });
    // Turns may finish before the file is read; keep both.
    for (const [date, models] of Object.entries(stored.days ?? {}))
      for (const [model, bucket] of Object.entries(models ?? {}))
        add(((this.data.days[date] ??= {})[model] ??= emptyBucket()), bucket ?? {});
    this.merged = true;
    this.save();
  }
  record(entry: LedgerEntry) {
    const bucket = ((this.data.days[day(this.now())] ??= {})[entry.model] ??= emptyBucket());
    // An unreported cost is unknown. It is counted apart and never estimated:
    // the totals hold what was reported. Only the limits assume the most.
    const delta = { ...totalsDelta(entry.delta), ...(entry.cost_reported ? {} : { list_cost_cents: 0 }) };
    add(bucket, delta);
    if (entry.ultra) bucket.ultra_list_cost_cents += delta.list_cost_cents;
    if (entry.turn !== false) {
      bucket.turns++;
      if (entry.ultra) bucket.ultra_turns++;
    }
    if (!entry.cost_reported) {
      bucket.unreported_turns++;
      bucket.limit_extra_cents += count(entry.allowed_cents);
    }
    if (entry.new_session) {
      bucket.sessions++;
      bucket.limit_extra_cents += NEW_SESSION_CENTS;
    }
    this.prune();
    this.save();
  }
  /** Settles once the latest recorded state is on disk. */
  flush() {
    return this.serial.run(async () => {});
  }
  /** List cost recorded so far in the current UTC day or month, in cents.
   *  Turns without a reported cost add nothing. */
  spentCents(period: "day" | "month"): number {
    return this.period(period).list_cost_cents;
  }
  /** What the limit of the current UTC day or month is checked against, in
   *  cents: the list cost recorded, and what the limits count on top of it. */
  limitCents(period: "day" | "month"): number {
    return this.spentCents(period) + this.period(period).limit_extra_cents;
  }
  private period(period: "day" | "month") {
    const today = day(this.now());
    return this.total(period === "day" ? [today] : this.monthDays(today.slice(0, 7)));
  }
  /** The lines `/usage` shows apart from the request ledger's estimate, or
   *  nothing while the current month has no Workspace record. */
  line(): string | undefined {
    const today = day(this.now());
    const month = today.slice(0, 7);
    const monthDays = this.monthDays(month);
    if (!monthDays.length) return undefined;
    const whole = this.total(monthDays);
    const turns = (b: WorkspaceBucket) => `${dollars(b.list_cost_cents)} / ${b.turns} ターン`;
    const searches = whole.web_search_requests ? `、web search ${whole.web_search_requests} 回` : "";
    const head = [
      "Anthropic Workspace（セッションの list_cost の合計。公開単価での額で、請求額とは一致しないことがあります。日付は UTC）",
      `今日: ${turns(this.total([today]))}`,
      `${month}: ${turns(whole)}（稼働 ${(whole.active_seconds / 3600).toFixed(1)} 時間${searches}）`,
    ];
    const tail = whole.unreported_turns
      ? [`額の報告が無かったターン: ${whole.unreported_turns}（合計に入っていません）`]
      : [];
    // Most expensive first. A model name is free text under a custom
    // LLM_MODEL, so the cheapest ones give way before the lines grow past
    // what the reply has room for.
    const models = Object.entries(this.byModel(monthDays))
      .sort(([a, x], [b, y]) => y.list_cost_cents - x.list_cost_cents || a.localeCompare(b))
      .map(([model, b]) => `  ${model}: ${turns(b)}` +
        (b.ultra_turns || b.ultra_list_cost_cents
          ? `（うち Ultra ${dollars(b.ultra_list_cost_cents)} / ${b.ultra_turns} ターン）`
          : ""));
    const text = (shown: number) => [
      ...head,
      ...models.slice(0, shown),
      ...(shown < models.length ? [`  ほか ${models.length - shown} モデル`] : []),
      ...tail,
    ].join("\n");
    let shown = models.length;
    while (shown > 0 && text(shown).length > LINE_MAX_CHARS) shown--;
    return text(shown);
  }
  private monthDays(month: string) {
    return Object.keys(this.data.days).filter((d) => d.startsWith(month));
  }
  private total(dates: string[]) {
    const sum = emptyBucket();
    for (const d of dates) for (const b of Object.values(this.data.days[d] ?? {})) add(sum, b);
    return sum;
  }
  private byModel(dates: string[]) {
    const models: Record<string, WorkspaceBucket> = {};
    for (const d of dates)
      for (const [model, b] of Object.entries(this.data.days[d]!)) add((models[model] ??= emptyBucket()), b);
    return models;
  }
  private prune() {
    const cutoff = day(new Date(this.now().getTime() - RETAIN_DAYS * 86_400_000));
    for (const d of Object.keys(this.data.days)) if (d < cutoff) delete this.data.days[d];
  }
  private save() {
    // Coalesce turns that finish together into one write of the latest state.
    if (!this.merged || this.queued) return;
    this.queued = true;
    void this.serial.run(async () => {
      this.queued = false;
      await atomicJson(this.path, this.data);
    }).catch(this.onError);
  }
}

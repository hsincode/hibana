import { anthropicCost } from "@hibana/shared/catalog";
import { atomicJson, readJson, Serial } from "./io";
import type { RequestRecord } from "./llm";

/** One model's totals for one UTC day. */
export type UsageBucket = {
  requests: number;
  prompt_tokens: number;
  cached_tokens: number;
  cache_write_tokens: number;
  completion_tokens: number;
  cost_usd: number;
  /** Requests whose model has no price row: their cost is missing from `cost_usd`. */
  unpriced_requests: number;
  /** Requests that returned no usage: their tokens and cost are unknown, not zero. */
  unreported_requests: number;
};
type LedgerFile = { version: 1; days: Record<string, Record<string, UsageBucket>> };

// About 13 months, so the previous month and the same month last year stay
// readable while the file stays a few hundred KB at most.
const RETAIN_DAYS = 400;
const day = (date: Date) => date.toISOString().slice(0, 10);
const empty = (): UsageBucket => ({
  requests: 0, prompt_tokens: 0, cached_tokens: 0, cache_write_tokens: 0,
  completion_tokens: 0, cost_usd: 0, unpriced_requests: 0, unreported_requests: 0,
});
function add(into: UsageBucket, from: UsageBucket) {
  for (const key of Object.keys(into) as (keyof UsageBucket)[]) into[key] += from[key] ?? 0;
}
const usd = (value: number) => Math.round(value * 10_000) / 10_000;

/**
 * Estimated spend on Anthropic's own API (decision record: #44). Each completed
 * request is priced from its reported usage and the catalog's price table.
 * This is an estimate, not the invoice: requests that failed after Anthropic
 * billed them never reach `record`, and price changes need a catalog update.
 * Days are UTC.
 */
export class UsageLedger {
  private data: LedgerFile = { version: 1, days: {} };
  private serial = new Serial();
  private queued = false;
  // Until the stored file is merged, a write would replace it with only the
  // requests seen since startup. A file that fails to load is never written.
  private loaded = false;
  constructor(
    private path: string,
    private now: () => Date = () => new Date(),
    private onError: (error: unknown) => void = () => {},
  ) {}
  async load() {
    const stored = await readJson<LedgerFile>(this.path, { version: 1, days: {} });
    // Requests may complete before the file is read; keep both.
    for (const [date, models] of Object.entries(stored.days ?? {}))
      for (const [model, bucket] of Object.entries(models))
        add(((this.data.days[date] ??= {})[model] ??= empty()), bucket);
    this.loaded = true;
    this.save();
  }
  record(record: RequestRecord) {
    // Other providers are subscriptions or separate bills (#44 scope).
    if (record.provider !== "anthropic") return;
    const today = day(this.now());
    const bucket = ((this.data.days[today] ??= {})[record.model] ??= empty());
    bucket.requests++;
    if (!record.usage_reported) {
      bucket.unreported_requests++;
    } else {
      const u = record.usage;
      bucket.prompt_tokens += u.prompt_tokens;
      bucket.cached_tokens += u.cached_tokens;
      bucket.cache_write_tokens += u.cache_write_tokens ?? 0;
      bucket.completion_tokens += u.completion_tokens;
      const cost = anthropicCost(record.model, {
        prompt: u.prompt_tokens, cache_read: u.cached_tokens,
        cache_write: u.cache_write_tokens ?? 0, output: u.completion_tokens,
      });
      if (cost === undefined) bucket.unpriced_requests++;
      else bucket.cost_usd += cost;
    }
    this.prune();
    this.save();
  }
  /** Settles once the latest recorded state is on disk. */
  flush() {
    return this.serial.run(async () => {});
  }
  /** Compact enough for one Discord reply. */
  summary() {
    const now = this.now();
    const today = day(now);
    const month = today.slice(0, 7);
    const total = (dates: string[]) => {
      const sum = empty();
      for (const d of dates) for (const b of Object.values(this.data.days[d] ?? {})) add(sum, b);
      return sum;
    };
    const monthDays = Object.keys(this.data.days).filter((d) => d.startsWith(month));
    const byModel: Record<string, UsageBucket> = {};
    for (const d of monthDays)
      for (const [model, b] of Object.entries(this.data.days[d]!)) add((byModel[model] ??= empty()), b);
    const brief = (b: UsageBucket) => ({
      cost_usd: usd(b.cost_usd),
      requests: b.requests,
      ...(b.unpriced_requests && { unpriced_requests: b.unpriced_requests }),
      ...(b.unreported_requests && { unreported_requests: b.unreported_requests }),
    });
    const last7 = Array.from({ length: 7 }, (_, i) => day(new Date(now.getTime() - i * 86_400_000)));
    return {
      note: "推計値（usage × 単価表）。請求額とは一致しない。日付は UTC",
      today: brief(total([today])),
      month: { month, ...brief(total(monthDays)) },
      month_by_model: Object.fromEntries(
        Object.entries(byModel).map(([model, b]) => [model, {
          ...brief(b),
          input_tokens: b.prompt_tokens - b.cached_tokens - b.cache_write_tokens,
          cache_read_tokens: b.cached_tokens,
          cache_write_tokens: b.cache_write_tokens,
          output_tokens: b.completion_tokens,
        }]),
      ),
      last_7_days: Object.fromEntries(last7.map((d) => [d, usd(total([d]).cost_usd)])),
    };
  }
  private prune() {
    const cutoff = day(new Date(this.now().getTime() - RETAIN_DAYS * 86_400_000));
    for (const d of Object.keys(this.data.days)) if (d < cutoff) delete this.data.days[d];
  }
  private save() {
    // Coalesce bursts (tool loops) into one write of the latest state.
    if (!this.loaded || this.queued) return;
    this.queued = true;
    void this.serial.run(async () => {
      this.queued = false;
      await atomicJson(this.path, this.data);
    }).catch(this.onError);
  }
}

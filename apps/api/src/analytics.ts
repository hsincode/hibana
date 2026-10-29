// Daily Anthropic API cost for the dashboard's /analytics page, read from the
// Admin API cost report (decision record: #48).
//
// The report is organization-wide and billing-based, so it also counts
// requests the bot's own estimate (#44) cannot see. It is not in the official
// SDKs, hence the plain HTTP call. Days are UTC: the report has no other
// granularity or time zone. It only covers days that have ended; the running
// day is absent until UTC midnight (checked against the real API, #48).
//
// A "month" here is a billing month: from the 5th, when the monthly credit is
// granted, to the 4th of the next month (decision record: #81). It is named
// after the calendar month it starts in, so `2026-10` is 5 October to
// 4 November.
//
// The running day is estimated from the usage report instead (decision
// record: #85): it is near real time, minute by minute, but gives tokens, not
// dollars, so they are priced here. Every logged-in user may read both (#85),
// so the calls to Anthropic are capped per API instance, not per user. Vercel
// may run more than one instance; each has its own cache and cap.

import { billingBounds, billingMonth } from "@hibana/shared/billing";
import { budgetLow } from "@hibana/shared/budget";
import { ANTHROPIC_PRICES, CACHE_WRITE_5M } from "@hibana/shared/catalog";

const ENDPOINT = "https://api.anthropic.com/v1/organizations/cost_report";
const USAGE_ENDPOINT =
  "https://api.anthropic.com/v1/organizations/usage_report/messages";

/** The owner's monthly budget. The daily guideline is this over the billing month's days. */
export const MONTHLY_BUDGET_USD = 200;

// Anthropic asks for at most one poll a minute and for dashboards to cache.
const CACHE_MS = 60_000;
// Requests to Anthropic per rolling minute and instance, cost and usage report together.
// With the 1-minute cache, a page load costs at most two; this only binds
// when someone walks through many months at once (#85).
export const MAX_CALLS_PER_MINUTE = 10;
// A billing month is as long as the calendar month it starts in, so it fits
// in a single page (limit 31). More pages than this means the
// report is not answering the question that was asked.
const MAX_PAGES = 4;
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

export class CostReportError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export type CostDay = {
  /** UTC date, `YYYY-MM-DD`. */
  date: string;
  /** null = the report had no bucket for this day (not the same as $0). */
  cost_usd: number | null;
  /** Strictly above the daily guideline. */
  over: boolean;
};

export type CostMonth = {
  configured: true;
  /** The billing month, `YYYY-MM`: the calendar month its first day (the 5th) is in. */
  month: string;
  /** The month contains `today`, so it has days the report does not cover yet. */
  current: boolean;
  /** UTC date the summary was computed on. */
  today: string;
  monthly_budget_usd: number;
  days_in_month: number;
  daily_guideline_usd: number;
  /** Days that have ended in UTC, oldest first. Today and later are left out. */
  days: CostDay[];
  spent_usd: number;
  /** Budget minus spend; negative once the budget is exceeded. */
  remaining_usd: number;
  /** The guideline summed over `days`: what spend would be exactly on the line. */
  pace_usd: number;
  /** Days of the month not in `days` yet, today included. 0 for a past month. */
  days_left: number;
  fetched_at: number;
};

const utcDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const utcTimestamp = (ms: number) =>
  `${new Date(ms).toISOString().slice(0, 19)}Z`;

/** Start and end (exclusive) of a `YYYY-MM` billing month in UTC. */
function bounds(month: string) {
  const { start, end } = billingBounds(month);
  return {
    start: Date.parse(`${start}T00:00:00Z`),
    end: Date.parse(`${end}T00:00:00Z`),
  };
}

/** `YYYY-MM`, defaulting to the current billing month. null for anything else, including a month that has not started. */
export function parseMonth(
  raw: string | undefined,
  now: number,
): string | null {
  const current = billingMonth(utcDate(now));
  if (raw === undefined || raw === "") return current;
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(raw)) return null;
  return raw <= current ? raw : null;
}

/** Pure: turn per-day costs into what the page shows. */
export function summarize(
  month: string,
  costs: ReadonlyMap<string, number>,
  now: number,
  fetchedAt: number,
): CostMonth {
  const { start, end } = bounds(month);
  const daysInMonth = Math.round((end - start) / DAY_MS);
  const guideline = MONTHLY_BUDGET_USD / daysInMonth;
  const today = utcDate(now);
  const current = billingMonth(today) === month;
  const days: CostDay[] = [];
  let spent = 0;
  for (let t = start; t < end; t += DAY_MS) {
    const date = utcDate(t);
    // Today has no figure until it ends, so listing it would only show a gap.
    if (date >= today) break;
    const cost = costs.get(date) ?? null;
    if (cost !== null) spent += cost;
    days.push({
      date,
      cost_usd: cost,
      over: cost !== null && cost > guideline,
    });
  }
  return {
    configured: true,
    month,
    current,
    today,
    monthly_budget_usd: MONTHLY_BUDGET_USD,
    days_in_month: daysInMonth,
    daily_guideline_usd: guideline,
    days,
    spent_usd: spent,
    remaining_usd: MONTHLY_BUDGET_USD - spent,
    pace_usd: guideline * days.length,
    days_left: current ? daysInMonth - days.length : 0,
    fetched_at: fetchedAt,
  };
}

export type UnpricedUsage = {
  /** null when the report did not say. */
  model: string | null;
  service_tier: string | null;
  /** Input of every kind plus output. */
  tokens: number;
};

export type CostToday = {
  configured: true;
  /** UTC date, `YYYY-MM-DD`. */
  date: string;
  /** End of the last minute asked for (RFC 3339): usage before it is counted. */
  through: string;
  /** End of the last minute that had any usage, or null for none today. */
  last_usage_at: string | null;
  /** Estimate of the priced usage. Not the bill: see `estimate`. */
  cost_usd: number;
  /** The guideline of the billing month today is in. */
  daily_guideline_usd: number;
  /** Strictly above the daily guideline. */
  over: boolean;
  /** Usage left out of `cost_usd`, largest first. */
  unpriced: UnpricedUsage[];
  fetched_at: number;
};

/** One result of the usage report, grouped by model, service tier, inference geo and context window. */
export type UsageRow = {
  model: string | null;
  service_tier: string | null;
  inference_geo: string | null;
  context_window: string | null;
  uncached_input_tokens: number;
  cache_read_input_tokens: number;
  cache_write_5m_tokens: number;
  cache_write_1h_tokens: number;
  output_tokens: number;
  web_search_requests: number;
};

// Multipliers and fees from https://platform.claude.com/docs/en/about-claude/pricing,
// read 2026-10-15 (#85). The per-token rates themselves are the bot's table
// (`ANTHROPIC_PRICES`), so a price is changed in one place.
const BATCH = 0.5;
const US_ONLY = 1.1; // `inference_geo: "us"`, Claude 4.6 and later
const WEB_SEARCH_USD = 10 / 1000;
// Tiers whose price is known. Priority Tier is billed differently and is not
// in the cost report either; flex has no price on the pricing page.
const TIER = new Map<string | null, number>([
  ["standard", 1],
  ["batch", BATCH],
  [null, 1],
]);

/**
 * Pure: price the usage report's rows in USD. An estimate, not the bill:
 * - a model the table does not price, or another service tier, is listed in
 *   `unpriced` rather than guessed;
 * - Claude Haiku 5.5 bills a request over 100,000 prompt tokens at its higher
 *   row, but the report only splits at 200,000 (`context_window`). Rows over
 *   200,000 get the higher row; requests between the two are counted low;
 * - fast mode (not grouped, so not seen), code execution and Managed Agents
 *   session runtime are not in the usage report at all.
 */
export function estimate(rows: readonly UsageRow[]): {
  cost_usd: number;
  unpriced: UnpricedUsage[];
} {
  let cost = 0;
  const unpriced = new Map<string, UnpricedUsage>();
  for (const r of rows) {
    // Charged per search whatever the model.
    cost += r.web_search_requests * WEB_SEARCH_USD;
    // The model name is the report's, so do not let it reach Object.prototype.
    const row =
      r.model !== null && Object.hasOwn(ANTHROPIC_PRICES, r.model)
        ? ANTHROPIC_PRICES[r.model]
        : undefined;
    const tier = TIER.get(r.service_tier);
    if (!row || tier === undefined) {
      const tokens =
        r.uncached_input_tokens +
        r.cache_read_input_tokens +
        r.cache_write_5m_tokens +
        r.cache_write_1h_tokens +
        r.output_tokens;
      if (tokens === 0) continue;
      const key = `${r.model}\u0000${r.service_tier}`;
      const entry = unpriced.get(key) ?? {
        model: r.model,
        service_tier: r.service_tier,
        tokens: 0,
      };
      entry.tokens += tokens;
      unpriced.set(key, entry);
      continue;
    }
    const price = row.long && r.context_window === "200k-1M" ? row.long : row;
    const tokens =
      r.uncached_input_tokens * price.input +
      r.cache_write_5m_tokens * price.input * CACHE_WRITE_5M +
      r.cache_write_1h_tokens * price.cache_write_1h +
      r.cache_read_input_tokens * price.cache_read +
      r.output_tokens * price.output;
    cost +=
      (tokens / 1_000_000) * tier * (r.inference_geo === "us" ? US_ONLY : 1);
  }
  return {
    cost_usd: cost,
    unpriced: [...unpriced.values()].sort((a, b) => b.tokens - a.tokens),
  };
}

/** Whether Anthropic API turns run on the fallback model (#89). */
export type BudgetStatus = {
  configured: true;
  /** The billing month the figures are for. */
  month: string;
  /** "今月の残り": the budget minus the days the cost report has. */
  remaining_usd: number;
  /** "今日の推計". */
  today_usd: number;
  remaining_after_today_usd: number;
  threshold_usd: number;
  /** remaining_after_today_usd is below threshold_usd. */
  low: boolean;
  /** When the older of the two figures was read from Anthropic. */
  fetched_at: number;
};

type Page = { data?: unknown; has_more?: unknown; next_page?: unknown };
type TodayUsage = { rows: UsageRow[]; through: string; last: string | null };

const malformed = (report = "cost report") =>
  new CostReportError(502, `Anthropic の ${report} が想定外の形式でした`);
const malformedUsage = () => malformed("usage report");

/** A token count: a missing field is 0, anything but a non-negative number is a malformed report. */
function count(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw malformedUsage();
  return value;
}

const label = (value: unknown): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw malformedUsage();
  return value;
};

/** Read one page of the usage report into `rows`. Returns the end of the last minute with usage on it. */
function addUsagePage(rows: UsageRow[], page: Page): string | null {
  if (!Array.isArray(page.data)) throw malformedUsage();
  let last: string | null = null;
  for (const bucket of page.data as {
    ending_at?: unknown;
    results?: unknown;
  }[]) {
    if (typeof bucket?.ending_at !== "string" || !Array.isArray(bucket.results))
      throw malformedUsage();
    for (const item of bucket.results as Record<string, unknown>[]) {
      if (!item || typeof item !== "object") throw malformedUsage();
      const cache = (item.cache_creation ?? {}) as Record<string, unknown>;
      const tools = (item.server_tool_use ?? {}) as Record<string, unknown>;
      if (typeof cache !== "object" || typeof tools !== "object")
        throw malformedUsage();
      const row: UsageRow = {
        model: label(item.model),
        service_tier: label(item.service_tier),
        inference_geo: label(item.inference_geo),
        context_window: label(item.context_window),
        uncached_input_tokens: count(item.uncached_input_tokens),
        cache_read_input_tokens: count(item.cache_read_input_tokens),
        cache_write_5m_tokens: count(cache.ephemeral_5m_input_tokens),
        cache_write_1h_tokens: count(cache.ephemeral_1h_input_tokens),
        output_tokens: count(item.output_tokens),
        web_search_requests: count(tools.web_search_requests),
      };
      rows.push(row);
      if (
        row.uncached_input_tokens +
          row.cache_read_input_tokens +
          row.cache_write_5m_tokens +
          row.cache_write_1h_tokens +
          row.output_tokens +
          row.web_search_requests >
        0
      )
        last = bucket.ending_at;
    }
  }
  return last;
}

/** Add one page's buckets to `costs`, in USD. Buckets outside `month` are ignored. */
function addPage(costs: Map<string, number>, month: string, page: Page) {
  if (!Array.isArray(page.data)) throw malformed();
  for (const bucket of page.data as {
    starting_at?: unknown;
    results?: unknown;
  }[]) {
    if (
      typeof bucket?.starting_at !== "string" ||
      !Array.isArray(bucket.results)
    )
      throw malformed();
    const date = bucket.starting_at.slice(0, 10);
    if (billingMonth(date) !== month) continue;
    // An empty `results` is a day with no cost, which still counts as reported.
    let cents = 0;
    for (const item of bucket.results as {
      amount?: unknown;
      currency?: unknown;
    }[]) {
      const amount =
        typeof item?.amount === "string" ? Number(item.amount) : NaN;
      // Summing another currency into a dollar total would be silently wrong.
      if (item?.currency !== "USD" || !Number.isFinite(amount))
        throw malformed();
      cents += amount;
    }
    // `amount` is in the lowest currency unit: "123.45" is $1.2345.
    costs.set(date, (costs.get(date) ?? 0) + cents / 100);
  }
}

export class CostReport {
  // Keyed by month. The promise is cached, so concurrent readers share one call.
  private cache = new Map<
    string,
    { at: number; costs: Promise<Map<string, number>> }
  >();
  // The running day's usage, the same way. One entry: only today is asked for.
  private todayCache: {
    date: string;
    at: number;
    usage: Promise<TodayUsage>;
  } | null = null;
  // When each recent request to Anthropic was sent, for MAX_CALLS_PER_MINUTE.
  private sent: number[] = [];

  constructor(
    // The key reaches the whole organization (an Admin API key can manage it).
    // It stays in this process: never returned to the dashboard, never logged,
    // never put in an error.
    private adminKey: string | null,
    private fetcher: typeof fetch = fetch,
    private now: () => number = Date.now,
  ) {}

  get configured(): boolean {
    return Boolean(this.adminKey);
  }

  async month(month: string): Promise<CostMonth> {
    const now = this.now();
    for (const [key, entry] of this.cache)
      if (now - entry.at >= CACHE_MS) this.cache.delete(key);
    let entry = this.cache.get(month);
    if (!entry) {
      const fresh = { at: now, costs: this.fetchMonth(month, now) };
      entry = fresh;
      this.cache.set(month, fresh);
      // A failure is not cached, so the next reload asks again.
      fresh.costs.catch(() => {
        if (this.cache.get(month) === fresh) this.cache.delete(month);
      });
    }
    return summarize(month, await entry.costs, now, entry.at);
  }

  /**
   * The current billing month's remaining budget with today's estimate taken
   * off, as "今日の推計を含めると残り" on the page, and whether that is below
   * `thresholdUsd`, the stored fallback threshold (#89, #95). It reads the
   * same caches as the page, so a caller polling it every few minutes adds at
   * most one call of each report per minute. Either report failing fails the whole status: half of it would
   * overstate what is left.
   */
  async budget(thresholdUsd: number): Promise<BudgetStatus> {
    const month = billingMonth(utcDate(this.now()));
    const [m, t] = await Promise.all([this.month(month), this.today()]);
    const after = m.remaining_usd - t.cost_usd;
    return {
      configured: true,
      month,
      remaining_usd: m.remaining_usd,
      today_usd: t.cost_usd,
      remaining_after_today_usd: after,
      threshold_usd: thresholdUsd,
      low: budgetLow(after, thresholdUsd),
      fetched_at: Math.min(m.fetched_at, t.fetched_at),
    };
  }

  /** The running UTC day, estimated from the usage report. */
  async today(): Promise<CostToday> {
    const now = this.now();
    const date = utcDate(now);
    let entry = this.todayCache;
    // A new UTC day starts over, even inside the minute.
    if (!entry || entry.date !== date || now - entry.at >= CACHE_MS) {
      const fresh = { date, at: now, usage: this.fetchToday(now) };
      entry = fresh;
      this.todayCache = fresh;
      fresh.usage.catch(() => {
        if (this.todayCache === fresh) this.todayCache = null;
      });
    }
    const usage = await entry.usage;
    const { start, end } = bounds(billingMonth(date));
    const guideline = MONTHLY_BUDGET_USD / Math.round((end - start) / DAY_MS);
    const { cost_usd, unpriced } = estimate(usage.rows);
    return {
      configured: true,
      date,
      through: usage.through,
      last_usage_at: usage.last,
      cost_usd,
      daily_guideline_usd: guideline,
      over: cost_usd > guideline,
      unpriced,
      fetched_at: entry.at,
    };
  }

  private async fetchToday(now: number): Promise<TodayUsage> {
    const start = Math.floor(now / DAY_MS) * DAY_MS;
    // Whole minutes only. Whether the report answers for a minute that is
    // still running is not known (#85), so it is never asked to.
    const until = Math.floor(now / MINUTE_MS) * MINUTE_MS;
    const usage: TodayUsage = {
      rows: [],
      through: utcTimestamp(until),
      last: null,
    };
    if (until <= start) return usage;
    let page: string | null = null;
    for (let i = 0; i < MAX_PAGES; i++) {
      const params = new URLSearchParams({
        starting_at: utcTimestamp(start),
        ending_at: utcTimestamp(until),
        // A day is 1440 minutes, the most one page holds.
        bucket_width: "1m",
        limit: "1440",
      });
      for (const key of [
        "model",
        "service_tier",
        "inference_geo",
        "context_window",
      ])
        params.append("group_by[]", key);
      if (page) params.set("page", page);
      const body = await this.request(USAGE_ENDPOINT, "usage report", params);
      usage.last = addUsagePage(usage.rows, body) ?? usage.last;
      if (body.has_more !== true) return usage;
      if (typeof body.next_page !== "string" || !body.next_page)
        throw malformedUsage();
      page = body.next_page;
    }
    throw malformedUsage();
  }

  private async fetchMonth(
    month: string,
    now: number,
  ): Promise<Map<string, number>> {
    const { start, end } = bounds(month);
    const costs = new Map<string, number>();
    // The report stops at the last day that has ended, whatever `ending_at`
    // says, and answers 400 when the range holds no such day. So ask only for
    // finished days, and on the first day of a billing month do not ask at all.
    const until = Math.min(end, Math.floor(now / DAY_MS) * DAY_MS);
    if (until <= start) return costs;
    let page: string | null = null;
    for (let i = 0; i < MAX_PAGES; i++) {
      const params = new URLSearchParams({
        starting_at: utcTimestamp(start),
        ending_at: utcTimestamp(until),
        bucket_width: "1d",
        limit: "31",
      });
      if (page) params.set("page", page);
      const body = await this.request(ENDPOINT, "cost report", params);
      addPage(costs, month, body);
      if (body.has_more !== true) return costs;
      if (typeof body.next_page !== "string" || !body.next_page)
        throw malformed();
      page = body.next_page;
    }
    throw malformed();
  }

  private async request(
    endpoint: string,
    report: string,
    params: URLSearchParams,
  ): Promise<Page> {
    const now = this.now();
    this.sent = this.sent.filter((t) => now - t < MINUTE_MS);
    if (this.sent.length >= MAX_CALLS_PER_MINUTE) {
      throw new CostReportError(
        429,
        "利用料の取得が混み合っています。1 分ほど待って再読み込みしてください",
      );
    }
    this.sent.push(now);
    let res: Response;
    try {
      res = await this.fetcher(`${endpoint}?${params}`, {
        headers: {
          "x-api-key": this.adminKey ?? "",
          "anthropic-version": "2023-06-01",
          "user-agent": "Hibana (https://github.com/hsincode/hibana)",
        },
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new CostReportError(
        502,
        `Anthropic の ${report} に接続できませんでした`,
      );
    }
    // The two refusals call for different fixes: 401 is a wrong value, 403 is
    // a valid key whose account may not read the report.
    if (res.status === 401) {
      throw new CostReportError(
        502,
        "Anthropic がキーを認証できませんでした（HTTP 401）。ANTHROPIC_ADMIN_API_KEY の値を確認してください",
      );
    }
    if (res.status === 403) {
      throw new CostReportError(
        502,
        `このキーには ${report} を読む権限がありません（HTTP 403）。ANTHROPIC_ADMIN_API_KEY に Admin API キーを設定するか、キーを発行したアカウントの組織ロールを確認してください`,
      );
    }
    if (res.status === 429) {
      throw new CostReportError(
        502,
        `Anthropic の ${report} がリクエスト制限中です（HTTP 429）。1 分ほど待って再読み込みしてください`,
      );
    }
    // The upstream body is not relayed: only the status is known to be safe to show.
    if (!res.ok)
      throw new CostReportError(
        502,
        `Anthropic の ${report} が HTTP ${res.status} を返しました`,
      );
    const body = (await res.json().catch(() => null)) as Page | null;
    if (!body || typeof body !== "object") throw malformed(report);
    return body;
  }
}

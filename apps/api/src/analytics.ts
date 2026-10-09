// Daily Anthropic API cost for the dashboard's /analytics page, read from the
// Admin API cost report (decision record: #48).
//
// The report is organization-wide and billing-based, so it also counts
// requests the bot's own estimate (#44) cannot see. It is not in the official
// SDKs, hence the plain HTTP call. Days are UTC: the report has no other
// granularity or time zone.

const ENDPOINT = "https://api.anthropic.com/v1/organizations/cost_report";

/** The owner's monthly budget. The daily guideline is this over the month's days. */
export const MONTHLY_BUDGET_USD = 200;

// Anthropic asks for at most one poll a minute and for dashboards to cache.
const CACHE_MS = 60_000;
// One month fits in a single page (limit 31). More pages than this means the
// report is not answering the question that was asked.
const MAX_PAGES = 4;
const DAY_MS = 86_400_000;

export class CostReportError extends Error {
  constructor(public status: number, message: string) { super(message); }
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
  month: string;
  /** The month contains `today`, so its last day is still accumulating. */
  current: boolean;
  /** UTC date the summary was computed on. */
  today: string;
  monthly_budget_usd: number;
  days_in_month: number;
  daily_guideline_usd: number;
  /** Days that have started, oldest first. Future days are left out. */
  days: CostDay[];
  spent_usd: number;
  /** Budget minus spend; negative once the budget is exceeded. */
  remaining_usd: number;
  /** The guideline summed over `days`: what spend would be exactly on the line. */
  pace_usd: number;
  /** Days of the month not yet finished, today included. 0 for a past month. */
  days_left: number;
  fetched_at: number;
};

const utcDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const pad = (n: number, width: number) => String(n).padStart(width, "0");

/** Start and end (exclusive) of a `YYYY-MM` month in UTC, and the month after it. */
function bounds(month: string) {
  const [year, mon] = month.split("-").map(Number);
  const next = mon === 12 ? `${pad(year + 1, 4)}-01` : `${pad(year, 4)}-${pad(mon + 1, 2)}`;
  return {
    start: Date.parse(`${month}-01T00:00:00Z`),
    end: Date.parse(`${next}-01T00:00:00Z`),
    next,
  };
}

/** `YYYY-MM`, defaulting to the current UTC month. null for anything else, including a month that has not started. */
export function parseMonth(raw: string | undefined, now: number): string | null {
  const current = utcDate(now).slice(0, 7);
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
  const current = today.startsWith(month);
  const days: CostDay[] = [];
  let spent = 0;
  for (let t = start; t < end; t += DAY_MS) {
    const date = utcDate(t);
    if (date > today) break;
    const cost = costs.get(date) ?? null;
    if (cost !== null) spent += cost;
    days.push({ date, cost_usd: cost, over: cost !== null && cost > guideline });
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
    days_left: current ? daysInMonth - days.length + 1 : 0,
    fetched_at: fetchedAt,
  };
}

type Page = { data?: unknown; has_more?: unknown; next_page?: unknown };

const malformed = () => new CostReportError(502, "Anthropic の cost report が想定外の形式でした");

/** Add one page's buckets to `costs`, in USD. Buckets outside `month` are ignored. */
function addPage(costs: Map<string, number>, month: string, page: Page) {
  if (!Array.isArray(page.data)) throw malformed();
  for (const bucket of page.data as { starting_at?: unknown; results?: unknown }[]) {
    if (typeof bucket?.starting_at !== "string" || !Array.isArray(bucket.results)) throw malformed();
    const date = bucket.starting_at.slice(0, 10);
    if (!date.startsWith(month)) continue;
    // An empty `results` is a day with no cost, which still counts as reported.
    let cents = 0;
    for (const item of bucket.results as { amount?: unknown; currency?: unknown }[]) {
      const amount = typeof item?.amount === "string" ? Number(item.amount) : NaN;
      // Summing another currency into a dollar total would be silently wrong.
      if (item?.currency !== "USD" || !Number.isFinite(amount)) throw malformed();
      cents += amount;
    }
    // `amount` is in the lowest currency unit: "123.45" is $1.2345.
    costs.set(date, (costs.get(date) ?? 0) + cents / 100);
  }
}

export class CostReport {
  // Keyed by month. The promise is cached, so concurrent readers share one call.
  private cache = new Map<string, { at: number; costs: Promise<Map<string, number>> }>();

  constructor(
    // An Admin API key can manage the organization. It stays in this process:
    // never returned to the dashboard, never logged, never put in an error.
    private adminKey: string | null,
    private fetcher: typeof fetch = fetch,
    private now: () => number = Date.now,
  ) {}

  get configured(): boolean {
    return Boolean(this.adminKey);
  }

  async month(month: string): Promise<CostMonth> {
    const now = this.now();
    for (const [key, entry] of this.cache) if (now - entry.at >= CACHE_MS) this.cache.delete(key);
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

  private async fetchMonth(month: string, now: number): Promise<Map<string, number>> {
    const { end, next } = bounds(month);
    const costs = new Map<string, number>();
    let page: string | null = null;
    for (let i = 0; i < MAX_PAGES; i++) {
      const params = new URLSearchParams({
        starting_at: `${month}-01T00:00:00Z`,
        bucket_width: "1d",
        limit: "31",
      });
      // A running month has no closed end yet: without `ending_at` the report
      // runs up to now, and anything past the month is dropped in addPage.
      if (end <= now) params.set("ending_at", `${next}-01T00:00:00Z`);
      if (page) params.set("page", page);
      const body = await this.request(params);
      addPage(costs, month, body);
      if (body.has_more !== true) return costs;
      if (typeof body.next_page !== "string" || !body.next_page) throw malformed();
      page = body.next_page;
    }
    throw malformed();
  }

  private async request(params: URLSearchParams): Promise<Page> {
    let res: Response;
    try {
      res = await this.fetcher(`${ENDPOINT}?${params}`, {
        headers: {
          "x-api-key": this.adminKey ?? "",
          "anthropic-version": "2023-06-01",
          "user-agent": "Hibana (https://github.com/hsincode/hibana)",
        },
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new CostReportError(502, "Anthropic の cost report に接続できませんでした");
    }
    if (res.status === 401 || res.status === 403) {
      throw new CostReportError(
        502,
        `Anthropic が Admin キーを拒否しました（HTTP ${res.status}）。ANTHROPIC_ADMIN_KEY が Admin API キーか確認してください`,
      );
    }
    if (res.status === 429) {
      throw new CostReportError(502, "Anthropic の cost report がリクエスト制限中です（HTTP 429）。1 分ほど待って再読み込みしてください");
    }
    // The upstream body is not relayed: only the status is known to be safe to show.
    if (!res.ok) throw new CostReportError(502, `Anthropic の cost report が HTTP ${res.status} を返しました`);
    const body = (await res.json().catch(() => null)) as Page | null;
    if (!body || typeof body !== "object") throw malformed();
    return body;
  }
}

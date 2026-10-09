import { describe, expect, test } from "bun:test";
import { CostReport, CostReportError, MONTHLY_BUDGET_USD, parseMonth, summarize } from "./analytics";
import { createApp } from "./create-app";
import { loadTestEnv } from "./env";
import { MemoryStore } from "./store";

const ADMIN_KEY = "sk-ant-admin01-test-key";
const at = (iso: string) => Date.parse(iso);

/** One daily bucket as the cost report returns it; amounts are cents as decimal strings. */
function bucket(date: string, amounts: string[], currency = "USD") {
  const end = new Date(at(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  return {
    starting_at: `${date}T00:00:00Z`,
    ending_at: `${end}T00:00:00Z`,
    results: amounts.map((amount) => ({ amount, currency, description: null, workspace_id: null })),
  };
}

/** Fake Admin API: answers each call with the next page and records what was asked. */
function upstream(pages: (object | Response)[]) {
  const calls: { url: URL; headers: Headers }[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: new URL(String(input)), headers: new Headers(init?.headers) });
    const page = pages[Math.min(calls.length, pages.length) - 1];
    return page instanceof Response ? page.clone() : Response.json(page);
  }) as typeof fetch;
  return { calls, fetcher };
}

describe("summarize", () => {
  test("the daily guideline is the budget over the month's days", () => {
    const now = at("2027-01-01T00:00:00Z");
    expect(MONTHLY_BUDGET_USD).toBe(200);
    expect(summarize("2026-10", new Map(), now, now).daily_guideline_usd).toBeCloseTo(200 / 31, 10);
    expect(summarize("2026-09", new Map(), now, now).daily_guideline_usd).toBeCloseTo(200 / 30, 10);
    expect(summarize("2026-02", new Map(), now, now).days_in_month).toBe(28);
    expect(summarize("2024-02", new Map(), now, now).days_in_month).toBe(29);
    expect(summarize("2026-12", new Map(), now, now).days_in_month).toBe(31);
  });

  test("a day is over only when it is strictly above the guideline", () => {
    const now = at("2026-10-01T00:00:00Z");
    const guideline = 200 / 30;
    const costs = new Map([
      ["2026-09-01", guideline],
      ["2026-09-02", guideline + 0.01],
      ["2026-09-03", 0],
    ]);
    const { days } = summarize("2026-09", costs, now, now);
    expect(days.slice(0, 3).map((d) => d.over)).toEqual([false, true, false]);
  });

  test("a running month lists the days that have ended and what is left of the budget", () => {
    const now = at("2026-10-09T03:00:00Z");
    const costs = new Map([
      ["2026-10-01", 10],
      ["2026-10-02", 2.5],
      ["2026-10-08", 1.25],
    ]);
    const m = summarize("2026-10", costs, now, now);
    expect(m.current).toBe(true);
    expect(m.today).toBe("2026-10-09");
    expect(m.days.map((d) => d.date)).toEqual([
      "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04",
      "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08",
    ]);
    expect(m.spent_usd).toBeCloseTo(13.75, 10);
    expect(m.remaining_usd).toBeCloseTo(186.25, 10);
    expect(m.pace_usd).toBeCloseTo((200 / 31) * 8, 10);
    // 9th through 31st: today is still ahead, since it has no figure yet.
    expect(m.days_left).toBe(23);
  });

  test("a day the report did not return is unknown, not zero", () => {
    const now = at("2026-10-03T12:00:00Z");
    const m = summarize("2026-10", new Map([["2026-10-01", 0]]), now, now);
    expect(m.days).toEqual([
      { date: "2026-10-01", cost_usd: 0, over: false },
      { date: "2026-10-02", cost_usd: null, over: false },
    ]);
  });

  test("a past month is complete and can end over budget", () => {
    const now = at("2026-10-09T00:00:00Z");
    const costs = new Map(Array.from({ length: 30 }, (_, i) => [`2026-09-${String(i + 1).padStart(2, "0")}`, 7] as const));
    const m = summarize("2026-09", costs, now, now);
    expect(m.current).toBe(false);
    expect(m.days).toHaveLength(30);
    expect(m.days.every((d) => d.over)).toBe(true);
    expect(m.spent_usd).toBeCloseTo(210, 10);
    expect(m.remaining_usd).toBeCloseTo(-10, 10);
    expect(m.pace_usd).toBeCloseTo(200, 10);
    expect(m.days_left).toBe(0);
  });
});

describe("parseMonth", () => {
  const now = at("2026-10-09T03:00:00Z");
  test("defaults to the current UTC month", () => {
    expect(parseMonth(undefined, now)).toBe("2026-10");
    expect(parseMonth("", now)).toBe("2026-10");
    // 08:59 JST on the 1st is still the previous month in UTC.
    expect(parseMonth(undefined, at("2026-09-30T23:59:00Z"))).toBe("2026-09");
  });
  test("accepts a past or current month and nothing else", () => {
    expect(parseMonth("2026-10", now)).toBe("2026-10");
    expect(parseMonth("2025-12", now)).toBe("2025-12");
    for (const bad of ["2026-11", "2027-01", "2026-13", "2026-00", "2026-1", "26-10", "2026-10-01", "2026-10&limit=1"])
      expect(parseMonth(bad, now)).toBeNull();
  });
});

describe("CostReport", () => {
  test("asks for a closed month and converts cents to dollars", async () => {
    const { calls, fetcher } = upstream([
      {
        data: [
          bucket("2026-09-01", ["123.45"]),
          // Grouped reports return several items for a day; they add up.
          bucket("2026-09-02", ["1000", "250.5"]),
          bucket("2026-09-03", []),
          // Not part of the month that was asked for.
          bucket("2026-10-01", ["99999"]),
        ],
        has_more: false,
        next_page: null,
      },
    ]);
    const report = new CostReport(ADMIN_KEY, fetcher, () => at("2026-10-09T00:00:00Z"));
    const m = await report.month("2026-09");

    expect(calls).toHaveLength(1);
    const { url, headers } = calls[0];
    expect(url.origin + url.pathname).toBe("https://api.anthropic.com/v1/organizations/cost_report");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      starting_at: "2026-09-01T00:00:00Z",
      ending_at: "2026-10-01T00:00:00Z",
      bucket_width: "1d",
      limit: "31",
    });
    expect(headers.get("x-api-key")).toBe(ADMIN_KEY);
    expect(headers.get("anthropic-version")).toBe("2023-06-01");

    expect(m.days[0]).toEqual({ date: "2026-09-01", cost_usd: 1.2345, over: false });
    expect(m.days[1]).toEqual({ date: "2026-09-02", cost_usd: 12.505, over: true });
    expect(m.days[2]).toEqual({ date: "2026-09-03", cost_usd: 0, over: false });
    expect(m.days[3].cost_usd).toBeNull();
    expect(m.spent_usd).toBeCloseTo(13.7395, 10);
  });

  test("December ends at the next year's January", async () => {
    const { calls, fetcher } = upstream([{ data: [], has_more: false, next_page: null }]);
    await new CostReport(ADMIN_KEY, fetcher, () => at("2026-10-09T00:00:00Z")).month("2025-12");
    expect(calls[0].url.searchParams.get("ending_at")).toBe("2026-01-01T00:00:00Z");
  });

  test("follows next_page until the report is complete", async () => {
    const { calls, fetcher } = upstream([
      { data: [bucket("2026-09-01", ["100"])], has_more: true, next_page: "page_2" },
      { data: [bucket("2026-09-02", ["200"])], has_more: false, next_page: null },
    ]);
    const m = await new CostReport(ADMIN_KEY, fetcher, () => at("2026-10-09T00:00:00Z")).month("2026-09");
    expect(calls.map((c) => c.url.searchParams.get("page"))).toEqual([null, "page_2"]);
    expect(m.spent_usd).toBeCloseTo(3, 10);
  });

  test("a report that never ends is an error, not an endless loop", async () => {
    const { calls, fetcher } = upstream([{ data: [], has_more: true, next_page: "again" }]);
    const report = new CostReport(ADMIN_KEY, fetcher, () => at("2026-10-09T00:00:00Z"));
    await expect(report.month("2026-09")).rejects.toBeInstanceOf(CostReportError);
    expect(calls.length).toBeLessThanOrEqual(4);
  });

  test("serves a month from cache for a minute, then asks again", async () => {
    let now = at("2026-10-09T00:00:00Z");
    const { calls, fetcher } = upstream([
      { data: [bucket("2026-09-01", ["100"])], has_more: false, next_page: null },
      { data: [bucket("2026-09-01", ["900"])], has_more: false, next_page: null },
    ]);
    const report = new CostReport(ADMIN_KEY, fetcher, () => now);
    const [a, b] = await Promise.all([report.month("2026-09"), report.month("2026-09")]);
    expect(calls).toHaveLength(1);
    expect(a.spent_usd).toBe(1);
    expect(b.fetched_at).toBe(a.fetched_at);

    now += 59_000;
    expect((await report.month("2026-09")).spent_usd).toBe(1);
    expect(calls).toHaveLength(1);

    now += 1_000;
    const fresh = await report.month("2026-09");
    expect(calls).toHaveLength(2);
    expect(fresh.spent_usd).toBe(9);
    expect(fresh.fetched_at).toBe(now);
  });

  test("a failure is not cached", async () => {
    const { calls, fetcher } = upstream([
      new Response("{}", { status: 500 }),
      { data: [bucket("2026-09-01", ["100"])], has_more: false, next_page: null },
    ]);
    const report = new CostReport(ADMIN_KEY, fetcher, () => at("2026-10-09T00:00:00Z"));
    await expect(report.month("2026-09")).rejects.toThrow("HTTP 500");
    expect((await report.month("2026-09")).spent_usd).toBe(1);
    expect(calls).toHaveLength(2);
  });

  test("upstream errors become a 502 that never repeats the key or the upstream body", async () => {
    for (const [status, text] of [[401, "認証できません"], [403, "読む権限がありません"], [429, "リクエスト制限"], [500, "HTTP 500"]] as const) {
      const { fetcher } = upstream([
        Response.json({ error: { type: "authentication_error", message: `bad key ${ADMIN_KEY}` } }, { status }),
      ]);
      const err = await new CostReport(ADMIN_KEY, fetcher).month("2026-09").catch((e) => e);
      expect(err).toBeInstanceOf(CostReportError);
      expect(err.status).toBe(502);
      expect(err.message).toContain(text);
      expect(err.message).not.toContain(ADMIN_KEY);
      expect(err.message).not.toContain("bad key");
    }
  });

  test("a network failure is a 502 without the cause", async () => {
    const fetcher = (async () => {
      throw new Error(`connect failed for key ${ADMIN_KEY}`);
    }) as unknown as typeof fetch;
    const err = await new CostReport(ADMIN_KEY, fetcher).month("2026-09").catch((e) => e);
    expect(err).toBeInstanceOf(CostReportError);
    expect(err.status).toBe(502);
    expect(err.message).not.toContain(ADMIN_KEY);
  });

  test("refuses to sum what it cannot read as dollars", async () => {
    const pages = [
      { data: [bucket("2026-09-01", ["100"], "EUR")], has_more: false, next_page: null },
      { data: [bucket("2026-09-01", ["abc"])], has_more: false, next_page: null },
      { data: [{ starting_at: "2026-09-01T00:00:00Z", results: [{ amount: 100, currency: "USD" }] }], has_more: false },
      { data: [{ starting_at: "2026-09-01T00:00:00Z" }], has_more: false },
      { results: [] },
      [],
    ];
    for (const page of pages) {
      const { fetcher } = upstream([page]);
      const err = await new CostReport(ADMIN_KEY, fetcher).month("2026-09").catch((e) => e);
      expect(err).toBeInstanceOf(CostReportError);
      expect(err.status).toBe(502);
    }
  });
});

/**
 * Answers like the real cost report did on 2026-10-09 (Admin API key, #48):
 * only days that have ended in UTC come back, whatever `ending_at` says, and a
 * range that holds no finished day is a 400.
 */
function realReport(now: number, cents: Record<string, string>) {
  const DAY = 86_400_000;
  const calls: URL[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(url);
    const today = Math.floor(now / DAY) * DAY;
    const start = Date.parse(url.searchParams.get("starting_at") ?? "");
    const asked = url.searchParams.get("ending_at");
    const end = Math.min(asked ? Date.parse(asked) : Infinity, today);
    if (!(end > start)) {
      return Response.json(
        { type: "error", error: { type: "invalid_request_error", message: "Invalid date range: ending date must be after starting date" } },
        { status: 400 },
      );
    }
    const limit = Number(url.searchParams.get("limit") ?? 7);
    const data = [];
    for (let t = start; t < end && data.length < limit; t += DAY) {
      const date = new Date(t).toISOString().slice(0, 10);
      data.push(bucket(date, cents[date] ? [cents[date]] : []));
    }
    return Response.json({ data, has_more: false, next_page: null });
  }) as typeof fetch;
  return { calls, fetcher };
}

describe("the report as Anthropic answers it", () => {
  test("the running day is not reported, so a running month stops at yesterday", async () => {
    const now = at("2026-10-09T14:24:00Z");
    const { calls, fetcher } = realReport(now, { "2026-10-08": "40.922816" });
    const m = await new CostReport(ADMIN_KEY, fetcher, () => now).month("2026-10");
    expect(m.today).toBe("2026-10-09");
    expect(m.days.map((d) => d.date)).toEqual([
      "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04",
      "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08",
    ]);
    // Every listed day has a figure; none is waiting on a day that is still running.
    expect(m.days.every((d) => d.cost_usd !== null)).toBe(true);
    expect(m.days.at(-1)?.cost_usd).toBeCloseTo(0.40922816, 10);
    expect(m.spent_usd).toBeCloseTo(0.40922816, 10);
    expect(m.pace_usd).toBeCloseTo((200 / 31) * 8, 10);
    // The 9th is not counted yet, so it is still ahead: 9th to 31st.
    expect(m.days_left).toBe(23);
    // Only finished days are asked for.
    expect(calls).toHaveLength(1);
    expect(calls[0].searchParams.get("starting_at")).toBe("2026-10-01T00:00:00Z");
    expect(calls[0].searchParams.get("ending_at")).toBe("2026-10-09T00:00:00Z");
  });

  test("on the first day of a month nothing has finished: an empty month and no request", async () => {
    const now = at("2026-10-01T03:00:00Z");
    const { calls, fetcher } = realReport(now, {});
    const m = await new CostReport(ADMIN_KEY, fetcher, () => now).month("2026-10");
    expect(calls).toHaveLength(0);
    expect(m).toMatchObject({
      current: true,
      today: "2026-10-01",
      days: [],
      spent_usd: 0,
      remaining_usd: 200,
      pace_usd: 0,
      days_left: 31,
    });
  });

  test("a finished month is unchanged: every day of it", async () => {
    const now = at("2026-10-09T14:24:00Z");
    const { calls, fetcher } = realReport(now, { "2026-09-30": "700" });
    const m = await new CostReport(ADMIN_KEY, fetcher, () => now).month("2026-09");
    expect(m.days).toHaveLength(30);
    expect(m.days.at(-1)).toEqual({ date: "2026-09-30", cost_usd: 7, over: true });
    expect(m.days_left).toBe(0);
    expect(calls[0].searchParams.get("ending_at")).toBe("2026-10-01T00:00:00Z");
  });
});

describe("GET /api/analytics/cost", () => {
  async function setup(adminKey: string | null, pages: (object | Response)[] = []) {
    const env = loadTestEnv({ adminIds: ["admin-1"], anthropicAdminKey: adminKey });
    const store = new MemoryStore();
    await store.migrate();
    for (const [id, role] of [["admin-1", null], ["mod-1", "moderator"], ["free-1", "free"]] as const) {
      await store.upsertUser({ discord_id: id, username: id, avatar: null });
      if (role) await store.setUserRole(id, role);
      await store.putSession(`sess-${id}`, id, `tok-${id}`, Date.now() + 60_000);
    }
    const api = upstream(pages);
    const app = createApp(env, store, {
      guildAccess: async () => true,
      listGuilds: async () => [],
      anthropicFetch: api.fetcher,
      now: () => at("2026-10-09T03:00:00Z"),
    });
    const get = (path: string, session?: string) =>
      app.handle(
        new Request(`http://127.0.0.1${path}`, {
          headers: session ? { cookie: `hibana_session=sess-${session}` } : {},
        }),
      );
    return { get, calls: api.calls };
  }

  const september = { data: [bucket("2026-09-01", ["700"]), bucket("2026-09-02", ["100"])], has_more: false, next_page: null };

  test("only the administrator may read it", async () => {
    const { get, calls } = await setup(ADMIN_KEY, [september]);
    expect((await get("/api/analytics/cost?month=2026-09")).status).toBe(401);
    expect((await get("/api/analytics/cost?month=2026-09", "mod-1")).status).toBe(403);
    expect((await get("/api/analytics/cost?month=2026-09", "free-1")).status).toBe(403);
    expect(calls).toHaveLength(0);

    const res = await get("/api/analytics/cost?month=2026-09", "admin-1");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body).toMatchObject({
      configured: true,
      month: "2026-09",
      current: false,
      monthly_budget_usd: 200,
      days_in_month: 30,
      spent_usd: 8,
      remaining_usd: 192,
    });
    expect(body.days[0]).toEqual({ date: "2026-09-01", cost_usd: 7, over: true });
    expect(body.days[1]).toEqual({ date: "2026-09-02", cost_usd: 1, over: false });
    expect(JSON.stringify(body)).not.toContain(ADMIN_KEY);
  });

  test("/api/me tells the dashboard who may open the page", async () => {
    const { get } = await setup(ADMIN_KEY);
    const flag = async (session: string) => (await (await get("/api/me", session)).json()).can_view_analytics;
    expect(await flag("admin-1")).toBe(true);
    expect(await flag("mod-1")).toBe(false);
    expect(await flag("free-1")).toBe(false);
  });

  test("without a key it reports that it is not set up and calls nothing", async () => {
    const { get, calls } = await setup(null, [september]);
    const res = await get("/api/analytics/cost", "admin-1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ configured: false });
    expect(calls).toHaveLength(0);
  });

  test("defaults to the current UTC month", async () => {
    const { get, calls } = await setup(ADMIN_KEY, [{ data: [bucket("2026-10-08", ["50"])], has_more: false, next_page: null }]);
    const body = await (await get("/api/analytics/cost", "admin-1")).json();
    expect(body).toMatchObject({ month: "2026-10", current: true, today: "2026-10-09", days_left: 23 });
    expect(body.days).toHaveLength(8);
    expect(body.days.at(-1)).toEqual({ date: "2026-10-08", cost_usd: 0.5, over: false });
    expect(calls[0].url.searchParams.get("starting_at")).toBe("2026-10-01T00:00:00Z");
    expect(calls[0].url.searchParams.get("ending_at")).toBe("2026-10-09T00:00:00Z");
  });

  test("rejects a malformed or future month before calling Anthropic", async () => {
    const { get, calls } = await setup(ADMIN_KEY, [september]);
    for (const month of ["2026-11", "202609", "2026-09-01", "next"]) {
      const res = await get(`/api/analytics/cost?month=${month}`, "admin-1");
      expect(res.status).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });

  test("an upstream failure reaches the page as a 502 without the key", async () => {
    const { get } = await setup(ADMIN_KEY, [new Response(`{"error":"${ADMIN_KEY}"}`, { status: 401 })]);
    const res = await get("/api/analytics/cost?month=2026-09", "admin-1");
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).toContain("HTTP 401");
    expect(text).not.toContain(ADMIN_KEY);
  });
});

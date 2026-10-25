import { describe, expect, test } from "bun:test";
import {
  CostReport,
  CostReportError,
  estimate,
  MAX_CALLS_PER_MINUTE,
  MONTHLY_BUDGET_USD,
  parseMonth,
  summarize,
  type UsageRow,
} from "./analytics";
import { createApp } from "./create-app";
import { loadTestEnv } from "./env";
import { MemoryStore } from "./store";

const ADMIN_KEY = "sk-ant-admin01-test-key";
const at = (iso: string) => Date.parse(iso);

/** One daily bucket as the cost report returns it; amounts are cents as decimal strings. */
function bucket(date: string, amounts: string[], currency = "USD") {
  const end = new Date(at(`${date}T00:00:00Z`) + 86_400_000)
    .toISOString()
    .slice(0, 10);
  return {
    starting_at: `${date}T00:00:00Z`,
    ending_at: `${end}T00:00:00Z`,
    results: amounts.map((amount) => ({
      amount,
      currency,
      description: null,
      workspace_id: null,
    })),
  };
}

/** Fake Admin API: answers each call with the next page and records what was asked. */
function upstream(pages: (object | Response)[]) {
  const calls: { url: URL; headers: Headers }[] = [];
  const fetcher = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    calls.push({
      url: new URL(String(input)),
      headers: new Headers(init?.headers),
    });
    const page = pages[Math.min(calls.length, pages.length) - 1];
    return page instanceof Response ? page.clone() : Response.json(page);
  }) as typeof fetch;
  return { calls, fetcher };
}

describe("summarize", () => {
  test("the daily guideline is the budget over the billing month's days", () => {
    const now = at("2027-01-01T00:00:00Z");
    expect(MONTHLY_BUDGET_USD).toBe(200);
    expect(
      summarize("2026-10", new Map(), now, now).daily_guideline_usd,
    ).toBeCloseTo(200 / 31, 10);
    expect(
      summarize("2026-09", new Map(), now, now).daily_guideline_usd,
    ).toBeCloseTo(200 / 30, 10);
    expect(summarize("2026-02", new Map(), now, now).days_in_month).toBe(28);
    expect(summarize("2024-02", new Map(), now, now).days_in_month).toBe(29);
    expect(summarize("2026-12", new Map(), now, now).days_in_month).toBe(31);
  });

  test("a day is over only when it is strictly above the guideline", () => {
    const now = at("2026-10-05T00:00:00Z");
    const guideline = 200 / 30;
    const costs = new Map([
      ["2026-09-05", guideline],
      ["2026-09-06", guideline + 0.01],
      ["2026-09-07", 0],
    ]);
    const { days } = summarize("2026-09", costs, now, now);
    expect(days.slice(0, 3).map((d) => d.over)).toEqual([false, true, false]);
  });

  test("a running month lists the days that have ended and what is left of the budget", () => {
    const now = at("2026-10-09T03:00:00Z");
    const costs = new Map([
      // The 4th is the last day of the billing month before; it is not counted here.
      ["2026-10-04", 99],
      ["2026-10-05", 10],
      ["2026-10-06", 2.5],
      ["2026-10-08", 1.25],
    ]);
    const m = summarize("2026-10", costs, now, now);
    expect(m.current).toBe(true);
    expect(m.today).toBe("2026-10-09");
    expect(m.days.map((d) => d.date)).toEqual([
      "2026-10-05",
      "2026-10-06",
      "2026-10-07",
      "2026-10-08",
    ]);
    expect(m.spent_usd).toBeCloseTo(13.75, 10);
    expect(m.remaining_usd).toBeCloseTo(186.25, 10);
    expect(m.pace_usd).toBeCloseTo((200 / 31) * 4, 10);
    // 9 October through 4 November: today is still ahead, since it has no figure yet.
    expect(m.days_left).toBe(27);
  });

  test("the 1st to the 4th belong to the billing month that began on the 5th before", () => {
    const now = at("2026-11-03T03:00:00Z");
    const costs = new Map([
      ["2026-10-05", 1],
      ["2026-11-01", 2],
      ["2026-11-02", 4],
    ]);
    const m = summarize("2026-10", costs, now, now);
    expect(m.current).toBe(true);
    expect(m.days_in_month).toBe(31);
    expect(m.days).toHaveLength(29);
    expect(m.days[0].date).toBe("2026-10-05");
    expect(m.days.at(-1)?.date).toBe("2026-11-02");
    expect(m.spent_usd).toBeCloseTo(7, 10);
    // 3 and 4 November.
    expect(m.days_left).toBe(2);
  });

  test("a billing month that starts in December ends on 4 January", () => {
    const now = at("2027-01-05T00:00:00Z");
    const m = summarize("2026-12", new Map([["2027-01-04", 3]]), now, now);
    expect(m.current).toBe(false);
    expect(m.days).toHaveLength(31);
    expect(m.days[0].date).toBe("2026-12-05");
    expect(m.days.at(-1)).toEqual({
      date: "2027-01-04",
      cost_usd: 3,
      over: false,
    });
  });

  test("a day the report did not return is unknown, not zero", () => {
    const now = at("2026-10-07T12:00:00Z");
    const m = summarize("2026-10", new Map([["2026-10-05", 0]]), now, now);
    expect(m.days).toEqual([
      { date: "2026-10-05", cost_usd: 0, over: false },
      { date: "2026-10-06", cost_usd: null, over: false },
    ]);
  });

  test("a past month is complete and can end over budget", () => {
    const now = at("2026-10-09T00:00:00Z");
    // 5 September to 4 October.
    const first = at("2026-09-05T00:00:00Z");
    const costs = new Map(
      Array.from(
        { length: 30 },
        (_, i) =>
          [
            new Date(first + i * 86_400_000).toISOString().slice(0, 10),
            7,
          ] as const,
      ),
    );
    const m = summarize("2026-09", costs, now, now);
    expect(m.current).toBe(false);
    expect(m.days).toHaveLength(30);
    expect(m.days.at(-1)?.date).toBe("2026-10-04");
    expect(m.days.every((d) => d.over)).toBe(true);
    expect(m.spent_usd).toBeCloseTo(210, 10);
    expect(m.remaining_usd).toBeCloseTo(-10, 10);
    expect(m.pace_usd).toBeCloseTo(200, 10);
    expect(m.days_left).toBe(0);
  });
});

describe("parseMonth", () => {
  const now = at("2026-10-09T03:00:00Z");
  test("defaults to the current billing month, which starts on the 5th in UTC", () => {
    expect(parseMonth(undefined, now)).toBe("2026-10");
    expect(parseMonth("", now)).toBe("2026-10");
    // 08:59 JST on the 5th is still the 4th in UTC: the billing month before.
    expect(parseMonth(undefined, at("2026-10-04T23:59:59Z"))).toBe("2026-09");
    expect(parseMonth(undefined, at("2026-10-05T00:00:00Z"))).toBe("2026-10");
    expect(parseMonth(undefined, at("2027-01-03T00:00:00Z"))).toBe("2026-12");
  });
  test("a month whose 5th has not come yet has not started", () => {
    const fourth = at("2026-10-04T12:00:00Z");
    expect(parseMonth("2026-10", fourth)).toBeNull();
    expect(parseMonth("2026-09", fourth)).toBe("2026-09");
  });
  test("accepts a past or current month and nothing else", () => {
    expect(parseMonth("2026-10", now)).toBe("2026-10");
    expect(parseMonth("2025-12", now)).toBe("2025-12");
    for (const bad of [
      "2026-11",
      "2027-01",
      "2026-13",
      "2026-00",
      "2026-1",
      "26-10",
      "2026-10-01",
      "2026-10&limit=1",
    ])
      expect(parseMonth(bad, now)).toBeNull();
  });
});

describe("CostReport", () => {
  test("asks for a closed month and converts cents to dollars", async () => {
    const { calls, fetcher } = upstream([
      {
        data: [
          bucket("2026-09-05", ["123.45"]),
          // Grouped reports return several items for a day; they add up.
          bucket("2026-09-06", ["1000", "250.5"]),
          bucket("2026-09-07", []),
          // Not part of the billing month that was asked for: the day before it and the day after.
          bucket("2026-09-04", ["99999"]),
          bucket("2026-10-05", ["99999"]),
        ],
        has_more: false,
        next_page: null,
      },
    ]);
    const report = new CostReport(ADMIN_KEY, fetcher, () =>
      at("2026-10-09T00:00:00Z"),
    );
    const m = await report.month("2026-09");

    expect(calls).toHaveLength(1);
    const { url, headers } = calls[0];
    expect(url.origin + url.pathname).toBe(
      "https://api.anthropic.com/v1/organizations/cost_report",
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      starting_at: "2026-09-05T00:00:00Z",
      ending_at: "2026-10-05T00:00:00Z",
      bucket_width: "1d",
      limit: "31",
    });
    expect(headers.get("x-api-key")).toBe(ADMIN_KEY);
    expect(headers.get("anthropic-version")).toBe("2023-06-01");

    expect(m.days[0]).toEqual({
      date: "2026-09-05",
      cost_usd: 1.2345,
      over: false,
    });
    expect(m.days[1]).toEqual({
      date: "2026-09-06",
      cost_usd: 12.505,
      over: true,
    });
    expect(m.days[2]).toEqual({ date: "2026-09-07", cost_usd: 0, over: false });
    expect(m.days[3].cost_usd).toBeNull();
    expect(m.spent_usd).toBeCloseTo(13.7395, 10);
  });

  test("December's billing month ends at the next year's 5 January", async () => {
    const { calls, fetcher } = upstream([
      { data: [], has_more: false, next_page: null },
    ]);
    await new CostReport(ADMIN_KEY, fetcher, () =>
      at("2026-10-09T00:00:00Z"),
    ).month("2025-12");
    expect(calls[0].url.searchParams.get("starting_at")).toBe(
      "2025-12-05T00:00:00Z",
    );
    expect(calls[0].url.searchParams.get("ending_at")).toBe(
      "2026-01-05T00:00:00Z",
    );
  });

  test("follows next_page until the report is complete", async () => {
    const { calls, fetcher } = upstream([
      {
        data: [bucket("2026-09-05", ["100"])],
        has_more: true,
        next_page: "page_2",
      },
      {
        data: [bucket("2026-09-06", ["200"])],
        has_more: false,
        next_page: null,
      },
    ]);
    const m = await new CostReport(ADMIN_KEY, fetcher, () =>
      at("2026-10-09T00:00:00Z"),
    ).month("2026-09");
    expect(calls.map((c) => c.url.searchParams.get("page"))).toEqual([
      null,
      "page_2",
    ]);
    expect(m.spent_usd).toBeCloseTo(3, 10);
  });

  test("a report that never ends is an error, not an endless loop", async () => {
    const { calls, fetcher } = upstream([
      { data: [], has_more: true, next_page: "again" },
    ]);
    const report = new CostReport(ADMIN_KEY, fetcher, () =>
      at("2026-10-09T00:00:00Z"),
    );
    await expect(report.month("2026-09")).rejects.toBeInstanceOf(
      CostReportError,
    );
    expect(calls.length).toBeLessThanOrEqual(4);
  });

  test("serves a month from cache for a minute, then asks again", async () => {
    let now = at("2026-10-09T00:00:00Z");
    const { calls, fetcher } = upstream([
      {
        data: [bucket("2026-09-05", ["100"])],
        has_more: false,
        next_page: null,
      },
      {
        data: [bucket("2026-09-05", ["900"])],
        has_more: false,
        next_page: null,
      },
    ]);
    const report = new CostReport(ADMIN_KEY, fetcher, () => now);
    const [a, b] = await Promise.all([
      report.month("2026-09"),
      report.month("2026-09"),
    ]);
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
      {
        data: [bucket("2026-09-05", ["100"])],
        has_more: false,
        next_page: null,
      },
    ]);
    const report = new CostReport(ADMIN_KEY, fetcher, () =>
      at("2026-10-09T00:00:00Z"),
    );
    await expect(report.month("2026-09")).rejects.toThrow("HTTP 500");
    expect((await report.month("2026-09")).spent_usd).toBe(1);
    expect(calls).toHaveLength(2);
  });

  test("upstream errors become a 502 that never repeats the key or the upstream body", async () => {
    for (const [status, text] of [
      [401, "認証できません"],
      [403, "読む権限がありません"],
      [429, "リクエスト制限"],
      [500, "HTTP 500"],
    ] as const) {
      const { fetcher } = upstream([
        Response.json(
          {
            error: {
              type: "authentication_error",
              message: `bad key ${ADMIN_KEY}`,
            },
          },
          { status },
        ),
      ]);
      const err = await new CostReport(ADMIN_KEY, fetcher)
        .month("2026-09")
        .catch((e) => e);
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
    const err = await new CostReport(ADMIN_KEY, fetcher)
      .month("2026-09")
      .catch((e) => e);
    expect(err).toBeInstanceOf(CostReportError);
    expect(err.status).toBe(502);
    expect(err.message).not.toContain(ADMIN_KEY);
  });

  test("refuses to sum what it cannot read as dollars", async () => {
    const pages = [
      {
        data: [bucket("2026-09-05", ["100"], "EUR")],
        has_more: false,
        next_page: null,
      },
      {
        data: [bucket("2026-09-05", ["abc"])],
        has_more: false,
        next_page: null,
      },
      {
        data: [
          {
            starting_at: "2026-09-05T00:00:00Z",
            results: [{ amount: 100, currency: "USD" }],
          },
        ],
        has_more: false,
      },
      { data: [{ starting_at: "2026-09-05T00:00:00Z" }], has_more: false },
      { results: [] },
      [],
    ];
    for (const page of pages) {
      const { fetcher } = upstream([page]);
      const err = await new CostReport(ADMIN_KEY, fetcher)
        .month("2026-09")
        .catch((e) => e);
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
        {
          type: "error",
          error: {
            type: "invalid_request_error",
            message:
              "Invalid date range: ending date must be after starting date",
          },
        },
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
    const m = await new CostReport(ADMIN_KEY, fetcher, () => now).month(
      "2026-10",
    );
    expect(m.today).toBe("2026-10-09");
    expect(m.days.map((d) => d.date)).toEqual([
      "2026-10-05",
      "2026-10-06",
      "2026-10-07",
      "2026-10-08",
    ]);
    // Every listed day has a figure; none is waiting on a day that is still running.
    expect(m.days.every((d) => d.cost_usd !== null)).toBe(true);
    expect(m.days.at(-1)?.cost_usd).toBeCloseTo(0.40922816, 10);
    expect(m.spent_usd).toBeCloseTo(0.40922816, 10);
    expect(m.pace_usd).toBeCloseTo((200 / 31) * 4, 10);
    // The 9th is not counted yet, so it is still ahead: 9 October to 4 November.
    expect(m.days_left).toBe(27);
    // Only finished days are asked for.
    expect(calls).toHaveLength(1);
    expect(calls[0].searchParams.get("starting_at")).toBe(
      "2026-10-05T00:00:00Z",
    );
    expect(calls[0].searchParams.get("ending_at")).toBe("2026-10-09T00:00:00Z");
  });

  test("on the first day of a billing month nothing has finished: an empty month and no request", async () => {
    const now = at("2026-10-05T03:00:00Z");
    const { calls, fetcher } = realReport(now, {});
    const m = await new CostReport(ADMIN_KEY, fetcher, () => now).month(
      "2026-10",
    );
    expect(calls).toHaveLength(0);
    expect(m).toMatchObject({
      current: true,
      today: "2026-10-05",
      days: [],
      spent_usd: 0,
      remaining_usd: 200,
      pace_usd: 0,
      days_left: 31,
    });
  });

  test("a finished month is unchanged: every day of it", async () => {
    const now = at("2026-10-09T14:24:00Z");
    const { calls, fetcher } = realReport(now, { "2026-10-04": "700" });
    const m = await new CostReport(ADMIN_KEY, fetcher, () => now).month(
      "2026-09",
    );
    expect(m.days).toHaveLength(30);
    expect(m.days.at(-1)).toEqual({
      date: "2026-10-04",
      cost_usd: 7,
      over: true,
    });
    expect(m.days_left).toBe(0);
    expect(calls[0].searchParams.get("starting_at")).toBe(
      "2026-09-05T00:00:00Z",
    );
    expect(calls[0].searchParams.get("ending_at")).toBe("2026-10-05T00:00:00Z");
  });

  test("early in a calendar month the running billing month reaches back to the 5th before", async () => {
    const now = at("2026-11-03T10:00:00Z");
    const { calls, fetcher } = realReport(now, {
      "2026-10-31": "100",
      "2026-11-02": "250",
    });
    const m = await new CostReport(ADMIN_KEY, fetcher, () => now).month(
      "2026-10",
    );
    expect(m.current).toBe(true);
    expect(m.days).toHaveLength(29);
    expect(m.days.every((d) => d.cost_usd !== null)).toBe(true);
    expect(m.spent_usd).toBeCloseTo(3.5, 10);
    expect(calls).toHaveLength(1);
    expect(calls[0].searchParams.get("starting_at")).toBe(
      "2026-10-05T00:00:00Z",
    );
    expect(calls[0].searchParams.get("ending_at")).toBe("2026-11-03T00:00:00Z");
  });
});

describe("GET /api/analytics/cost", () => {
  async function setup(
    adminKey: string | null,
    pages: (object | Response)[] = [],
  ) {
    const env = loadTestEnv({
      adminIds: ["admin-1"],
      anthropicAdminKey: adminKey,
    });
    const store = new MemoryStore();
    await store.migrate();
    for (const [id, role] of [
      ["admin-1", null],
      ["mod-1", "moderator"],
      ["free-1", "free"],
    ] as const) {
      await store.upsertUser({ discord_id: id, username: id, avatar: null });
      if (role) await store.setUserRole(id, role);
      await store.putSession(
        `sess-${id}`,
        id,
        `tok-${id}`,
        Date.now() + 60_000,
      );
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
          headers: session
            ? { cookie: `__Host-hibana_session=sess-${session}` }
            : {},
        }),
      );
    return { get, calls: api.calls };
  }

  const september = {
    data: [bucket("2026-09-05", ["700"]), bucket("2026-09-06", ["100"])],
    has_more: false,
    next_page: null,
  };

  test("every logged-in user may read it (#85), and no one else", async () => {
    const { get, calls } = await setup(ADMIN_KEY, [september]);
    expect((await get("/api/analytics/cost?month=2026-09")).status).toBe(401);
    expect(calls).toHaveLength(0);
    for (const user of ["mod-1", "free-1"]) {
      const res = await get("/api/analytics/cost?month=2026-09", user);
      expect(res.status).toBe(200);
      expect((await res.json()).spent_usd).toBe(8);
    }
    // The three readers shared one request: the month is cached for a minute.
    expect(calls).toHaveLength(1);

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
    expect(body.days[0]).toEqual({
      date: "2026-09-05",
      cost_usd: 7,
      over: true,
    });
    expect(body.days[1]).toEqual({
      date: "2026-09-06",
      cost_usd: 1,
      over: false,
    });
    expect(JSON.stringify(body)).not.toContain(ADMIN_KEY);
  });

  test("/api/me tells the dashboard who may open the page", async () => {
    const { get } = await setup(ADMIN_KEY);
    const flag = async (session: string) =>
      (await (await get("/api/me", session)).json()).can_view_analytics;
    expect(await flag("admin-1")).toBe(true);
    expect(await flag("mod-1")).toBe(true);
    expect(await flag("free-1")).toBe(true);
  });

  test("without a key it reports that it is not set up and calls nothing", async () => {
    const { get, calls } = await setup(null, [september]);
    const res = await get("/api/analytics/cost", "admin-1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ configured: false });
    expect(calls).toHaveLength(0);
  });

  test("defaults to the current billing month", async () => {
    const { get, calls } = await setup(ADMIN_KEY, [
      {
        data: [bucket("2026-10-08", ["50"])],
        has_more: false,
        next_page: null,
      },
    ]);
    const body = await (await get("/api/analytics/cost", "admin-1")).json();
    expect(body).toMatchObject({
      month: "2026-10",
      current: true,
      today: "2026-10-09",
      days_left: 27,
    });
    expect(body.days).toHaveLength(4);
    expect(body.days.at(-1)).toEqual({
      date: "2026-10-08",
      cost_usd: 0.5,
      over: false,
    });
    expect(calls[0].url.searchParams.get("starting_at")).toBe(
      "2026-10-05T00:00:00Z",
    );
    expect(calls[0].url.searchParams.get("ending_at")).toBe(
      "2026-10-09T00:00:00Z",
    );
  });

  test("rejects a malformed or future month before calling Anthropic", async () => {
    const { get, calls } = await setup(ADMIN_KEY, [september]);
    for (const month of ["2026-11", "202609", "2026-09-05", "next"]) {
      const res = await get(`/api/analytics/cost?month=${month}`, "admin-1");
      expect(res.status).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });

  test("an upstream failure reaches the page as a 502 without the key", async () => {
    const { get } = await setup(ADMIN_KEY, [
      new Response(`{"error":"${ADMIN_KEY}"}`, { status: 401 }),
    ]);
    const res = await get("/api/analytics/cost?month=2026-09", "admin-1");
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).toContain("HTTP 401");
    expect(text).not.toContain(ADMIN_KEY);
  });

  test("today's estimate: any logged-in user, from the usage report, never cached by the browser", async () => {
    const page = {
      data: [
        minute("2026-10-09T01:00:00Z", [
          usage({ model: "claude-opus-5-5", uncached_input_tokens: 1_000_000 }),
        ]),
      ],
      has_more: false,
      next_page: null,
    };
    const { get, calls } = await setup(ADMIN_KEY, [page]);
    expect((await get("/api/analytics/today")).status).toBe(401);
    expect(calls).toHaveLength(0);
    const res = await get("/api/analytics/today", "free-1");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body).toMatchObject({
      configured: true,
      date: "2026-10-09",
      cost_usd: 4,
      unpriced: [],
    });
    expect(JSON.stringify(body)).not.toContain(ADMIN_KEY);
    expect(calls[0].url.pathname).toBe(
      "/v1/organizations/usage_report/messages",
    );
  });

  test("today's estimate without a key reports that it is not set up and calls nothing", async () => {
    const { get, calls } = await setup(null);
    expect(await (await get("/api/analytics/today", "free-1")).json()).toEqual({
      configured: false,
    });
    expect(calls).toHaveLength(0);
  });
});

/** One result of the usage report as Anthropic documents it, grouped by model, tier, geo and context window. */
function usage(over: Record<string, unknown> = {}) {
  return {
    account_id: null,
    api_key_id: null,
    service_account_id: null,
    workspace_id: null,
    model: "claude-opus-5-5",
    service_tier: "standard",
    inference_geo: "global",
    context_window: "0-200k",
    uncached_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
    cache_creation: {
      ephemeral_5m_input_tokens: 0,
      ephemeral_1h_input_tokens: 0,
    },
    server_tool_use: { web_search_requests: 0 },
    ...over,
  };
}

/** One 1-minute bucket of the usage report. */
function minute(start: string, results: object[] = []) {
  const end = new Date(at(start) + 60_000).toISOString().replace(".000Z", "Z");
  return { starting_at: start, ending_at: end, results };
}

const row = (over: Partial<UsageRow> = {}): UsageRow => ({
  model: "claude-opus-5-5",
  service_tier: "standard",
  inference_geo: "global",
  context_window: "0-200k",
  uncached_input_tokens: 0,
  cache_read_input_tokens: 0,
  cache_write_5m_tokens: 0,
  cache_write_1h_tokens: 0,
  output_tokens: 0,
  web_search_requests: 0,
  ...over,
});

describe("estimate", () => {
  // Expected figures are the pricing page's (read 2026-10-15), not the code's own table.
  const M = 1_000_000;
  const opus = {
    uncached_input_tokens: M,
    cache_write_5m_tokens: M,
    cache_write_1h_tokens: M,
    cache_read_input_tokens: M,
    output_tokens: M,
  };

  test("prices each kind of token at the pricing page's rate", () => {
    expect(estimate([row({ uncached_input_tokens: M })]).cost_usd).toBeCloseTo(
      4,
      10,
    );
    expect(estimate([row({ cache_write_5m_tokens: M })]).cost_usd).toBeCloseTo(
      5,
      10,
    );
    expect(estimate([row({ cache_write_1h_tokens: M })]).cost_usd).toBeCloseTo(
      8,
      10,
    );
    expect(
      estimate([row({ cache_read_input_tokens: M })]).cost_usd,
    ).toBeCloseTo(0.2, 10);
    expect(estimate([row({ output_tokens: M })]).cost_usd).toBeCloseTo(20, 10);
    expect(
      estimate([row({ model: "claude-sonnet-5-5", output_tokens: M })])
        .cost_usd,
    ).toBeCloseTo(10, 10);
    expect(estimate([row(opus), row(opus)]).cost_usd).toBeCloseTo(2 * 37.2, 10);
  });

  test("Batch halves the price and US-only inference adds a tenth, together as well", () => {
    expect(
      estimate([row({ ...opus, service_tier: "batch" })]).cost_usd,
    ).toBeCloseTo(18.6, 10);
    expect(
      estimate([row({ ...opus, inference_geo: "us" })]).cost_usd,
    ).toBeCloseTo(40.92, 10);
    expect(
      estimate([row({ ...opus, service_tier: "batch", inference_geo: "us" })])
        .cost_usd,
    ).toBeCloseTo(20.46, 10);
  });

  test("Haiku 5.5 takes its higher row only where the report says the prompt was over 200k", () => {
    const haiku = {
      model: "claude-haiku-5-5",
      uncached_input_tokens: M,
      output_tokens: M,
    };
    expect(
      estimate([row({ ...haiku, context_window: "200k-1M" })]).cost_usd,
    ).toBeCloseTo(3, 10);
    expect(
      estimate([row({ ...haiku, context_window: "0-200k" })]).cost_usd,
    ).toBeCloseTo(0.6, 10);
  });

  test("web searches are charged whatever the model", () => {
    expect(estimate([row({ web_search_requests: 10 })]).cost_usd).toBeCloseTo(
      0.1,
      10,
    );
    expect(
      estimate([row({ model: "claude-unknown", web_search_requests: 10 })])
        .cost_usd,
    ).toBeCloseTo(0.1, 10);
  });

  test("usage it cannot price is listed instead of guessed, largest first", () => {
    const { cost_usd, unpriced } = estimate([
      row({
        model: "claude-opus-5-6",
        output_tokens: 600,
        uncached_input_tokens: 400,
      }),
      row({ service_tier: "priority", output_tokens: 2000 }),
      row({ model: "claude-opus-5-6", output_tokens: 500 }),
      // A name that would otherwise reach Object.prototype.
      row({ model: "constructor", output_tokens: 10 }),
      row({ model: null, output_tokens: 0 }),
    ]);
    expect(cost_usd).toBe(0);
    expect(unpriced).toEqual([
      { model: "claude-opus-5-5", service_tier: "priority", tokens: 2000 },
      { model: "claude-opus-5-6", service_tier: "standard", tokens: 1500 },
      { model: "constructor", service_tier: "standard", tokens: 10 },
    ]);
  });
});

describe("CostReport.today", () => {
  test("asks for today's whole minutes and prices them", async () => {
    const now = at("2026-10-15T07:42:30Z");
    const { calls, fetcher } = upstream([
      {
        data: [
          minute("2026-10-15T00:00:00Z", [
            usage({ uncached_input_tokens: 1_000_000 }),
          ]),
          minute("2026-10-15T07:40:00Z", [
            usage({ model: "claude-sonnet-5-5", output_tokens: 100_000 }),
          ]),
          minute("2026-10-15T07:41:00Z"),
        ],
        has_more: false,
        next_page: null,
      },
    ]);
    const t = await new CostReport(ADMIN_KEY, fetcher, () => now).today();

    expect(calls).toHaveLength(1);
    const { url, headers } = calls[0];
    expect(url.origin + url.pathname).toBe(
      "https://api.anthropic.com/v1/organizations/usage_report/messages",
    );
    expect(url.searchParams.get("starting_at")).toBe("2026-10-15T00:00:00Z");
    expect(url.searchParams.get("ending_at")).toBe("2026-10-15T07:42:00Z");
    expect(url.searchParams.get("bucket_width")).toBe("1m");
    expect(url.searchParams.get("limit")).toBe("1440");
    expect(url.searchParams.getAll("group_by[]")).toEqual([
      "model",
      "service_tier",
      "inference_geo",
      "context_window",
    ]);
    expect(headers.get("x-api-key")).toBe(ADMIN_KEY);

    expect(t).toEqual({
      configured: true,
      date: "2026-10-15",
      through: "2026-10-15T07:42:00Z",
      last_usage_at: "2026-10-15T07:41:00Z",
      cost_usd: 5,
      daily_guideline_usd: 200 / 31,
      over: false,
      unpriced: [],
      fetched_at: now,
    });
  });

  test("the guideline is the billing month's, and spend above it is over", async () => {
    // 2 December is in the billing month that started on 5 November: 30 days.
    const now = at("2026-12-02T10:00:00Z");
    const { fetcher } = upstream([
      {
        data: [
          minute("2026-12-02T09:00:00Z", [usage({ output_tokens: 400_000 })]),
        ],
        has_more: false,
        next_page: null,
      },
    ]);
    const t = await new CostReport(ADMIN_KEY, fetcher, () => now).today();
    expect(t.daily_guideline_usd).toBeCloseTo(200 / 30, 10);
    expect(t.cost_usd).toBeCloseTo(8, 10);
    expect(t.over).toBe(true);
  });

  test("in the first minute of a day nothing has finished: zero and no request", async () => {
    const { calls, fetcher } = upstream([]);
    const t = await new CostReport(ADMIN_KEY, fetcher, () =>
      at("2026-10-15T00:00:40Z"),
    ).today();
    expect(calls).toHaveLength(0);
    expect(t).toMatchObject({
      date: "2026-10-15",
      through: "2026-10-15T00:00:00Z",
      last_usage_at: null,
      cost_usd: 0,
    });
  });

  test("serves today from cache for a minute, but never yesterday's figure after midnight", async () => {
    let now = at("2026-10-15T23:58:30Z");
    const { calls, fetcher } = upstream([
      {
        data: [
          minute("2026-10-15T10:00:00Z", [
            usage({ uncached_input_tokens: 1_000_000 }),
          ]),
        ],
        has_more: false,
        next_page: null,
      },
      {
        data: [
          minute("2026-10-15T10:00:00Z", [
            usage({ uncached_input_tokens: 2_000_000 }),
          ]),
        ],
        has_more: false,
        next_page: null,
      },
    ]);
    const report = new CostReport(ADMIN_KEY, fetcher, () => now);
    const [a, b] = await Promise.all([report.today(), report.today()]);
    expect(calls).toHaveLength(1);
    expect(a.cost_usd).toBe(4);
    expect(b.fetched_at).toBe(a.fetched_at);

    now += 59_000;
    expect((await report.today()).cost_usd).toBe(4);
    expect(calls).toHaveLength(1);

    now += 1_000;
    expect((await report.today()).cost_usd).toBe(8);
    expect(calls).toHaveLength(2);

    // 16 October, 00:00:30: a new day, inside the cached minute.
    now = at("2026-10-16T00:00:30Z");
    const next = await report.today();
    expect(next).toMatchObject({
      date: "2026-10-16",
      cost_usd: 0,
      last_usage_at: null,
    });
    expect(calls).toHaveLength(2);
  });

  test("follows next_page, and a failure is not cached", async () => {
    const { calls, fetcher } = upstream([
      new Response("{}", { status: 500 }),
      {
        data: [
          minute("2026-10-15T01:00:00Z", [
            usage({ uncached_input_tokens: 1_000_000 }),
          ]),
        ],
        has_more: true,
        next_page: "page_2",
      },
      {
        data: [
          minute("2026-10-15T02:00:00Z", [
            usage({ uncached_input_tokens: 1_000_000 }),
          ]),
        ],
        has_more: false,
        next_page: null,
      },
    ]);
    const report = new CostReport(ADMIN_KEY, fetcher, () =>
      at("2026-10-15T07:00:00Z"),
    );
    const err = await report.today().catch((e) => e);
    expect(err).toBeInstanceOf(CostReportError);
    expect(err.message).toContain("usage report");
    expect(err.message).toContain("HTTP 500");
    const t = await report.today();
    expect(t.cost_usd).toBe(8);
    expect(t.last_usage_at).toBe("2026-10-15T02:01:00Z");
    expect(calls.map((c) => c.url.searchParams.get("page"))).toEqual([
      null,
      null,
      "page_2",
    ]);
  });

  test("a report of an unexpected shape is a 502, not a wrong figure", async () => {
    for (const result of [
      usage({ output_tokens: "12" }),
      usage({ uncached_input_tokens: -1 }),
      usage({ model: 5 }),
      usage({ cache_creation: { ephemeral_5m_input_tokens: "7" } }),
      usage({ server_tool_use: "none" }),
      null,
    ]) {
      const { fetcher } = upstream([
        {
          data: [minute("2026-10-15T01:00:00Z", [result as object])],
          has_more: false,
          next_page: null,
        },
      ]);
      const err = await new CostReport(ADMIN_KEY, fetcher, () =>
        at("2026-10-15T07:00:00Z"),
      )
        .today()
        .catch((e) => e);
      expect(err).toBeInstanceOf(CostReportError);
      expect(err.status).toBe(502);
      expect(err.message).toContain("usage report");
    }
  });
});

describe("the cap on requests to Anthropic", () => {
  test("months and today share it; beyond it, a 429 without calling Anthropic, until a minute has passed", async () => {
    let now = at("2026-10-15T07:00:00Z");
    const { calls, fetcher } = upstream([
      { data: [], has_more: false, next_page: null },
    ]);
    const report = new CostReport(ADMIN_KEY, fetcher, () => now);
    // Each month a request of its own, as someone walking back through the months would cause.
    for (let i = 1; i < MAX_CALLS_PER_MINUTE; i++)
      await report.month(`2025-${String(i).padStart(2, "0")}`);
    await report.today();
    expect(calls).toHaveLength(MAX_CALLS_PER_MINUTE);

    const err = await report.month("2024-01").catch((e) => e);
    expect(err).toBeInstanceOf(CostReportError);
    expect(err.status).toBe(429);
    expect(calls).toHaveLength(MAX_CALLS_PER_MINUTE);
    // What is cached is still served.
    expect((await report.month("2025-01")).month).toBe("2025-01");

    now += 60_000;
    expect((await report.month("2024-01")).month).toBe("2024-01");
    expect(calls).toHaveLength(MAX_CALLS_PER_MINUTE + 1);
  });
});

import { expect, test, type Page } from "@playwright/test";

// The page only renders what GET /api/analytics/cost returns; the arithmetic is
// tested with the API (apps/api/src/analytics.test.ts). These fixtures follow
// that response shape so the labels can be checked against known numbers.
const BUDGET = 200;

// A billing month runs from the 5th to the 4th of the next month (#81), so
// the first cost is the 5th's.
function monthFixture(
  month: string,
  daysInMonth: number,
  costs: (number | null)[],
  current: boolean,
) {
  const guideline = BUDGET / daysInMonth;
  const first = Date.parse(`${month}-05T00:00:00Z`);
  const days = costs.map((cost, i) => ({
    date: new Date(first + i * 86_400_000).toISOString().slice(0, 10),
    cost_usd: cost,
    over: cost !== null && cost > guideline,
  }));
  const spent = costs.reduce<number>((sum, cost) => sum + (cost ?? 0), 0);
  return {
    configured: true,
    month,
    current,
    today: "2026-10-13",
    monthly_budget_usd: BUDGET,
    days_in_month: daysInMonth,
    daily_guideline_usd: guideline,
    days,
    spent_usd: spent,
    remaining_usd: BUDGET - spent,
    pace_usd: guideline * days.length,
    days_left: current ? daysInMonth - days.length : 0,
    fetched_at: Date.parse("2026-10-13T03:00:00Z"),
  };
}

// The cost report only has days that have ended, so on 13 October the billing
// month runs from the 5th to the 12th: three days above $6.45, five at or below it.
const october = monthFixture(
  "2026-10",
  31,
  [4.2, 7.9, 6.1, 0, 12.34, 3.3, 6.45, 8],
  true,
);
// The first day of a billing month (the 5th): nothing has ended yet.
const firstDay = monthFixture("2026-10", 31, [], true);
// A finished billing month (5 September to 4 October) that ran over the budget: 30 days at $3–$11.
const september = monthFixture(
  "2026-09",
  30,
  Array.from({ length: 30 }, (_, i) => 3 + ((i * 7) % 9)),
  false,
);

// Today's estimate (#85) on 13 October at 03:00 UTC: below the $6.45 guideline.
const todayFixture = {
  configured: true,
  date: "2026-10-13",
  through: "2026-10-13T02:59:00Z",
  last_usage_at: "2026-10-13T02:57:00Z",
  cost_usd: 3.21,
  daily_guideline_usd: BUDGET / 31,
  over: false,
  unpriced: [],
  fetched_at: Date.parse("2026-10-13T03:00:00Z"),
};

type CostReply = { status?: number; json: unknown };

// The budget fallback (#89): $151.71 left, $3.21 today, so not switched.
const budgetFixture = (over: Record<string, unknown> = {}) => ({
  fallback: { preset: "anthropic-haiku-5-5", effort: "high" },
  threshold_usd: 10,
  threshold_range: { min_usd: 0, max_usd: 200, default_usd: 10 },
  presets: [
    {
      id: "anthropic-haiku-5-5",
      label: "Anthropic / Claude Haiku 5.5",
      published: true,
    },
    {
      id: "anthropic-sonnet-5-5",
      label: "Anthropic / Claude Sonnet 5.5",
      published: true,
    },
    {
      id: "anthropic-opus-5-5",
      label: "Anthropic / Claude Opus 5.5",
      published: true,
    },
    {
      id: "anthropic-opus-5-6",
      label: "Anthropic / Claude Opus 5.6",
      published: false,
    },
  ],
  efforts: ["low", "medium", "high", "xhigh", "max"],
  can_edit: true,
  status: {
    configured: true,
    month: "2026-10",
    remaining_usd: 151.71,
    today_usd: 3.21,
    remaining_after_today_usd: 148.5,
    threshold_usd: 10,
    low: false,
    fetched_at: Date.parse("2026-10-13T03:00:00Z"),
  },
  ...over,
});

type MockOptions = {
  canView?: boolean;
  today?: () => CostReply;
  me?: Record<string, unknown>;
  budget?: () => CostReply;
};

async function mockApi(
  page: Page,
  cost: (month: string | null) => CostReply,
  {
    canView = true,
    today = () => ({ json: todayFixture }),
    me = {},
    budget = () => ({ json: budgetFixture() }),
  }: MockOptions = {},
) {
  const months: (string | null)[] = [];
  const todays = { count: 0 };
  const budgetWrites: unknown[] = [];
  let stored: { fallback: unknown; threshold_usd: number } | null = null;
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/me")
      return route.fulfill({
        json: {
          id: "1",
          username: "owner",
          avatar: null,
          role: "administrator",
          can_manage_users: true,
          ...(canView ? { can_view_analytics: true } : {}),
          ...me,
        },
      });
    if (url.pathname === "/api/guilds")
      return route.fulfill({ json: { guilds: [] } });
    if (url.pathname === "/api/catalog")
      return route.fulfill({
        json: { presets: [], efforts: [], exa: [], roles: [] },
      });
    if (url.pathname === "/api/analytics/cost") {
      const month = url.searchParams.get("month");
      months.push(month);
      return route.fulfill(cost(month));
    }
    if (url.pathname === "/api/analytics/today") {
      todays.count++;
      return route.fulfill(today());
    }
    if (url.pathname === "/api/budget-fallback") {
      if (route.request().method() === "PUT") {
        const { threshold_usd, ...fallback } = route.request().postDataJSON();
        budgetWrites.push({ ...fallback, threshold_usd });
        stored = { fallback, threshold_usd };
        return route.fulfill({ json: stored });
      }
      // Like the API, a read after a save returns what was saved.
      const reply = budget();
      return route.fulfill(
        stored
          ? { ...reply, json: { ...(reply.json as object), ...stored } }
          : reply,
      );
    }
    throw new Error(`Unexpected API request: ${url.pathname}`);
  });
  return { months, todays, budgetWrites };
}

const byMonth = (month: string | null): CostReply => ({
  json: month === "2026-09" ? september : october,
});

test.beforeEach(async ({ page }) => {
  // "次の月" is disabled from the browser's billing month, so pin the clock.
  await page.clock.install({ time: new Date("2026-10-13T03:00:00Z") });
});

for (const width of [1440, 390]) {
  test(`analytics shows each day against the guideline and what is left: ${width}px`, async ({
    page,
  }) => {
    const { months } = await mockApi(page, byMonth);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/analytics");

    await expect(
      page.getByRole("heading", { name: "利用料", level: 1 }),
    ).toBeVisible();
    await expect(page.getByRole("group", { name: "表示する月" })).toContainText(
      "2026年10月",
    );
    // The billing month is shown as dates too: it is not the calendar month.
    await expect(page.getByRole("group", { name: "表示する月" })).toContainText(
      "10/5〜11/4",
    );
    await expect(page.getByRole("button", { name: "次の月" })).toBeDisabled();

    // $200 − $48.29, and the guideline $200 ÷ 31.
    // Matched on the tile's own label: the words also appear in other tiles' notes.
    const stat = (label: string) =>
      page
        .locator(".stat")
        .filter({ has: page.locator(".stat-label", { hasText: label }) });
    await expect(stat("今月の残り")).toContainText("$151.71");
    await expect(stat("今月の残り")).toContainText("10/12 までの確定分");
    await expect(stat("今月の残り")).toContainText("残り 23 日");
    // $151.71 − today's $3.21.
    await expect(stat("今月の残り")).toContainText(
      "今日の推計を含めると残り $148.50",
    );
    await expect(stat("今月の累計")).toContainText("$48.29");
    await expect(stat("今月の累計")).toContainText("目安以内");
    // The running day comes from the usage report, apart from the confirmed days.
    await expect(stat("今日の推計")).toContainText("$3.21");
    await expect(stat("今日の推計")).toContainText("目安以内");
    await expect(stat("今日の推計")).toContainText("UTC の 10/13 0:00 から");
    // The newest figure is yesterday's: the running day is never in the report.
    await expect(stat("直近の確定日")).toContainText("10/12");
    await expect(stat("直近の確定日")).toContainText("$8.00");
    await expect(stat("直近の確定日")).toContainText("目安超過");
    await expect(stat("1日の目安")).toContainText("$6.45");
    await expect(stat("1日の目安")).toContainText("超えた日は 3 日");

    // Every day is in the table with its verdict in words, newest first.
    const rows = page.locator(".cost-table tbody tr");
    await expect(rows).toHaveCount(8);
    await expect(rows.filter({ hasText: "目安超過" })).toHaveCount(3);
    await expect(rows.filter({ hasText: "目安以内" })).toHaveCount(5);
    await expect(rows.first()).toContainText("10/12");
    // The oldest row is the 5th, the first day of the billing month.
    await expect(rows.last()).toContainText("10/5");
    // 9 October: $12.34 against $6.45.
    await expect(rows.nth(3)).toContainText("$12.34");
    await expect(rows.nth(3)).toContainText("+$5.89");
    await expect(rows.nth(3)).toContainText("目安超過");
    // $6.45 is below $6.4516…, so it is within the guideline.
    await expect(rows.nth(1)).toContainText("±$0.00");
    await expect(rows.nth(1)).toContainText("目安以内");

    await expect(page.locator(".chart-bar")).toHaveCount(7);
    await expect(page.locator(".chart-bar.is-over")).toHaveCount(3);
    // The axis starts on the 5th and crosses into the next calendar month.
    await expect(
      page.locator(".chart svg text.chart-tick", { hasText: "/" }),
    ).toHaveText(["10/5", "11/1"]);

    // The chart answers to the keyboard as well as the pointer.
    const chart = page.getByRole("group", { name: /日毎の利用料のグラフ/ });
    await chart.focus();
    await expect(page.locator(".chart-tip")).toContainText("$8.00");
    await expect(page.locator(".chart-tip")).toContainText("目安超過");
    await page.keyboard.press("ArrowLeft");
    await expect(page.locator(".chart-tip")).toContainText("$6.45");
    await expect(page.locator(".chart-tip")).toContainText("目安以内");

    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    // A full-page capture of a scrolled page draws the fixed header mid-page.
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({
      path: `test-results/analytics-${width}.png`,
      fullPage: true,
    });

    await page.getByRole("button", { name: "前の月" }).click();
    await expect(page.getByRole("group", { name: "表示する月" })).toContainText(
      "2026年9月",
    );
    await expect(page.getByRole("group", { name: "表示する月" })).toContainText(
      "9/5〜10/4",
    );
    await expect(rows.first()).toContainText("10/4");
    await expect(rows).toHaveCount(30);
    await expect(page.getByRole("button", { name: "次の月" })).toBeEnabled();
    // 30 days at $3–$11 come to $210: $10 over the budget.
    await expect(stat("予算の残り")).toContainText("−$10.00");
    await expect(stat("予算の残り")).toContainText("予算超過");
    await expect(stat("直近の確定日")).toHaveCount(0);
    // Today is not in a past month.
    await expect(stat("今日の推計")).toHaveCount(0);
    await expect(stat("予算の残り")).not.toContainText("今日の推計");
    // The dev server's StrictMode runs the first load twice, hence the set.
    expect([...new Set(months)]).toEqual([null, "2026-09"]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/analytics-past-${width}.png`,
      fullPage: true,
    });
  });
}

test("analytics in the dark theme", async ({ page }) => {
  await mockApi(page, byMonth);
  await page.addInitScript(() => localStorage.setItem("hibana-theme", "dark"));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/analytics");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator(".chart-bar.is-over")).toHaveCount(3);
  await page.locator(".chart").hover({ position: { x: 240, y: 100 } });
  await expect(page.locator(".chart-tip")).toBeVisible();
  await page.screenshot({
    path: "test-results/analytics-dark.png",
    fullPage: true,
  });
});

test("analytics before the 5th still shows the billing month that began the month before", async ({
  page,
}) => {
  // 4 November is the last day of the billing month that began on 5 October.
  await page.clock.setSystemTime(new Date("2026-11-04T03:00:00Z"));
  await mockApi(page, byMonth);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/analytics");
  await expect(page.getByRole("group", { name: "表示する月" })).toContainText(
    "2026年10月",
  );
  await expect(page.getByRole("button", { name: "次の月" })).toBeDisabled();
});

test("analytics on the first day of a month has the budget but no days yet", async ({
  page,
}) => {
  await mockApi(page, () => ({ json: firstDay }));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/analytics");
  await expect(
    page.getByText("この月で終わった日はまだありません"),
  ).toBeVisible();
  await expect(
    page.locator(".stat").filter({ hasText: "今月の残り" }),
  ).toContainText("$200.00");
  await expect(
    page.locator(".stat").filter({ hasText: "今月の残り" }),
  ).toContainText("残り 31 日");
  await expect(
    page.locator(".stat").filter({ hasText: "今月の累計" }),
  ).toContainText("確定した日がまだありません");
  await expect(page.locator(".cost-table")).toHaveCount(0);
  await expect(page.locator(".chart")).toHaveCount(0);
});

test("analytics is not offered to an account that may not view it", async ({
  page,
}) => {
  // Every role may view it since #85; an API that does not say so is still obeyed.
  const { months, todays } = await mockApi(page, byMonth, { canView: false });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/analytics");
  await expect(page).toHaveURL(/\/$/);
  await expect(
    page
      .getByRole("navigation", { name: "メイン" })
      .getByRole("link", { name: "利用料" }),
  ).toHaveCount(0);
  expect(months).toEqual([]);
  expect(todays.count).toBe(0);
});

test("any user finds analytics among the pages for everyone, not under 管理", async ({
  page,
}) => {
  await mockApi(page, byMonth, {
    me: { username: "member", role: "free", can_manage_users: false },
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "メイン" });
  await expect(nav.getByRole("link", { name: "利用料" })).toBeVisible();
  await expect(nav.getByText("管理", { exact: true })).toHaveCount(0);
  await nav.getByRole("link", { name: "利用料" }).click();
  await expect(page).toHaveURL(/\/analytics$/);
  // Matched on the tile's own label: the remaining tile's note mentions it too.
  const card = page
    .locator(".stat")
    .filter({ has: page.locator(".stat-label", { hasText: "今日の推計" }) });
  await expect(card).toContainText("$3.21");
});

test("today's estimate is read again every minute and keeps its last figure through an error", async ({
  page,
}) => {
  let reply: CostReply = { json: todayFixture };
  const { todays } = await mockApi(page, byMonth, { today: () => reply });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/analytics");
  const card = page
    .locator(".stat")
    .filter({ has: page.locator(".stat-label", { hasText: "今日の推計" }) });
  await expect(card).toContainText("$3.21");
  const before = todays.count;

  reply = {
    json: {
      ...todayFixture,
      through: "2026-10-13T03:00:00Z",
      cost_usd: 7.5,
      over: true,
      unpriced: [
        { model: "claude-opus-5-6", service_tier: "standard", tokens: 12345 },
      ],
    },
  };
  await page.clock.runFor(60_000);
  await expect(card).toContainText("$7.50");
  await expect(card).toContainText("目安超過");
  await expect(card).toContainText("claude-opus-5-6");
  await expect(card).toContainText("12,345 トークン");
  expect(todays.count).toBeGreaterThan(before);

  reply = {
    status: 429,
    json: {
      error:
        "利用料の取得が混み合っています。1 分ほど待って再読み込みしてください",
    },
  };
  await page.clock.runFor(60_000);
  await expect(card).toContainText("混み合っています");
  await expect(card).toContainText("$7.50");
  // The confirmed days do not depend on it.
  await expect(page.locator(".cost-table tbody tr")).toHaveCount(8);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("analytics explains a missing key and shows an upstream error", async ({
  page,
}) => {
  let reply: CostReply = { json: { configured: false } };
  await mockApi(page, () => reply, {
    today: () => ({ json: { configured: false } }),
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/analytics");
  await expect(page.getByText("Admin API のキーが未設定")).toBeVisible();
  await expect(page.getByText("ANTHROPIC_ADMIN_API_KEY")).toBeVisible();

  reply = {
    status: 502,
    json: {
      error: "このキーには cost report を読む権限がありません（HTTP 403）。",
    },
  };
  await page.getByRole("button", { name: "再読み込み" }).click();
  await expect(page.getByRole("alert")).toContainText("読む権限がありません");

  // The page recovers on the next reload without leaving it.
  reply = { json: october };
  await page.getByRole("button", { name: "再読み込み" }).click();
  await expect(page.locator(".cost-table tbody tr")).toHaveCount(8);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test.describe("budget fallback (#89)", () => {
  const panel = (page: Page) => page.locator(".budget-panel");

  for (const width of [1440, 390]) {
    test(`an Administrator sees the state and changes the model and the threshold: ${width}px`, async ({
      page,
    }) => {
      const { budgetWrites } = await mockApi(page, byMonth);
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/analytics");
      await expect(
        panel(page).getByRole("heading", { name: "予算が少ないときのモデル" }),
      ).toBeVisible();
      await expect(panel(page)).toContainText("通常のモデル");
      await expect(panel(page)).toContainText("今日の推計を含めた残り $148.50");
      await expect(panel(page)).toContainText(
        "（今月の残り $151.71 − 今日の推計 $3.21）",
      );
      await expect(panel(page)).toContainText("$10.00 を切ると");
      const save = panel(page).getByRole("button", { name: "保存" });
      await expect(save).toBeDisabled();

      await panel(page)
        .getByRole("combobox", { name: "フォールバックモデル" })
        .click();
      // A hidden preset is not offered unless it is the stored one.
      await expect(page.getByRole("option", { name: /Opus 5\.6/ })).toHaveCount(
        0,
      );
      await page
        .getByRole("option", { name: "Anthropic / Claude Sonnet 5.5" })
        .click();
      await panel(page)
        .getByRole("combobox", { name: "フォールバックの effort" })
        .click();
      await page.getByRole("option", { name: "Medium" }).click();
      await expect(save).toBeEnabled();
      await save.click();
      await expect
        .poll(() => budgetWrites)
        .toEqual([
          {
            preset: "anthropic-sonnet-5-5",
            effort: "medium",
            threshold_usd: 10,
          },
        ]);
      await expect(
        page.getByText("保存しました。bot には 2 分ほどで届きます"),
      ).toBeVisible();
      await expect(save).toBeDisabled();

      // The threshold (#95).
      const threshold = panel(page).getByRole("spinbutton", {
        name: "切り替える閾値（USD）",
      });
      await expect(threshold).toHaveValue("10");
      await expect(panel(page)).toContainText(
        "閾値は $0.00〜$200.00（月の予算）、1 セント単位。既定は $10.00。",
      );
      await threshold.fill("25.5");
      await expect(save).toBeEnabled();
      await save.click();
      await expect
        .poll(() => budgetWrites.at(-1))
        .toEqual({
          preset: "anthropic-sonnet-5-5",
          effort: "medium",
          threshold_usd: 25.5,
        });
      await expect(panel(page)).toContainText("$25.50 を切ると");
      await expect(threshold).toHaveValue("25.5");
      await expect(save).toBeDisabled();

      // Nothing sticks out of a narrow screen.
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
    });
  }

  test("everyone else sees the model without controls, and the switch when it is on", async ({
    page,
  }) => {
    await mockApi(page, byMonth, {
      budget: () => ({
        json: budgetFixture({
          can_edit: false,
          status: {
            configured: true,
            month: "2026-10",
            remaining_usd: 12,
            today_usd: 4.5,
            remaining_after_today_usd: 7.5,
            threshold_usd: 10,
            low: true,
            fetched_at: 0,
          },
        }),
      }),
    });
    await page.goto("/analytics");
    await expect(panel(page)).toContainText("切り替え中");
    await expect(panel(page)).toContainText("今日の推計を含めた残り $7.50");
    await expect(panel(page)).toContainText(
      "いまフォールバックモデルで動いています",
    );
    await expect(panel(page)).toContainText(
      "Anthropic / Claude Haiku 5.5 · High",
    );
    await expect(panel(page)).toContainText("閾値$10.00");
    await expect(panel(page)).toContainText(
      "変更できるのは Administrator です",
    );
    await expect(panel(page).getByRole("combobox")).toHaveCount(0);
    await expect(panel(page).getByRole("spinbutton")).toHaveCount(0);
    await expect(panel(page).getByRole("button", { name: "保存" })).toHaveCount(
      0,
    );
  });

  test("a threshold out of range or finer than a cent is not saved (#95)", async ({
    page,
  }) => {
    const { budgetWrites } = await mockApi(page, byMonth);
    await page.goto("/analytics");
    const threshold = panel(page).getByRole("spinbutton", {
      name: "切り替える閾値（USD）",
    });
    const save = panel(page).getByRole("button", { name: "保存" });
    for (const bad of ["200.01", "-1", "1.005", ""]) {
      await threshold.fill(bad);
      await expect(threshold).toHaveAttribute("aria-invalid", "true");
      await expect(panel(page)).toContainText("この値では保存できません");
      await expect(save).toBeDisabled();
    }
    // 元に戻す restores the stored value.
    await panel(page).getByRole("button", { name: "元に戻す" }).click();
    await expect(threshold).toHaveValue("10");
    await expect(threshold).toHaveAttribute("aria-invalid", "false");
    await threshold.fill("0");
    await save.click();
    await expect
      .poll(() => budgetWrites)
      .toEqual([
        { preset: "anthropic-haiku-5-5", effort: "high", threshold_usd: 0 },
      ]);
  });

  test("says when it cannot tell, and why", async ({ page }) => {
    await mockApi(page, byMonth, {
      budget: () => ({
        json: budgetFixture({
          status: {
            configured: true,
            error: "Anthropic の cost report が HTTP 500 を返しました",
          },
        }),
      }),
    });
    await page.goto("/analytics");
    await expect(panel(page)).toContainText("判定できません");
    await expect(panel(page)).toContainText("HTTP 500");
    await expect(panel(page)).toContainText("最後に読めた判定のまま");
  });
});

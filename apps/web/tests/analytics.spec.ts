import { expect, test, type Page } from "@playwright/test";

// The page only renders what GET /api/analytics/cost returns; the arithmetic is
// tested with the API (apps/api/src/analytics.test.ts). These fixtures follow
// that response shape so the labels can be checked against known numbers.
const BUDGET = 200;

function monthFixture(month: string, daysInMonth: number, costs: (number | null)[], current: boolean) {
  const guideline = BUDGET / daysInMonth;
  const days = costs.map((cost, i) => ({
    date: `${month}-${String(i + 1).padStart(2, "0")}`,
    cost_usd: cost,
    over: cost !== null && cost > guideline,
  }));
  const spent = costs.reduce<number>((sum, cost) => sum + (cost ?? 0), 0);
  return {
    configured: true,
    month,
    current,
    today: "2026-10-09",
    monthly_budget_usd: BUDGET,
    days_in_month: daysInMonth,
    daily_guideline_usd: guideline,
    days,
    spent_usd: spent,
    remaining_usd: BUDGET - spent,
    pace_usd: guideline * days.length,
    days_left: current ? daysInMonth - days.length : 0,
    fetched_at: Date.parse("2026-10-09T03:00:00Z"),
  };
}

// The cost report only has days that have ended, so on 9 October the month
// runs to the 8th: three days above $6.45, five at or below it.
const october = monthFixture("2026-10", 31, [4.2, 7.9, 6.1, 0, 12.34, 3.3, 6.45, 8], true);
// The first day of a month: nothing has ended yet.
const firstDay = monthFixture("2026-10", 31, [], true);
// A finished month that ran over the budget: 30 days at $3–$11.
const september = monthFixture("2026-09", 30, Array.from({ length: 30 }, (_, i) => 3 + ((i * 7) % 9)), false);

type CostReply = { status?: number; json: unknown };

async function mockApi(page: Page, cost: (month: string | null) => CostReply, canView = true) {
  const months: (string | null)[] = [];
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
        },
      });
    if (url.pathname === "/api/guilds") return route.fulfill({ json: { guilds: [] } });
    if (url.pathname === "/api/catalog")
      return route.fulfill({ json: { presets: [], efforts: [], exa: [], roles: [] } });
    if (url.pathname === "/api/analytics/cost") {
      const month = url.searchParams.get("month");
      months.push(month);
      return route.fulfill(cost(month));
    }
    throw new Error(`Unexpected API request: ${url.pathname}`);
  });
  return months;
}

const byMonth = (month: string | null): CostReply => ({ json: month === "2026-09" ? september : october });

test.beforeEach(async ({ page }) => {
  // "次の月" is disabled from the browser's UTC month, so pin the clock.
  await page.clock.install({ time: new Date("2026-10-09T03:00:00Z") });
});

for (const width of [1440, 390]) {
  test(`analytics shows each day against the guideline and what is left: ${width}px`, async ({ page }) => {
    const months = await mockApi(page, byMonth);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/analytics");

    await expect(page.getByRole("heading", { name: "利用料", level: 1 })).toBeVisible();
    await expect(page.getByRole("group", { name: "表示する月" })).toContainText("2026年10月");
    await expect(page.getByRole("button", { name: "次の月" })).toBeDisabled();

    // $200 − $48.29, and the guideline $200 ÷ 31.
    // Matched on the tile's own label: the words also appear in other tiles' notes.
    const stat = (label: string) =>
      page.locator(".stat").filter({ has: page.locator(".stat-label", { hasText: label }) });
    await expect(stat("今月の残り")).toContainText("$151.71");
    await expect(stat("今月の残り")).toContainText("10/8 までの確定分");
    await expect(stat("今月の残り")).toContainText("残り 23 日");
    await expect(stat("今月の累計")).toContainText("$48.29");
    await expect(stat("今月の累計")).toContainText("目安以内");
    // The newest figure is yesterday's: the running day is never in the report.
    await expect(stat("直近の確定日")).toContainText("10/8");
    await expect(stat("直近の確定日")).toContainText("$8.00");
    await expect(stat("直近の確定日")).toContainText("目安超過");
    await expect(stat("1日の目安")).toContainText("$6.45");
    await expect(stat("1日の目安")).toContainText("超えた日は 3 日");

    // Every day is in the table with its verdict in words, newest first.
    const rows = page.locator(".cost-table tbody tr");
    await expect(rows).toHaveCount(8);
    await expect(rows.filter({ hasText: "目安超過" })).toHaveCount(3);
    await expect(rows.filter({ hasText: "目安以内" })).toHaveCount(5);
    await expect(rows.first()).toContainText("10/8");
    // 5 October: $12.34 against $6.45.
    await expect(rows.nth(3)).toContainText("$12.34");
    await expect(rows.nth(3)).toContainText("+$5.89");
    await expect(rows.nth(3)).toContainText("目安超過");
    // $6.45 is below $6.4516…, so it is within the guideline.
    await expect(rows.nth(1)).toContainText("±$0.00");
    await expect(rows.nth(1)).toContainText("目安以内");

    await expect(page.locator(".chart-bar")).toHaveCount(7);
    await expect(page.locator(".chart-bar.is-over")).toHaveCount(3);

    // The chart answers to the keyboard as well as the pointer.
    const chart = page.getByRole("group", { name: /日毎の利用料のグラフ/ });
    await chart.focus();
    await expect(page.locator(".chart-tip")).toContainText("$8.00");
    await expect(page.locator(".chart-tip")).toContainText("目安超過");
    await page.keyboard.press("ArrowLeft");
    await expect(page.locator(".chart-tip")).toContainText("$6.45");
    await expect(page.locator(".chart-tip")).toContainText("目安以内");

    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    // A full-page capture of a scrolled page draws the fixed header mid-page.
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: `test-results/analytics-${width}.png`, fullPage: true });

    await page.getByRole("button", { name: "前の月" }).click();
    await expect(page.getByRole("group", { name: "表示する月" })).toContainText("2026年9月");
    await expect(rows).toHaveCount(30);
    await expect(page.getByRole("button", { name: "次の月" })).toBeEnabled();
    // 30 days at $3–$11 come to $210: $10 over the budget.
    await expect(stat("予算の残り")).toContainText("−$10.00");
    await expect(stat("予算の残り")).toContainText("予算超過");
    await expect(stat("直近の確定日")).toHaveCount(0);
    // The dev server's StrictMode runs the first load twice, hence the set.
    expect([...new Set(months)]).toEqual([null, "2026-09"]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/analytics-past-${width}.png`, fullPage: true });
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
  await page.screenshot({ path: "test-results/analytics-dark.png", fullPage: true });
});

test("analytics on the first day of a month has the budget but no days yet", async ({ page }) => {
  await mockApi(page, () => ({ json: firstDay }));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/analytics");
  await expect(page.getByText("この月で終わった日はまだありません")).toBeVisible();
  await expect(page.locator(".stat").filter({ hasText: "今月の残り" })).toContainText("$200.00");
  await expect(page.locator(".stat").filter({ hasText: "今月の残り" })).toContainText("残り 31 日");
  await expect(page.locator(".stat").filter({ hasText: "今月の累計" })).toContainText("確定した日がまだありません");
  await expect(page.locator(".cost-table")).toHaveCount(0);
  await expect(page.locator(".chart")).toHaveCount(0);
});

test("analytics is not offered to an account that may not view it", async ({ page }) => {
  const months = await mockApi(page, byMonth, false);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/analytics");
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("navigation", { name: "メイン" }).getByRole("link", { name: "利用料" })).toHaveCount(0);
  expect(months).toEqual([]);
});

test("analytics explains a missing key and shows an upstream error", async ({ page }) => {
  let reply: CostReply = { json: { configured: false } };
  await mockApi(page, () => reply);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/analytics");
  await expect(page.getByText("Admin API のキーが未設定")).toBeVisible();
  await expect(page.getByText("ANTHROPIC_ADMIN_API_KEY")).toBeVisible();

  reply = { status: 502, json: { error: "このキーには cost report を読む権限がありません（HTTP 403）。" } };
  await page.getByRole("button", { name: "再読み込み" }).click();
  await expect(page.getByRole("alert")).toContainText("読む権限がありません");

  // The page recovers on the next reload without leaving it.
  reply = { json: october };
  await page.getByRole("button", { name: "再読み込み" }).click();
  await expect(page.locator(".cost-table tbody tr")).toHaveCount(8);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

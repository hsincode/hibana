// Decision record #185: dashboard notifies the user once the running bot has
// acknowledged applying the saved snapshot version.
import { expect, test, type Page } from "@playwright/test";
import { emptyAppSettings, emptyGuild } from "@hibana/shared/settings";

const catalog = {
  presets: [
    {
      id: "deepseek",
      provider: "deepseek",
      model: "DeepSeek V4",
      label: "DeepSeek / DeepSeek V4",
      published: true,
    },
    {
      id: "claude",
      provider: "kiro",
      model: "Claude Opus",
      label: "Claude Kiro / Claude Opus",
      published: true,
    },
  ],
  efforts: ["low", "medium", "high", "max"],
  exa: ["auto", "off"],
  roles: ["administrator", "moderator", "premium", "standard", "free"],
  triggers: ["hibana"],
};

/**
 * `syncResponseDelayMs` holds each `GET /api/sync-status` answer back after it
 * has been counted, the way a slow CI runner does: the page only arms its next
 * poll once the answer has arrived and been read (#191).
 */
async function mockSyncApi(page: Page, { syncResponseDelayMs = 0 } = {}) {
  const state = {
    snapshotVersion: 1,
    appliedVersion: 1 as number | null,
    syncCalls: 0,
    settings: {
      ...emptyGuild(),
      selection: {
        provider: "deepseek",
        model: "DeepSeek V4",
        effort: "medium",
      },
      effort: "medium",
    } as Record<string, unknown>,
    appSettings: emptyAppSettings() as Record<string, unknown>,
  };

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const body =
      method === "PATCH" || method === "PUT" || method === "POST"
        ? (request.postDataJSON() as Record<string, unknown>)
        : undefined;

    if (path === "/api/me") {
      return route.fulfill({
        json: {
          id: "1",
          username: "xuanling",
          avatar: null,
          role: "administrator",
          can_manage_users: true,
          can_manage_app_settings: true,
        },
      });
    }
    if (path === "/api/guilds") {
      return route.fulfill({
        json: {
          guilds: [
            {
              id: "100",
              name: "Alpha Guild",
              icon: null,
              preset: "DeepSeek V4",
              provider: "deepseek",
              can_manage: true,
            },
          ],
        },
      });
    }
    if (path === "/api/catalog") {
      return route.fulfill({ json: catalog });
    }
    if (path === "/api/guilds/100/settings") {
      if (method === "PATCH" && body) {
        state.settings = { ...state.settings, ...body };
        state.snapshotVersion += 1;
        return route.fulfill({
          json: {
            settings: state.settings,
            version: state.snapshotVersion,
            snapshot_version: state.snapshotVersion,
          },
        });
      }
      return route.fulfill({
        json: { settings: state.settings, can_edit: true },
      });
    }
    if (path === "/api/guilds/100/schedules") {
      if (method === "PUT" && body) {
        state.snapshotVersion += 1;
        return route.fulfill({
          json: {
            schedules: body.schedules,
            version: state.snapshotVersion,
            snapshot_version: state.snapshotVersion,
          },
        });
      }
      return route.fulfill({
        json: {
          schedules: [],
          assets: [],
          assets_reported_at: null,
          can_edit: true,
        },
      });
    }
    if (path === "/api/guilds/100/channels") {
      return route.fulfill({ json: { channels: [] } });
    }
    if (path === "/api/artifacts") {
      return route.fulfill({ json: { sites: [] } });
    }
    if (path === "/api/users") {
      return route.fulfill({
        json: {
          users: [{ discord_id: "2", username: "member", role: "free" }],
          assignable: ["free", "premium"],
        },
      });
    }
    if (path === "/api/users/2" && method === "PATCH") {
      state.snapshotVersion += 1;
      return route.fulfill({
        json: {
          ok: true,
          discord_id: "2",
          role: body?.role ?? "premium",
          version: state.snapshotVersion,
          snapshot_version: state.snapshotVersion,
        },
      });
    }
    if (path === "/api/sync-status") {
      state.syncCalls += 1;
      if (syncResponseDelayMs > 0)
        await new Promise((resolve) =>
          setTimeout(resolve, syncResponseDelayMs),
        );
      return route.fulfill({
        json: {
          snapshot_version: state.snapshotVersion,
          applied_version: state.appliedVersion,
          applied_at: state.appliedVersion !== null ? 1_763_820_000_000 : null,
        },
      });
    }
    throw new Error(`Unexpected API request: ${method} ${path}`);
  });

  return state;
}

test("saving waits for bot ack, then updates the top bar with a spark and shows a toast", async ({
  page,
}) => {
  await page.clock.install();
  const state = await mockSyncApi(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/g/100");

  const status = page.locator(".topbar").getByRole("status");
  await expect(status).toHaveText("変更は自動保存されます");

  const effort = page.getByRole("combobox", { name: "effort", exact: true });
  await effort.click();
  await page.getByRole("option", { name: "high", exact: true }).click();

  // Immediately after save, the top bar shows waiting for bot sync without a toast.
  await expect(status).toContainText("bot へ反映待ち…");
  await expect(status).toContainText("保存済み");
  await expect(page.locator(".toast")).toHaveCount(0);

  // First poll: bot has not applied version 2 yet.
  await page.clock.runFor(3_000);
  await expect.poll(() => state.syncCalls).toBe(1);
  await expect(status).toContainText("bot へ反映待ち…");
  await expect(page.locator(".toast")).toHaveCount(0);

  // Bot applies version 2 before the next poll.
  state.appliedVersion = 2;
  await page.clock.runFor(3_000);
  await expect.poll(() => state.syncCalls).toBe(2);
  await expect(status).toContainText("bot に反映済み");
  const spark = status.locator(".save-glyph.spark");
  await expect(spark).toHaveCount(1);
  expect(
    await spark.evaluate(
      (el) => getComputedStyle(el, "::after").animationIterationCount,
    ),
  ).toBe("1");
  await expect(page.locator(".toast")).toHaveText(
    "設定が bot に反映されました",
  );

  // Polling stops once reflected.
  await page.clock.runFor(9_000);
  expect(state.syncCalls).toBe(2);
});

test("consecutive edits coalesce to the latest version and emit a single toast", async ({
  page,
}) => {
  await page.clock.install();
  const state = await mockSyncApi(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/g/100");

  const status = page.locator(".topbar").getByRole("status");
  const effort = page.getByRole("combobox", { name: "effort", exact: true });

  await effort.click();
  await page.getByRole("option", { name: "high", exact: true }).click();
  await expect(status).toContainText("bot へ反映待ち…");

  await effort.click();
  await page.getByRole("option", { name: "max", exact: true }).click();
  expect(state.snapshotVersion).toBe(3);

  // Version 2 is applied, but version 3 is still pending -> no toast yet.
  state.appliedVersion = 2;
  await page.clock.runFor(3_000);
  await expect(status).toContainText("bot へ反映待ち…");
  await expect(page.locator(".toast")).toHaveCount(0);

  // Version 3 is applied -> single toast.
  state.appliedVersion = 3;
  await page.clock.runFor(3_000);
  await expect(status).toContainText("bot に反映済み");
  await expect(page.locator(".toast")).toHaveCount(1);
  await expect(page.locator(".toast")).toHaveText(
    "設定が bot に反映されました",
  );
});

test("sync tracking survives page navigation and notifies on the destination page", async ({
  page,
}) => {
  await page.clock.install();
  const state = await mockSyncApi(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/g/100");

  const effort = page.getByRole("combobox", { name: "effort", exact: true });
  await effort.click();
  await page.getByRole("option", { name: "high", exact: true }).click();
  await expect(page.locator(".topbar").getByRole("status")).toContainText(
    "bot へ反映待ち…",
  );

  // Navigate to a page without autosave while bot sync is still pending.
  await page
    .getByRole("navigation", { name: "メイン", exact: true })
    .getByRole("link", { name: "すべての成果物" })
    .click();
  await expect(page).toHaveURL(/\/artifacts$/);
  await expect(page.locator(".topbar").getByRole("status")).toContainText(
    "bot へ反映待ち…",
  );

  state.appliedVersion = 2;
  await page.clock.runFor(3_000);
  await expect(page.locator(".topbar").getByRole("status")).toContainText(
    "bot に反映済み",
  );
  await expect(page.locator(".toast")).toHaveText(
    "設定が bot に反映されました",
  );
});

test("explicit save pages such as user role updates also track bot sync", async ({
  page,
}) => {
  await page.clock.install();
  const state = await mockSyncApi(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/users");

  await page.getByRole("combobox", { name: "member のロールを変更" }).click();
  await page.getByRole("option", { name: "premium", exact: true }).click();
  await expect(page.locator(".topbar").getByRole("status")).toContainText(
    "bot へ反映待ち…",
  );

  state.appliedVersion = 2;
  await page.clock.runFor(3_000);
  await expect(page.locator(".topbar").getByRole("status")).toContainText(
    "bot に反映済み",
  );
  await expect(
    page.locator(".toast", { hasText: "設定が bot に反映されました" }),
  ).toHaveCount(1);
});

/** BOT_SYNC_POLL_MS in `src/sync.tsx`; no other timer on these pages uses it. */
const POLL_MS = 3_000;

/**
 * Count the poll timers the page arms. Wraps the fake `setTimeout` that
 * `page.clock.install()` put in place, so call it after `page.goto`.
 */
async function countPollTimers(page: Page) {
  await page.evaluate((pollMs) => {
    const w = window as unknown as { __pollTimers: number };
    w.__pollTimers = 0;
    const fake = window.setTimeout;
    window.setTimeout = ((
      handler: TimerHandler,
      timeout?: number,
      ...args: unknown[]
    ) => {
      if (timeout === pollMs) w.__pollTimers += 1;
      return fake(handler, timeout, ...args);
    }) as typeof window.setTimeout;
  }, POLL_MS);
  return () =>
    page.evaluate(
      () => (window as unknown as { __pollTimers: number }).__pollTimers,
    );
}

test("stops polling and shows timeout state after 60 seconds without ack", async ({
  page,
}) => {
  // After `install()` the fake clock still flows with real time, so on a slow
  // runner the real seconds between steps bring the 60s deadline forward.
  // Pause it once the page has loaded: from then on only `runFor` moves it.
  const start = new Date("2026-11-24T09:00:00+09:00").getTime();
  await page.clock.install({ time: start });
  const state = await mockSyncApi(page, { syncResponseDelayMs: 100 });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/g/100");
  await page.clock.pauseAt(start + 10 * 60_000);
  const pollTimers = await countPollTimers(page);

  const status = page.locator(".topbar").getByRole("status");
  const effort = page.getByRole("combobox", { name: "effort", exact: true });
  await effort.click();
  await page.getByRole("option", { name: "high", exact: true }).click();
  await expect(status).toContainText("bot へ反映待ち…");

  // Step through 20 x 3s polls (60s total) while the bot never acknowledges.
  // The page arms the next poll only after reading the previous answer, so
  // move the clock only once that timer exists: moving it earlier delays
  // every later poll and leaves fewer than 20 before the deadline (#191).
  for (let i = 1; i <= 20; i++) {
    await expect.poll(pollTimers).toBe(i);
    await page.clock.runFor(POLL_MS);
    await expect.poll(() => state.syncCalls).toBe(i);
  }
  await expect(status).toContainText("反映未確認");
  const callsAtTimeout = state.syncCalls;
  expect(callsAtTimeout).toBe(20);
  expect(await pollTimers()).toBe(20);

  // No more polling after timeout.
  await page.clock.runFor(15_000);
  expect(state.syncCalls).toBe(callsAtTimeout);
  await expect(page.locator(".toast")).toHaveCount(0);
});

for (const width of [390, 320]) {
  test(`no horizontal overflow across sync states at narrow width ${width}px`, async ({
    page,
  }) => {
    await page.clock.install();
    const state = await mockSyncApi(page);
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/g/100");

    const checkNoOverflow = async () =>
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);

    const status = page.locator(".topbar").getByRole("status");
    const effort = page.getByRole("combobox", { name: "effort", exact: true });
    await effort.click();
    await page.getByRole("option", { name: "high", exact: true }).click();
    await expect(status).toContainText("bot へ反映待ち…");
    await checkNoOverflow();

    // Timeout state at narrow width.
    await page.clock.runFor(60_000);
    await expect(status).toContainText("反映未確認");
    await checkNoOverflow();

    // Trigger another save and verify synced state + toast at narrow width.
    await effort.click();
    await page.getByRole("option", { name: "max", exact: true }).click();
    state.appliedVersion = state.snapshotVersion;
    await page.clock.runFor(3_000);
    await expect(status).toContainText("bot に反映済み");
    await expect(page.locator(".toast")).toHaveText(
      "設定が bot に反映されました",
    );
    await checkNoOverflow();
  });
}

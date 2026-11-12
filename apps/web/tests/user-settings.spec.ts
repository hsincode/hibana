// Decision record #175: an Administrator or Moderator opens the personal
// settings of a user of a weaker role from the users list, on the page the
// user's own マイ設定 is made of.
import { expect, test, type Page } from "@playwright/test";
import { emptyUserOverride } from "@hibana/shared/settings";

const catalog = {
  presets: [
    {
      id: "deepseek",
      provider: "deepseek",
      model: "DeepSeek V4",
      label: "DeepSeek / DeepSeek V4",
    },
    {
      id: "claude",
      provider: "kiro",
      model: "Claude Opus",
      label: "Claude Kiro / Claude Opus",
      min_role: "premium",
    },
  ],
  efforts: ["low", "medium", "high", "max"],
  exa: ["auto", "off"],
  roles: ["administrator", "moderator", "premium", "standard", "free"],
  triggers: ["hibana"],
};

const users = [
  {
    discord_id: "1",
    username: "xuanling",
    role: "administrator",
    can_edit_settings: false,
  },
  {
    discord_id: "2",
    username: "workspace-member",
    role: "free",
    can_edit_settings: true,
  },
  // What an API from before #175 answers: no `can_edit_settings`.
  { discord_id: "3", username: "older-row", role: "free" },
];

/** `refuse` answers the other user's settings like the API does for a row the session may not open. */
async function mockApi(page: Page, refuse = false) {
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  const rows = new Map<string, Record<string, unknown>>();
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const body =
      request.method() === "PATCH" ? request.postDataJSON() : undefined;
    if (body) writes.push({ path, body });
    if (path === "/api/me")
      return route.fulfill({
        json: {
          id: "1",
          username: "xuanling",
          avatar: null,
          role: "administrator",
          can_manage_users: true,
        },
      });
    if (path === "/api/guilds") return route.fulfill({ json: { guilds: [] } });
    if (path === "/api/catalog") return route.fulfill({ json: catalog });
    if (path === "/api/users")
      return route.fulfill({
        json: { users, assignable: ["moderator", "premium", "free"] },
      });
    if (path === "/api/me/settings" || path === "/api/users/2/settings") {
      if (refuse && path !== "/api/me/settings")
        return route.fulfill({
          status: 403,
          json: { error: "cannot open this user's settings" },
        });
      const saved = { ...emptyUserOverride(), ...rows.get(path), ...body };
      rows.set(path, saved);
      return route.fulfill({
        json:
          path === "/api/me/settings"
            ? { settings: saved }
            : {
                settings: saved,
                user: {
                  discord_id: "2",
                  username: "workspace-member",
                  role: "free",
                },
              },
      });
    }
    throw new Error(`Unexpected API request: ${path}`);
  });
  return writes;
}

for (const width of [1440, 390]) {
  test(`a user's personal settings open from the users list and save to that user: ${width}px`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const writes = await mockApi(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/users");

    // Only the row the API says the session may open has the link.
    await expect(page.getByRole("link", { name: /の個人設定$/ })).toHaveCount(
      1,
    );
    await page.screenshot({
      path: `test-results/users-list-${width}.png`,
      fullPage: true,
      animations: "disabled",
    });
    await page
      .getByRole("link", { name: "workspace-member の個人設定" })
      .click();
    await expect(page).toHaveURL(/\/users\/2$/);
    await expect(
      page.getByRole("heading", {
        level: 1,
        name: "workspace-member の個人設定",
      }),
    ).toBeVisible();
    await expect(page.locator(".page-head .badge")).toHaveText("free");
    await expect(page.locator(".skeleton")).toHaveCount(0);
    // The page speaks of the user, not of the person looking at it.
    await expect(
      page.getByRole("heading", { name: "このユーザーの上書き" }),
    ).toBeVisible();
    await expect(page.getByText("あなた")).toHaveCount(0);

    await page.screenshot({
      path: `test-results/user-settings-${width}.png`,
      fullPage: true,
      animations: "disabled",
    });

    const jev = page.getByRole("group", { name: "Jev 判定", exact: true });
    await jev.getByRole("button", { name: "OFF", exact: true }).click();
    await expect(
      jev.getByRole("button", { name: "OFF", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect
      .poll(() => writes.map((w) => [w.path, w.body.jev_enabled]))
      .toEqual([["/api/users/2/settings", false]]);

    // The picker locks what the user's role may not pick, whatever the role
    // of the Administrator looking at it.
    await page.getByRole("button", { name: "モデルを変更" }).click();
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("button", { name: /Claude Opus/ }),
    ).toBeDisabled();
    await expect(dialog).toContainText("このユーザーのプランでは選べない");
    await dialog.getByRole("button", { name: /DeepSeek V4/ }).click();
    await expect
      .poll(() => writes[writes.length - 1])
      .toEqual({ path: "/api/users/2/settings", body: { preset: "deepseek" } });
    expect(writes.some((w) => w.path === "/api/me/settings")).toBe(false);

    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.getByRole("link", { name: "ユーザーの一覧へ戻る" }).click();
    await expect(page).toHaveURL(/\/users$/);
    expect(errors).toEqual([]);
  });
}

test("a row the session may not open shows the API's answer and no settings", async ({
  page,
}) => {
  const writes = await mockApi(page, true);
  await page.goto("/users/2");
  await expect(page.getByRole("alert")).toContainText(
    "cannot open this user's settings",
  );
  await expect(page.getByRole("group", { name: "Jev 判定" })).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "ユーザーの一覧へ戻る" }),
  ).toBeVisible();
  expect(writes).toEqual([]);
});

test("マイ設定 still reads and writes the session's own row, and says あなた", async ({
  page,
}) => {
  const writes = await mockApi(page);
  await page.goto("/me");
  await expect(
    page.getByRole("heading", { name: "あなたの上書き" }),
  ).toBeVisible();
  const jev = page.getByRole("group", { name: "Jev 判定", exact: true });
  await jev.getByRole("button", { name: "OFF", exact: true }).click();
  await expect
    .poll(() => writes.map((w) => [w.path, w.body.jev_enabled]))
    .toEqual([["/api/me/settings", false]]);
  // The Administrator's own role unlocks the Premium preset here.
  await page.getByRole("button", { name: "モデルを変更" }).click();
  await expect(
    page.getByRole("dialog").getByRole("button", { name: /Claude Opus/ }),
  ).toBeEnabled();
});

import { expect, test, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { emptyGuild } from "@hibana/shared/settings";
import { AUTO_ROUTE_FALLBACK } from "@hibana/shared/catalog";
import { GUILD_PAGES, GUILD_SETTINGS, guildPath } from "../src/nav";

const guilds = [
  { id: "100", name: "Design workspace", icon: null, preset: "DeepSeek V4" },
  { id: "200", name: "開発コミュニティ", icon: null, preset: "Claude Opus" },
  { id: "300", name: "Research lab", icon: null, preset: "GPT" },
];
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
      provider: "claude_kiro",
      model: "Claude Opus",
      label: "Claude Kiro / Claude Opus",
    },
    {
      id: "gpt",
      provider: "codex_plus",
      model: "GPT",
      label: "Codex Plus / GPT",
    },
  ],
  // Include the legacy alias to verify new pickers do not offer it.
  efforts: ["low", "medium", "high", "max", "ultra"],
  exa: ["auto", "off"],
  roles: ["user", "premium", "admin"],
  triggers: ["hibana"],
};

async function mockApi(page: Page, retainSettings = false) {
  const settingsByPath = new Map<string, Record<string, unknown>>();
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const body =
      request.method() === "PATCH" || request.method() === "POST"
        ? request.postDataJSON()
        : undefined;
    if (body) writes.push({ path, body });
    let data: unknown;
    if (path === "/api/me")
      data = {
        id: "1",
        username: "xuanling",
        avatar: null,
        role: "admin",
        can_manage_users: true,
      };
    else if (path === "/api/guilds") data = { guilds };
    else if (path === "/api/catalog") data = catalog;
    // The models page also lists ChatGPT master accounts.
    else if (path === "/api/chatgpt/accounts") data = { accounts: [] };
    else if (path.endsWith("/settings")) {
      const saved = { ...emptyGuild(), selection: { provider: "deepseek", model: "DeepSeek V4", effort: "max" }, ...(retainSettings ? settingsByPath.get(path) : {}), ...body };
      settingsByPath.set(path, saved);
      data = { settings: saved };
    }
    else if (path.endsWith("/skills"))
      data = {
        skills: [
          {
            guild_id: "100",
            name: path.includes("200") ? "importable-skill" : "code-review",
            description: "変更内容を確認し、品質と保守性を評価します。",
            builtin: false,
            enabled: true,
            files: { "SKILL.md": btoa("# Code review\n\nReview changes.") },
          },
        ],
        commands: [],
      };
    else if (path.endsWith("/artifacts"))
      data = {
        sites: [
          {
            token: "example",
            guild_id: "100",
            channel_id: "100",
            url: "https://example.com/published/research-report",
            source_path: "research/report.html",
            created_at_unix: 1788652800,
            updated_at_unix: null,
            expires_at_unix: 1788825600,
            retention: "ttl",
            bytes: 1024,
            file_count: 1,
            permanent: false,
            pending: null,
          },
        ],
      };
    else if (path === "/api/users")
      data = {
        users: [
          { discord_id: "2", username: "workspace-member", role: "user" },
        ],
        assignable: ["user", "premium"],
      };
    else throw new Error(`Unexpected API request: ${path}`);
    await route.fulfill({ json: data });
  });
  return writes;
}

// Give each viewport/scope its own browser context and timeout. Reload checks
// across all four combinations can exceed 30 seconds on shared CI runners.
for (const [url, path, scope] of [
  ["/g/100", "/api/guilds/100/settings", "guild"],
  ["/me", "/api/me/settings", "personal"],
] as const) {
  for (const width of [1440, 390]) {
    test(`Jev modes toggle independently and persist: ${scope}, ${width}px`, async ({ page }) => {
      const writes = await mockApi(page, true);
      await page.setViewportSize({ width, height: 900 });
      await page.goto(url);
      for (const [name, key] of [["Jev 判定", "jev_enabled"], ["Jev 行動選択モード", "jev_task_enabled"]] as const) {
        const control = page.getByRole("group", { name, exact: true });
        const other = page.getByRole("group", { name: name === "Jev 判定" ? "Jev 行動選択モード" : "Jev 判定", exact: true });
        const initial = key === "jev_enabled";
        await expect(control.getByRole("button", { name: initial ? "ON" : "OFF", exact: true })).toHaveAttribute("aria-pressed", "true");
        await expect(control.getByRole("button")).toHaveCount(scope === "personal" ? 3 : 2);
        for (const value of [!initial, initial]) {
          const label = value ? "ON" : "OFF";
          const count = writes.length;
          await control.getByRole("button", { name: label, exact: true }).click();
          await expect(control.getByRole("button", { name: label, exact: true })).toHaveAttribute("aria-pressed", "true");
          await expect.poll(() => writes.slice(count).some((w) => w.path === path && w.body[key] === value)).toBe(true);
          await expect(other.getByRole("button", { name: initial ? "OFF" : "ON", exact: true })).toHaveAttribute("aria-pressed", "true");
          await page.reload();
          await expect(control.getByRole("button", { name: label, exact: true })).toHaveAttribute("aria-pressed", "true");
        }
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });
  }
}

test("personal defaults follow the server until a control is changed", async ({ page }) => {
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  let settings: Record<string, unknown> = {
    selection: null,
    effort: null,
    service_tier: null,
    subagent_enabled: null,
    ultra_mode: null,
    multi_agent: null,
    multi_agent_roles: null,
    subagent_model: null,
    subagent_effort: null,
    jev_enabled: null,
    jev_task_enabled: null,
    context: null,
  };
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const body = request.method() === "PATCH" ? request.postDataJSON() : undefined;
    if (body) {
      writes.push({ path, body });
      settings = { ...settings, ...body };
      if (body.preset === "reset") settings = { ...settings, selection: null, effort: null };
      if (typeof body.preset === "string" && body.preset !== "reset") {
        const preset = catalog.presets.find((p) => p.id === body.preset);
        if (preset) settings.selection = { provider: preset.provider, model: preset.model, effort: "max" };
      }
      if (body.effort !== undefined) settings.effort = body.effort;
    }
    const data = path === "/api/me"
      ? { id: "1", username: "xuanling", avatar: null, role: "admin", can_manage_users: true }
      : path === "/api/catalog"
        ? catalog
        : path === "/api/me/settings"
          ? { settings }
          : { guilds };
    await route.fulfill({ json: data });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/me");
  const mode = page.getByRole("radiogroup", { name: "サブエージェント", exact: true });
  await expect(mode.getByRole("radio", { name: /^デフォルト/ })).toHaveAttribute("aria-checked", "true");
  // The model follows the server: the card says so, and the picker has デフォルト chosen.
  await expect(page.locator('[data-row="me-preset"] .model-card')).toContainText("デフォルト");
  await page.getByRole("button", { name: "モデルを変更" }).click();
  await expect(page.getByRole("dialog", { name: "モデルを選ぶ" }).getByRole("button", { name: /^デフォルト/ })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("group", { name: "Jev 判定" }).getByRole("button", { name: "デフォルト", exact: true })).toHaveAttribute("aria-pressed", "true");
  await mode.getByRole("radio", { name: /^multi/ }).click();
  await expect.poll(() => writes.some((w) => w.body.multi_agent === true && w.body.subagent_enabled === true)).toBe(true);
  await expect(page.getByText("役割ごとの設定はサーバーに従っています。")).toBeVisible();
  await mode.getByRole("radio", { name: /^デフォルト/ }).click();
  await expect.poll(() => writes.some((w) => w.body.subagent_enabled === null && w.body.ultra_mode === null && w.body.multi_agent === null)).toBe(true);
  await page.getByRole("group", { name: "Jev 判定" }).getByRole("button", { name: "OFF", exact: true }).click();
  await expect.poll(() => writes.some((w) => w.body.jev_enabled === false)).toBe(true);
  await page.getByRole("group", { name: "Jev 判定" }).getByRole("button", { name: "デフォルト", exact: true }).click();
  await expect.poll(() => writes.some((w) => w.path === "/api/me/settings" && w.body.jev_enabled === null)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 390, height: 900 });
  await page.reload();
  await expect(mode.getByRole("radio", { name: /^デフォルト/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("MCP endpoint and enable setting save on desktop and mobile", async ({
  page,
}) => {
  const writes = await mockApi(page);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    // The link from the one-page layout still works: it lands on the page that now holds MCP.
    await page.goto("/g/100#mcp");
    await expect(page).toHaveURL(/\/g\/100\/tools#mcp$/);
    await page.reload();
    await expect(page.getByRole("link", { name: "速度 / 検証" })).toHaveCount(0);
    await expect(page.locator("#runtime")).toHaveCount(0);
    await expect(page.getByRole("group", { name: "fast" })).toHaveCount(0);
    await expect(page.getByRole("group", { name: "verify" })).toHaveCount(0);
    const input = page.getByRole("textbox", { name: "MCP サーバー URL" });
    await expect(input).toHaveValue("https://ww.hsincode.com/api/mcp");
    await input.fill(`https://example.com/mcp-${width}`);
    await input.press("Tab");
    await expect
      .poll(() =>
        writes.some(
          (write) => write.body.mcp_url === `https://example.com/mcp-${width}`,
        ),
      )
      .toBe(true);
    await page
      .locator("#mcp")
      .getByRole("button", { name: "OFF", exact: true })
      .click();
    await expect
      .poll(() => writes.some((write) => write.body.mcp_enabled === false))
      .toBe(true);
    await page.locator("#mcp").scrollIntoViewIfNeeded();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/mcp-${width}.png`,
      animations: "disabled",
    });
  }
});

test("responsive pages, theme persistence, and account menu", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await mockApi(page);
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const path of [
      "/",
      "/g/100",
      "/me",
      "/skills",
      "/artifacts",
      "/models",
      "/users",
    ]) {
      await page.goto(path);
      await expect(page.locator("h1")).toBeVisible();
      await expect(page.locator(".skeleton")).toHaveCount(0);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
    await page.goto("/");
    await page.screenshot({
      path: `test-results/servers-${width}.png`,
      fullPage: true,
      animations: "disabled",
    });
  }
  await page.getByRole("button", { name: "ナビゲーションを開く" }).click();
  await page
    .getByRole("navigation", { name: "メイン", exact: true })
    .getByRole("link", { name: "スキル" })
    .click();
  await expect(
    page.getByRole("navigation", { name: "メイン", exact: true }),
  ).toBeHidden();
  await page.getByRole("button", { name: "外観を変更" }).click();
  await page.getByRole("menuitemradio", { name: "ダーク" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.screenshot({
    path: "test-results/skills-dark-mobile.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "アカウントメニュー" }).click();
  await expect(
    page.getByRole("menuitem", { name: "ログアウト" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "アカウントメニュー" }),
  ).toBeFocused();
  expect(errors).toEqual([]);
});

test("dropdown selection saves and nested modal dropdown restores focus", async ({
  page,
}) => {
  const writes = await mockApi(page);
  await page.goto("/g/100");
  await expect(page.locator("#advisor, #routing, #router")).toHaveCount(0);
  await expect(page.getByText(/Advisor|ルーティング/)).toHaveCount(0);
  const effort = page.getByRole("combobox", { name: "effort", exact: true });
  await effort.click();
  await page.getByRole("option", { name: "high", exact: true }).click();
  await expect
    .poll(() => writes.some((write) => write.body.effort === "high"))
    .toBe(true);
  await expect(effort).toBeFocused();
  await page.screenshot({ path: "test-results/settings.png", fullPage: true });
  await page.goto("/skills");
  const trigger = page.getByRole("button", { name: "インポート", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "他サーバーからインポート" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("combobox").first().click();
  await page.getByRole("option", { name: "開発コミュニティ" }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("combobox").last()).toBeEnabled();
  await dialog.getByRole("combobox").last().click();
  await expect(
    page.getByRole("option", { name: "importable-skill" }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/import-dropdown.png",
    animations: "disabled",
  });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  await trigger.click();
  await dialog.getByRole("combobox").last().click();
  await expect(
    page.getByRole("option", { name: "importable-skill" }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/import-mobile.png",
    animations: "disabled",
  });
  await page.getByRole("option", { name: "importable-skill" }).click();
  await dialog.getByRole("button", { name: "コピー", exact: true }).click();
  await expect
    .poll(() =>
      writes.some(
        (write) =>
          write.body.action === "import" &&
          write.body.source_guild_id === "200" &&
          write.body.name === "importable-skill",
      ),
    )
    .toBe(true);
  await expect(dialog).toBeHidden();
  await page.getByRole("button", { name: "code-review を削除" }).click();
  await page.getByRole("button", { name: "キャンセル" }).click();
  expect(writes.some((write) => write.body.action === "delete")).toBe(false);
});

test("login and keyboard dropdown navigation", async ({ page }) => {
  await page.route("**/api/**", (route) =>
    route.fulfill({ status: 401, json: { error: "Unauthorized" } }),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/login");
  await expect(
    page.getByRole("link", { name: "Discord でログイン" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "外観を変更" }).focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Home");
  await page.keyboard.press("Enter");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.screenshot({ path: "test-results/login-mobile.png" });
});

test("capture review gallery", async ({ page }) => {
  test.skip(
    process.env.CAPTURE_GALLERY !== "1",
    "Run with CAPTURE_GALLERY=1 to export the complete review gallery.",
  );
  test.setTimeout(180_000);
  await mockApi(page);
  const directory = "test-results/gallery";
  await mkdir(directory, { recursive: true });
  const manifest: { group: string; title: string; file: string }[] = [];
  let group = "";
  async function capture(name: string, title: string, fullPage = true) {
    const file = `${group}-${name}.png`;
    await page.screenshot({
      path: `${directory}/${file}`,
      fullPage,
      animations: "disabled",
    });
    manifest.push({ group, title, file });
  }
  const routes = [
    ["servers", "/", "サーバー一覧"],
    ["guild-agent", "/g/100", "サーバー設定: エージェント"],
    ["guild-tools", "/g/100/tools", "サーバー設定: ツールと挙動"],
    ["guild-context", "/g/100/context", "サーバー設定: コンテキスト"],
    ["guild-artifacts", "/g/100/artifacts", "サーバー設定: 成果物"],
    ["personal-settings", "/me", "マイ設定"],
    ["skills", "/g/100/skills", "サーバー設定: スキル"],
    ["artifacts", "/artifacts", "成果物一覧"],
    ["models", "/models", "モデル管理"],
    ["users", "/users", "ユーザー管理"],
    ["not-found", "/not-found", "404"],
  ];
  for (const theme of ["light", "dark"]) {
    for (const device of ["desktop", "mobile"]) {
      group = `${theme}-${device}`;
      await page.setViewportSize(
        device === "desktop"
          ? { width: 1440, height: 1000 }
          : { width: 390, height: 844 },
      );
      await page.goto("/");
      await page.evaluate(
        (theme) => localStorage.setItem("hibana-theme", theme),
        theme,
      );
      for (const [name, path, title] of routes) {
        await page.goto(path);
        await expect(
          page.locator("h1"),
        ).toBeVisible();
        await expect(page.locator(".skeleton")).toHaveCount(0);
        if (path === "/g/100/skills")
          await expect(
            page.getByRole("button", { name: "code-review", exact: true }),
          ).toBeVisible();
        await capture(name, title);
      }
      const unauthorized = async (route: import("@playwright/test").Route) =>
        route.fulfill({ status: 401, json: { error: "Unauthorized" } });
      await page.route("**/api/me", unauthorized);
      await page.goto("/login");
      await expect(
        page.getByRole("link", { name: "Discord でログイン" }),
      ).toBeVisible();
      await capture("login", "ログイン");
      await page.unroute("**/api/me", unauthorized);
    }
  }
  for (const device of ["desktop", "mobile"]) {
    const theme = device === "desktop" ? "light" : "dark";
    group = `overlays-${device}`;
    await page.setViewportSize(
      device === "desktop"
        ? { width: 1440, height: 1000 }
        : { width: 390, height: 844 },
    );
    await page.evaluate(
      (theme) => localStorage.setItem("hibana-theme", theme),
      theme,
    );
    await page.goto("/");
    await page.getByRole("button", { name: "外観を変更" }).click();
    await expect(page.getByRole("menu")).toBeVisible();
    await capture("theme", "外観メニュー", false);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "アカウントメニュー" }).click();
    await expect(page.getByRole("menu")).toBeVisible();
    await capture("account", "アカウントメニュー", false);
    await page.keyboard.press("Escape");
    if (device === "mobile") {
      await page.getByRole("button", { name: "ナビゲーションを開く" }).click();
      await capture("navigation", "モバイルナビゲーション", false);
    }
    await page.goto("/g/100");
    await expect(page.locator("#advisor, #routing, #router")).toHaveCount(0);
    await expect(page.getByText(/Advisor|ルーティング/)).toHaveCount(0);
    const effort = page.getByRole("combobox", { name: "effort", exact: true });
    await effort.click();
    await expect(
      page.getByRole("option", { name: "high", exact: true }),
    ).toBeVisible();
    await capture("select", "設定ドロップダウン", false);
    await page.getByRole("option", { name: "high", exact: true }).click();
    await expect(page.locator(".topbar").getByRole("status")).toContainText("保存済み");
    await capture("saved", "保存の表示", false);
    await page.getByRole("button", { name: "検索・移動（コマンドパレット）" }).click();
    await expect(page.getByRole("dialog", { name: "コマンドパレット" })).toBeVisible();
    await capture("palette", "コマンドパレット", false);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "モデルを変更" }).click();
    await expect(page.getByRole("dialog", { name: "モデルを選ぶ" })).toBeVisible();
    await capture("model-picker", "モデルを選ぶダイアログ", false);
    await page.keyboard.press("Escape");
    await page.goto("/g/100/skills");
    await page.getByRole("button", { name: "作成", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await capture("create-skill", "スキル作成ダイアログ", false);
    await page.getByRole("button", { name: "閉じる", exact: true }).click();
    await page.getByRole("button", { name: "インポート", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await capture("import-skill", "スキルインポートダイアログ", false);
    await dialog
      .getByRole("combobox", { name: "コピー元サーバー", exact: true })
      .click();
    await expect(
      page.getByRole("option", { name: "開発コミュニティ" }),
    ).toBeVisible();
    await capture("nested-select", "ダイアログ内ドロップダウン", false);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "閉じる", exact: true }).click();
    await page
      .getByRole("button", { name: "code-review", exact: true })
      .click();
    await expect(dialog).toBeVisible();
    await capture("preview-skill", "スキルプレビューダイアログ", false);
    await page.getByRole("button", { name: "閉じる", exact: true }).click();
    await page.getByRole("button", { name: "code-review を削除" }).click();
    await expect(dialog).toBeVisible();
    await capture("delete-skill", "スキル削除確認ダイアログ", false);
    await page.getByRole("button", { name: "キャンセル", exact: true }).click();
  }
  await writeFile(
    `${directory}/manifest.json`,
    JSON.stringify(manifest, null, 2),
  );
});


test("subagent model and effort policies save independently on desktop and mobile", async ({ page }) => {
  const writes = await mockApi(page, true);
  for (const [url, path, width] of [["/g/100", "/api/guilds/100/settings", 1440], ["/me", "/api/me/settings", 390]] as const) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(url);
    await expect(page.locator("body")).not.toContainText("継承");
    for (const [label, mode] of [["同一（親エージェントと同じ）", "same"], ["任意（エージェントが選択）", "auto"], ["固定（指定したモデル）", "fixed"]] as const) {
      await page.getByRole("combobox", { name: "サブエージェントのモデル選択方式" }).click();
      await page.getByRole("option", { name: label, exact: true }).click();
      await expect.poll(() => writes.some(w => w.path === path && (w.body.subagent_model as { mode?: string })?.mode === mode)).toBe(true);
    }
    await page.getByRole("button", { name: /^固定モデル:/ }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: /GPT/ }).click();
    await expect.poll(() => writes.some(w => w.path === path && (w.body.subagent_model as { preset?: string })?.preset === "gpt")).toBe(true);
    await page.getByRole("combobox", { name: "サブエージェントの effort 選択方式" }).click();
    await page.getByRole("option", { name: "固定（指定した effort）", exact: true }).click();
    await page.getByRole("combobox", { name: "サブエージェントの固定 effort" }).click();
    await page.getByRole("option", { name: "high", exact: true }).click();
    await expect.poll(() => writes.some(w => w.path === path && (w.body.subagent_effort as { effort?: string })?.effort === "high")).toBe(true);
    await expect(page.getByRole("button", { name: /^固定モデル:/ })).toContainText("GPT");
    for (const label of ["任意（エージェントが選択）", "同一（親エージェントと同じ）"]) {
      await page.getByRole("combobox", { name: "サブエージェントの effort 選択方式" }).click();
      await page.getByRole("option", { name: label, exact: true }).click();
      await expect(page.getByRole("combobox", { name: "サブエージェントの固定 effort" })).toHaveCount(0);
    }
    for (const name of ["サブエージェントのモデル選択方式", "サブエージェントの effort 選択方式"]) {
      await page.getByRole("combobox", { name, exact: true }).click();
      await page.getByRole("option", { name: "任意（エージェントが選択）", exact: true }).click();
    }
    await expect.poll(() => writes.some(w => w.path === path && (w.body.subagent_model as { mode?: string })?.mode === "auto")).toBe(true);
    await expect.poll(() => writes.some(w => w.path === path && (w.body.subagent_effort as { mode?: string })?.mode === "auto")).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});

for (const [url, path, scope] of [
  ["/g/100", "/api/guilds/100/settings", "guild"],
  ["/me", "/api/me/settings", "personal"],
] as const) {
  for (const width of [1440, 390]) {
    test(`Subagent modes preserve selected effort and Jev settings: ${scope}, ${width}px`, async ({ page }) => {
      const writes = await mockApi(page, true);
      await page.setViewportSize({ width, height: 900 });
      await page.goto(url);
      const mode = page.getByRole("radiogroup", { name: "サブエージェント", exact: true });
      const effort = page.getByRole("combobox", { name: "effort", exact: true });
      await expect(mode.getByRole("radio", { checked: true })).toHaveText(/^on/);
      await effort.click();
      await expect(page.getByRole("option", { name: "ultra", exact: true })).toHaveCount(0);
      await page.getByRole("option", { name: "low", exact: true }).click();
      await expect.poll(() => writes.some(w => w.path === path && w.body.effort === "low")).toBe(true);
      for (const [label, enabled, ultra, multi] of [
        ["ultra", true, true, false],
        ["multi", true, true, true],
        ["off", false, false, false],
        ["on", true, false, false],
      ] as const) {
        const count = writes.length;
        await mode.getByRole("radio", { name: new RegExp(`^${label}`) }).click();
        // Every choice writes all three switches, so leaving multi clears it.
        await expect.poll(() => writes.slice(count).some(w => w.path === path && w.body.ultra_mode === ultra &&
          w.body.subagent_enabled === enabled && w.body.multi_agent === multi)).toBe(true);
        await page.reload();
        await expect(mode.getByRole("radio", { checked: true })).toHaveText(new RegExp(`^${label}`));
        // Role overrides only exist for the Multi-Agent team.
        await expect(page.getByRole("combobox", { name: "検証のモデル" })).toHaveCount(multi ? 1 : 0);
        await expect(effort).toHaveText("low");
        for (const name of ["Jev 判定", "Jev 行動選択モード"])
          await expect(page.getByRole("group", { name, exact: true }).getByRole("button", { name: name === "Jev 判定" ? "ON" : "OFF", exact: true })).toHaveAttribute("aria-pressed", "true");
      }
      await mode.getByRole("radio", { name: /^multi/ }).click();
      await expect(page.getByText("サブエージェントが multi のときは並列の分担を優先するため使用しません。", { exact: false })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });
  }
}

test("guild settings show the authorized server name and icon on direct navigation", async ({ page }) => {
  await mockApi(page);
  await page.route("**/api/guilds", route => route.fulfill({ json: { guilds: [
    { ...guilds[0], icon: "fixture-icon" }, guilds[1],
  ] } }));
  await page.route("https://cdn.discordapp.com/icons/**", route => route.fulfill({
    contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="48" height="48" fill="blue"/></svg>',
  }));
  await page.goto("/g/100");
  await expect(page.getByRole("heading", { name: "Design workspace", exact: true })).toBeVisible();
  await expect(page.locator(".guild-heading img")).toHaveAttribute("src", /\/icons\/100\/fixture-icon/);
  await expect(page).toHaveTitle(/Design workspace/);
  await page.goto("/g/200");
  await expect(page.getByRole("heading", { name: "開発コミュニティ", exact: true })).toBeVisible();
  await expect(page.locator(".guild-heading .avatar")).toHaveText("開");
});

for (const [url, path] of [["/g/100", "/api/guilds/100/settings"], ["/me", "/api/me/settings"]]) {
  test(`Service Tier saves and survives reload: ${url}`, async ({ page }) => {
    const writes = await mockApi(page, true);
    await page.goto(url!);
    const tier = page.getByRole("combobox", { name: "Service Tier", exact: true });
    await expect(tier).toHaveText("auto");
    for (const value of ["priority", "flex", "ultrafast", "default", "auto"]) {
      const count = writes.length;
      await tier.click();
      await page.getByRole("option", { name: value, exact: true }).click();
      await expect.poll(() => writes.slice(count).some(w => w.path === path && w.body.service_tier === value)).toBe(true);
      await page.reload();
      await expect(tier).toHaveText(value);
    }
  });
}

for (const [url, path, width] of [["/g/100", "/api/guilds/100/settings", 1440], ["/me", "/api/me/settings", 390]] as const)
  test(`Multi-Agent role overrides save per role and show the effective model: ${width}px`, async ({ page }) => {
    const writes = await mockApi(page, true);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(url);
    await page.getByRole("radiogroup", { name: "サブエージェント" }).getByRole("radio", { name: /^multi/ }).click();
    // Only the reviewer on another model: the others keep the common policy.
    await page.getByRole("combobox", { name: "検証のモデル" }).click();
    await page.getByRole("option", { name: "固定", exact: true }).click();
    await page.getByRole("button", { name: /^検証の固定モデル:/ }).click();
    await page.getByRole("dialog").getByRole("button", { name: /Claude Opus/ }).click();
    await expect.poll(() => writes.some(w => w.path === path &&
      JSON.stringify((w.body.multi_agent_roles as Record<string, unknown>)?.reviewer) === JSON.stringify({ model: { mode: "fixed", preset: "claude" }, effort: { mode: "default" } }))).toBe(true);
    await expect(page.getByLabel("検証の実際の設定")).toContainText("Claude Opus");
    await expect(page.getByLabel("作成の実際の設定")).toContainText("DeepSeek V4（任意）");
    await page.getByRole("combobox", { name: "調査の effort" }).click();
    await page.getByRole("option", { name: "固定", exact: true }).click();
    await page.getByRole("combobox", { name: "調査の固定 effort" }).click();
    await page.getByRole("option", { name: "low", exact: true }).click();
    await expect(page.getByLabel("調査の実際の設定")).toContainText("low");
    const last = writes.filter(w => w.path === path && w.body.multi_agent_roles).at(-1)!.body.multi_agent_roles as Record<string, { model: { mode: string } }>;
    // The reviewer override survives the explorer edit.
    expect(last.reviewer!.model.mode).toBe("fixed");
    await page.reload();
    await expect(page.getByLabel("検証の実際の設定")).toContainText("Claude Opus");
    await page.getByRole("combobox", { name: "検証のモデル" }).click();
    await page.getByRole("option", { name: "親と同じ", exact: true }).click();
    await expect(page.getByLabel("検証の実際の設定")).toContainText("DeepSeek V4");
    await expect(page.getByRole("button", { name: /^検証の固定モデル:/ })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

/* ============================================================
   Layout introduced with the redesign (#61): five pages per server,
   the command palette, the server switcher and how a save is shown.
   ============================================================ */

test("server settings are split into five pages, reachable from the sidebar and the tab strip", async ({ page }) => {
  await mockApi(page);
  let settingsReads = 0;
  page.on("request", (request) => {
    if (request.method() === "GET" && new URL(request.url()).pathname === "/api/guilds/100/settings") settingsReads += 1;
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/g/100");
  const nav = page.getByRole("navigation", { name: "メイン", exact: true });
  const tabs = page.getByRole("navigation", { name: "サーバーのページ" });
  // One heading that only that page has.
  const headings: Record<string, string> = {
    "": "/switch モデル", tools: "MCP", context: "サーバーコンテキスト", skills: "スキル", artifacts: "成果物",
  };
  await expect(page.getByRole("heading", { name: "/switch モデル", level: 2 })).toBeVisible();
  const readsAfterLoad = settingsReads;
  await expect(tabs).toBeHidden();
  for (const p of GUILD_PAGES) {
    const link = nav.getByRole("link", { name: p.label, exact: true });
    await link.click();
    await expect(page).toHaveURL(new RegExp(`${guildPath("100", p.path)}$`));
    await expect(link).toHaveAttribute("aria-current", "page");
    await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);
    await expect(page.getByRole("heading", { name: "Design workspace", level: 1 })).toBeVisible();
    await expect(page.getByRole("heading", { name: headings[p.path]!, level: 2, exact: true })).toBeVisible();
    await expect(page).toHaveTitle(`Design workspace · ${p.label} · Hibana`);
  }
  // The pages share one copy of the settings: moving between them does not load it again.
  expect(settingsReads).toBe(readsAfterLoad);

  // Narrow screens: the sidebar is a drawer, so the same five pages are a tab strip.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(nav).toBeHidden();
  await expect(tabs.getByRole("link")).toHaveText(GUILD_PAGES.map((p) => p.label));
  await tabs.getByRole("link", { name: "ツールと挙動" }).click();
  await expect(page).toHaveURL(/\/g\/100\/tools$/);
  await expect(tabs.getByRole("link", { name: "ツールと挙動" })).toHaveAttribute("aria-current", "page");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

// The first of the five pages is covered with the other routes in "responsive pages";
// the four new ones get their own test so that one stays within its time on CI (#56).
test("the pages split off from server settings fit every width", async ({ page }) => {
  await mockApi(page);
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const p of GUILD_PAGES.filter((p) => p.path !== "")) {
      await page.goto(guildPath("100", p.path));
      await expect(page.getByRole("heading", { name: "Design workspace", level: 1 })).toBeVisible();
      await expect(page.locator(".skeleton")).toHaveCount(0);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        `${p.label} at ${width}px`,
      ).toBe(true);
    }
  }
});

test("links from the one-page layout and the old skills page lead to where the content now lives", async ({ page }) => {
  await mockApi(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const [from, to, section] of [
    ["/g/100#mcp", "/g/100/tools#mcp", "mcp"],
    ["/g/100#triggers", "/g/100/tools#triggers", "triggers"],
    ["/g/100#context", "/g/100/context#context", "context"],
    ["/g/100#artifacts", "/g/100/artifacts#artifacts", "artifacts"],
    // Sections that stayed on the first page keep their anchors.
    ["/g/100#jev", "/g/100#jev", "jev"],
  ] as const) {
    await page.goto(from);
    await expect(page).toHaveURL(new RegExp(`${to}$`));
    await expect(page.locator(`#${section}`)).toBeInViewport();
  }
  // /skills used to ask for a server; it now opens the server last looked at.
  await page.goto("/g/200");
  await expect(page.getByRole("heading", { name: "開発コミュニティ", level: 1 })).toBeVisible();
  await page.goto("/skills");
  await expect(page).toHaveURL(/\/g\/200\/skills$/);
  await expect(page.getByRole("button", { name: "importable-skill", exact: true })).toBeVisible();
  await page.goto("/g/100/unknown");
  await expect(page.getByRole("heading", { name: "ページが見つからない" })).toBeVisible();
});

test("command palette reaches servers, pages and every listed setting from the keyboard", async ({ page }) => {
  test.setTimeout(60_000);
  await mockApi(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/g/100");
  await expect(page.getByRole("heading", { name: "/switch モデル", level: 2 })).toBeVisible();
  const opener = page.getByRole("button", { name: "検索・移動（コマンドパレット）" });
  const palette = page.getByRole("dialog", { name: "コマンドパレット" });
  const input = palette.getByRole("combobox");

  await page.keyboard.press("Control+k");
  await expect(input).toBeFocused();
  // A setting: lands on its page with the row marked and its control focused.
  await input.fill("exa");
  await expect(palette.getByRole("option")).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(palette).toBeHidden();
  await expect(page).toHaveURL(/\/g\/100\/tools$/);
  await expect(page.locator('[data-row="g-exa"]')).toHaveClass(/is-target/);
  await expect(page.getByRole("combobox", { name: "exa", exact: true })).toBeFocused();

  // The arrow keys move through the candidates and wrap at the ends.
  await opener.click();
  const options = palette.getByRole("option");
  await input.fill("サーバー");
  await expect(options.first()).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowDown");
  await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(palette.locator('[aria-selected="true"]')).toHaveCount(1);
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(options.last()).toHaveAttribute("aria-selected", "true");
  // A server.
  await input.fill("開発");
  await expect(options).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/g\/200$/);
  await expect(page.getByRole("heading", { name: "開発コミュニティ", level: 1 })).toBeVisible();
  await expect(page.locator("#main-content")).toBeFocused();

  // Pages the account may not open are not offered (this account cannot see 利用料).
  await page.keyboard.press("Control+k");
  await input.fill("ユーザー");
  await expect(palette.getByRole("option", { name: /^ユーザー/ })).toHaveCount(1);
  await input.fill("利用料");
  await expect(palette.getByRole("option")).toHaveCount(0);
  await expect(palette.getByText("一致するものがありません。")).toBeVisible();
  // Escape closes it and hands focus back to where it was; so does the shortcut.
  await page.keyboard.press("Escape");
  await expect(palette).toBeHidden();
  await expect(page.locator("#main-content")).toBeFocused();
  await opener.click();
  await page.keyboard.press("Control+k");
  await expect(palette).toBeHidden();
  await expect(opener).toBeFocused();

  // Every setting the palette lists exists on the page it points to.
  await page.goto("/g/100");
  for (const setting of GUILD_SETTINGS) {
    await page.keyboard.press("Control+k");
    await input.fill(setting.label);
    await palette.getByRole("option").filter({ hasText: "›" }).filter({ hasText: setting.label }).first().click();
    await expect(page).toHaveURL(new RegExp(`${guildPath("100", setting.page)}$`));
    await expect(page.locator(`[data-row="${setting.row}"]`), setting.label).toBeVisible();
  }
});

test("the server switcher filters by name or ID and keeps the kind of page", async ({ page }) => {
  await mockApi(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/g/100/tools");
  const switcher = page.getByRole("button", { name: /^サーバーを切り替える/ });
  await expect(switcher).toContainText("Design workspace");
  await switcher.click();
  const search = page.getByRole("combobox", { name: "サーバーを探す" });
  await expect(search).toBeFocused();
  await expect(page.getByRole("option")).toHaveCount(3);
  await search.fill("200");
  await expect(page.getByRole("option")).toHaveCount(1);
  await expect(page.getByRole("option", { name: "開発コミュニティ" })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/g\/200\/tools$/);
  await expect(page.getByRole("heading", { name: "開発コミュニティ", level: 1 })).toBeVisible();
  await expect(switcher).toContainText("開発コミュニティ");
  await expect(switcher).toBeFocused();
  // Escape and a click elsewhere close it without moving.
  await switcher.click();
  await page.keyboard.press("Escape");
  await expect(search).toBeHidden();
  await expect(switcher).toBeFocused();
  await switcher.click();
  await page.getByRole("heading", { name: "MCP", level: 2 }).click();
  await expect(search).toBeHidden();
  await expect(page).toHaveURL(/\/g\/200\/tools$/);

  // In the drawer, Escape closes the switcher first and the drawer second.
  await page.setViewportSize({ width: 390, height: 844 });
  const toggle = page.getByRole("button", { name: "ナビゲーションを開く" });
  await toggle.click();
  await expect(switcher).toBeFocused();
  await switcher.click();
  await page.keyboard.press("Escape");
  await expect(search).toBeHidden();
  await expect(page.getByRole("navigation", { name: "メイン", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("navigation", { name: "メイン", exact: true })).toBeHidden();
  await expect(toggle).toBeFocused();
});

test("a save shows on the row and in the top bar, and a failed save rolls the control back", async ({ page }) => {
  const writes = await mockApi(page, true);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/g/100");
  const status = page.locator(".topbar").getByRole("status");
  const effort = page.getByRole("combobox", { name: "effort", exact: true });
  const mark = page.locator('[data-row="g-effort"] .row-mark');
  const strip = page.getByRole("region", { name: "実際の動作" });
  await expect(status).toHaveText("変更は自動保存されます");
  await expect(mark).toBeEmpty();

  await effort.click();
  await page.getByRole("option", { name: "high", exact: true }).click();
  await expect(status).toContainText("保存済み");
  // Only an upper bound is promised: nothing tells the dashboard when the bot picked it up.
  await expect(status).toContainText("bot への反映は最大 30 秒");
  await expect(mark).toHaveText("保存済み");
  await expect(strip).toContainText("high");
  // Success is not a toast any more.
  await expect(page.locator(".toast")).toHaveCount(0);

  // Leaving a field without changing it writes nothing.
  await page.getByRole("navigation", { name: "メイン", exact: true }).getByRole("link", { name: "ツールと挙動" }).click();
  const before = writes.length;
  await page.getByRole("textbox", { name: "MCP サーバー URL" }).focus();
  await page.keyboard.press("Tab");
  await page.getByRole("spinbutton", { name: "temperature" }).focus();
  await page.keyboard.press("Tab");
  await page.locator("#mcp").getByRole("button", { name: "OFF", exact: true }).click();
  await expect.poll(() => writes.slice(before).some((w) => w.body.mcp_enabled === false)).toBe(true);
  expect(writes.slice(before).some((w) => "mcp_url" in w.body || "temperature" in w.body)).toBe(false);

  // The API refuses the next change.
  await page.route("**/api/guilds/100/settings", (route) =>
    route.request().method() === "PATCH"
      ? route.fulfill({ status: 500, json: { error: "書き込めませんでした" } })
      : route.fallback());
  const exa = page.getByRole("combobox", { name: "exa", exact: true });
  await expect(exa).toHaveText("auto");
  await exa.click();
  await page.getByRole("option", { name: "off", exact: true }).click();
  await expect(status).toHaveText("保存に失敗");
  await expect(exa).toHaveText("auto");
  await expect(page.locator('[data-row="g-exa"] .row-mark')).toHaveText("保存に失敗");
  await expect(page.locator(".toast.is-danger")).toContainText("書き込めませんでした");
});

test("a slow save for one server never lands on another server's page", async ({ page }) => {
  await mockApi(page, true);
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/guilds/100/settings", async (route) => {
    if (route.request().method() === "PATCH") await held;
    await route.fallback();
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/g/100");
  const status = page.locator(".topbar").getByRole("status");
  const effort = page.getByRole("combobox", { name: "effort", exact: true });
  await effort.click();
  await page.getByRole("option", { name: "low", exact: true }).click();
  await expect(status).toHaveText("保存中…");

  // Move to another server while the first one's save is still on its way.
  await page.getByRole("button", { name: /^サーバーを切り替える/ }).click();
  await page.getByRole("option", { name: "開発コミュニティ" }).click();
  await expect(page.getByRole("heading", { name: "開発コミュニティ", level: 1 })).toBeVisible();
  await expect(effort).toHaveText("max");
  await expect(status).toHaveText("変更は自動保存されます");

  const answered = page.waitForResponse((response) =>
    response.request().method() === "PATCH" && response.url().endsWith("/api/guilds/100/settings"));
  release();
  await answered;
  // Give the late answer every chance to be drawn before looking.
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  await expect(effort).toHaveText("max");
  await expect(status).toHaveText("変更は自動保存されます");
});

test("実際の動作 shows what a combination of settings does, not just what was saved", async ({ page }) => {
  await mockApi(page);
  let custom: Record<string, unknown> = {};
  await page.route("**/api/guilds/100/settings", (route) =>
    route.fulfill({ json: { settings: { ...emptyGuild(), ...custom } } }));
  await page.setViewportSize({ width: 1440, height: 900 });
  const strip = page.getByRole("region", { name: "実際の動作" });
  const item = (label: string) =>
    strip.locator(".eff-item").filter({ has: page.locator("dt", { hasText: new RegExp(`^${label}$`) }) });
  const unused = (row: string) => page.locator(`[data-row="${row}"]`).getByText("いまは使われません。");

  // Nothing interacts: the saved values are the ones in use.
  await page.goto("/g/100");
  await expect(item("モデル")).toContainText("gpt-6-luna");
  await expect(item("effort")).toHaveText(/^effort\s*max$/);
  await expect(item("サブエージェント")).toContainText("on");
  await expect(page.getByText("いまは使われません。")).toHaveCount(0);

  // Anthropic / Auto: Jev decides the model and effort, and subagents are off whatever was saved.
  custom = { selection: { provider: "anthropic", model: "auto", effort: "high" }, effort: "high", ultra_mode: true, multi_agent: true };
  await page.reload();
  await expect(item("モデル")).toContainText("Jev が会話ごとに選ぶ");
  await expect(item("effort")).toContainText("Jev が決める");
  await expect(item("effort")).toContainText("保存値 high は使われません。");
  await expect(item("サブエージェント")).toContainText("off");
  await expect(item("サブエージェント")).toContainText("保存値 multi");
  await expect(unused("g-effort")).toBeVisible();
  await expect(unused("g-mode")).toBeVisible();
  // The controls stay usable: the saved value applies again under another provider.
  await expect(page.getByRole("combobox", { name: "effort", exact: true })).toBeEnabled();

  // …and with Jev 判定 off, Auto falls back to one fixed model.
  custom = { ...custom, jev_enabled: false };
  await page.reload();
  await expect(item("モデル")).toContainText(AUTO_ROUTE_FALLBACK.model);
  await expect(item("effort")).toContainText(AUTO_ROUTE_FALLBACK.effort);
  await expect(page.locator('[data-row="g-jev"]')).toContainText(`毎回 ${AUTO_ROUTE_FALLBACK.model} / ${AUTO_ROUTE_FALLBACK.effort} で応答します。`);

  // Ultra runs at xhigh and keeps the saved effort for later.
  custom = { effort: "low", selection: { provider: "deepseek", model: "DeepSeek V4", effort: "low" }, ultra_mode: true };
  await page.reload();
  await expect(item("effort")).toContainText("xhigh");
  await expect(item("effort")).toContainText("保存値 low は ultra を外すと使われます。");
  await expect(unused("g-effort")).toBeVisible();

  // Multi does not run the Jev task loop even when it is saved as ON.
  custom = { ultra_mode: true, multi_agent: true, jev_task_enabled: true };
  await page.reload();
  await expect(item("Jev 行動選択")).toContainText("使わない");
  await expect(unused("g-jev-task")).toBeVisible();
  await expect(unused("g-effort")).toHaveCount(0);
});

test("overlays stay inside narrow screens", async ({ page }) => {
  await mockApi(page);
  // scrollWidth only sees the document; fixed overlays have to be measured themselves.
  const fits = async (selector: string) => {
    const box = await page.locator(selector).boundingBox();
    const width = page.viewportSize()!.width;
    expect(box, selector).not.toBeNull();
    expect(box!.x, selector).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width, selector).toBeLessThanOrEqual(width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), selector).toBe(true);
  };
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/g/100");
    await expect(page.getByRole("heading", { name: "/switch モデル", level: 2 })).toBeVisible();
    await page.getByRole("button", { name: "検索・移動（コマンドパレット）" }).click();
    await fits(".palette");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "モデルを変更" }).click();
    await fits(".modal");
    await page.keyboard.press("Escape");
    await page.getByRole("combobox", { name: "effort", exact: true }).click();
    await fits(".select-menu");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "アカウントメニュー" }).click();
    await fits(".pop");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "ナビゲーションを開く" }).click();
    await fits(".side");
    await page.getByRole("button", { name: /^サーバーを切り替える/ }).click();
    await fits(".switcher .pop");
  }
});

test("long names and URLs wrap or scroll inside their own frame", async ({ page }) => {
  await mockApi(page);
  const word = `VeryLongNameWithoutAnySpacesAtAll_${"0123456789_abcdefghijklmnopqrstuvwxyz_".repeat(3)}`;
  await page.route("**/api/guilds", (route) => route.fulfill({ json: { guilds: [
    { id: "100", name: `とても長い名前のサーバー${word}`, icon: null, preset: `model-${word}` },
  ] } }));
  await page.route("**/api/artifacts", (route) => route.fulfill({ json: { sites: [{
    token: "long", guild_id: "100", channel_id: "100",
    url: `https://example.com/published/${"very-long-path-segment/".repeat(8)}index.html`,
    source_path: `${"dir/".repeat(20)}report.html`,
    created_at_unix: 1788652800, updated_at_unix: null, expires_at_unix: 1791244800,
    retention: "month", bytes: 1024, file_count: 1, permanent: false, pending: "unpermanent",
  }] } }));
  await page.route("**/api/users", (route) => route.fulfill({ json: {
    users: [{ discord_id: "123456789012345678901234567890", username: `member-${word}`, role: "user" }],
    assignable: ["user", "premium"],
  } }));
  // 768px is the widest layout where tables are still tables: a column pushed past the
  // frame has to scroll inside it, including its screen-reader-only header text.
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const path of ["/", "/g/100", "/artifacts", "/users"]) {
      await page.goto(path);
      await expect(page.locator("h1")).toBeVisible();
      await expect(page.locator(".skeleton")).toHaveCount(0);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
        `${path} at ${width}px`,
      ).toBeLessThanOrEqual(0);
    }
  }
});

test("motion plays once, and not at all when the OS asks for less", async ({ page }) => {
  await mockApi(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/g/100");
  const block = page.getByRole("region", { name: "実際の動作" });
  await expect(block).toBeVisible();
  const seconds = () => block.evaluate((el) => parseFloat(getComputedStyle(el).animationDuration));
  expect(await seconds()).toBeCloseTo(0.38);
  // Nothing on a loaded page keeps moving by itself.
  const looping = await page.evaluate(() =>
    [...document.querySelectorAll("*")].flatMap((el) =>
      [null, "::before", "::after"].filter((pseudo) => getComputedStyle(el, pseudo).animationIterationCount === "infinite")).length);
  expect(looping).toBe(0);
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await seconds()).toBeLessThan(0.001);
});

test("the two typefaces are served by the app itself", async ({ page, baseURL }) => {
  const hosts = new Set<string>();
  page.on("request", (request) => hosts.add(new URL(request.url()).host));
  await mockApi(page);
  await page.goto("/g/100");
  await expect(page.getByRole("heading", { name: "/switch モデル", level: 2 })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  const loaded = await page.evaluate(() =>
    [...document.fonts].filter((face) => face.status === "loaded").map((face) => face.family.replace(/"/g, "")));
  expect(loaded).toEqual(expect.arrayContaining(["Outfit", "Red Hat Mono"]));
  // No font host, no CDN: every request went to the dashboard's own origin.
  expect([...hosts]).toEqual([new URL(baseURL!).host]);
});

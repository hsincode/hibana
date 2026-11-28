// Decision record #193: server workspace `.tar.gz` export page (`/g/:id/data`).
import { expect, test, type Page } from "@playwright/test";
import { emptyGuild } from "@hibana/shared/settings";

const catalog = {
  presets: [
    {
      id: "deepseek",
      provider: "deepseek",
      model: "DeepSeek V4",
      label: "DeepSeek / DeepSeek V4",
    },
  ],
  efforts: ["low", "medium", "high"],
  exa: ["auto", "off"],
  roles: ["administrator", "moderator", "free"],
  triggers: ["hibana"],
};

const guilds = [
  { id: "100", name: "Design workspace", icon: null, preset: "DeepSeek V4" },
];

type ExportItem = {
  id: number;
  guild_id: string;
  include_settings: boolean;
  created_at: number;
  result:
    | {
        ok: true;
        url?: string;
        filename: string;
        bytes: number;
        file_count: number;
        expires_at_unix: number;
        includes_settings: boolean;
      }
    | { ok: false; error: string }
    | null;
};

async function mockApi(
  page: Page,
  opts: {
    canEdit: boolean;
    initialExports?: ExportItem[];
    onPost?: (body: Record<string, unknown>) => ExportItem;
  },
) {
  let exportsList: ExportItem[] = [...(opts.initialExports ?? [])];
  const posts: Record<string, unknown>[] = [];

  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (path === "/api/me")
      return route.fulfill({
        json: {
          id: "1",
          username: "xuanling",
          avatar: null,
          role: opts.canEdit ? "administrator" : "free",
          can_manage_users: opts.canEdit,
        },
      });
    if (path === "/api/guilds")
      return route.fulfill({
        json: {
          guilds: guilds.map((g) => ({ ...g, can_manage: opts.canEdit })),
        },
      });
    if (path === "/api/catalog") return route.fulfill({ json: catalog });
    if (path === "/api/guilds/100/settings")
      return route.fulfill({
        json: { settings: emptyGuild(), can_edit: opts.canEdit },
      });
    if (path === "/api/guilds/100/exports") {
      if (req.method() === "POST") {
        const body = req.postDataJSON() as Record<string, unknown>;
        posts.push(body);
        const created = opts.onPost
          ? opts.onPost(body)
          : {
              id: exportsList.length + 1,
              guild_id: "100",
              include_settings: Boolean(body.include_settings),
              created_at: Date.now(),
              result: null,
            };
        exportsList = [created, ...exportsList];
        return route.fulfill({ json: { ok: true, command: created } });
      }
      return route.fulfill({
        json: {
          can_edit: opts.canEdit,
          exports: exportsList,
          limits: {
            max_raw_bytes: 1024 * 1024 * 1024,
            max_archive_bytes: 500 * 1024 * 1024,
            ttl_secs: 900,
            cooldown_secs: 60,
          },
        },
      });
    }
    throw new Error(`Unexpected API request: ${path}`);
  });

  return {
    posts,
    setExports: (next: ExportItem[]) => {
      exportsList = next;
    },
  };
}

test("manager requests export with settings JSON and sees download link once ready", async ({
  page,
}) => {
  await page.clock.install();
  const futureUnix = Math.floor(Date.now() / 1000) + 900;
  const state = await mockApi(page, { canEdit: true });

  await page.goto("/g/100/data");
  await expect(
    page.getByRole("heading", { name: "データ", level: 2 }),
  ).toBeVisible();

  await page.getByRole("button", { name: "含める", exact: true }).click();
  await page.getByRole("button", { name: "エクスポートを作成" }).click();

  expect(state.posts).toEqual([{ include_settings: true }]);
  await expect(page.getByText("準備中（bot の同期待ち）")).toBeVisible();

  state.setExports([
    {
      id: 1,
      guild_id: "100",
      include_settings: true,
      created_at: Date.now(),
      result: {
        ok: true,
        url: "https://sites.example.com/dl/deadbeef/hibana-workspace-100.tar.gz",
        filename: "hibana-workspace-100.tar.gz",
        bytes: 2048,
        file_count: 4,
        expires_at_unix: futureUnix,
        includes_settings: true,
      },
    },
  ]);

  await page.clock.runFor(4500);
  const link = page.getByRole("link", { name: "ダウンロード" });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute(
    "href",
    "https://sites.example.com/dl/deadbeef/hibana-workspace-100.tar.gz",
  );
  await expect(link).toHaveAttribute("download", "hibana-workspace-100.tar.gz");
});

test("plain member sees read-only controls and no download link", async ({
  page,
}) => {
  const futureUnix = Math.floor(Date.now() / 1000) + 900;
  await mockApi(page, {
    canEdit: false,
    initialExports: [
      {
        id: 2,
        guild_id: "100",
        include_settings: false,
        created_at: Date.now(),
        result: {
          ok: true,
          filename: "hibana-workspace-100.tar.gz",
          bytes: 1024,
          file_count: 1,
          expires_at_unix: futureUnix,
          includes_settings: false,
        },
      },
    ],
  });

  await page.goto("/g/100/data");
  await expect(
    page.getByRole("button", { name: "エクスポートを作成" }),
  ).toBeDisabled();
  await expect(page.getByRole("link", { name: "ダウンロード" })).toHaveCount(0);
  await expect(page.getByText("管理者のみ取得可")).toBeVisible();
});

test("renders expired and failed export states clearly", async ({ page }) => {
  const pastUnix = Math.floor(Date.now() / 1000) - 60;
  await mockApi(page, {
    canEdit: true,
    initialExports: [
      {
        id: 3,
        guild_id: "100",
        include_settings: false,
        created_at: Date.now() - 120_000,
        result: {
          ok: false,
          error: "このサーバーのワークスペースにファイルがありません。",
        },
      },
      {
        id: 2,
        guild_id: "100",
        include_settings: false,
        created_at: Date.now() - 1_200_000,
        result: {
          ok: true,
          url: "https://sites.example.com/dl/old/hibana-workspace-100.tar.gz",
          filename: "hibana-workspace-100.tar.gz",
          bytes: 1024,
          file_count: 1,
          expires_at_unix: pastUnix,
          includes_settings: false,
        },
      },
    ],
  });

  await page.goto("/g/100/data");
  await expect(page.getByText("失敗")).toBeVisible();
  await expect(
    page.getByText("このサーバーのワークスペースにファイルがありません。"),
  ).toBeVisible();
  await expect(page.getByText("期限切れ")).toBeVisible();
  await expect(page.getByRole("link", { name: "ダウンロード" })).toHaveCount(0);
});

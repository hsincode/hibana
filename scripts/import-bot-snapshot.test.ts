import { describe, expect, test } from "bun:test";
import { createApp } from "../apps/api/src/create-app";
import { loadTestEnv } from "../apps/api/src/env";
import { emptyGuild, emptyUserOverride } from "../apps/api/src/settings";
import { MemoryStore } from "../apps/api/src/store";
import {
  SELECTABLE_PRESETS,
  catalogPublished,
  isPremium,
} from "../packages/shared/src/catalog";
import {
  IMPORT_ACTOR,
  importBotSnapshot,
  presetOverrides,
} from "./import-bot-snapshot";

/** What the bot receives from `GET /internal/snapshot` and keeps on disk. */
async function snapshotOf(store: MemoryStore) {
  const app = createApp(loadTestEnv({ adminIds: ["admin-1"] }), store);
  const res = await app.handle(
    new Request("http://127.0.0.1/internal/snapshot", {
      headers: { authorization: "Bearer test-internal" },
    }),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown> & { version: number };
}

const ids = SELECTABLE_PRESETS.map((p) => p.id);
const publishedByDefault = ids.find((id) => catalogPublished(id))!;
const hiddenByDefault = ids.find((id) => !catalogPublished(id))!;
const premiumByDefault = ids.find((id) => isPremium(id, {}))!;

async function source() {
  const store = new MemoryStore();
  await store.migrate();
  await store.replaceSnapshot(
    {
      g1: {
        ...emptyGuild(),
        thread_only: true,
        mcp_url: "https://example.com/mcp",
      },
      g2: emptyGuild(),
    },
    { u1: { text: "DM の文脈", persona_override: true } },
  );
  await store.putUserOverride("u1", { ...emptyUserOverride(), effort: "high" });
  await store.upsertUser({
    discord_id: "admin-1",
    username: "admin",
    avatar: null,
  });
  await store.upsertUser({ discord_id: "u1", username: "alice", avatar: "a" });
  await store.setUserRole("u1", "premium");
  await store.setBlocked({
    discord_id: "b1",
    username: "spam",
    reason: "spam",
    blocked_by: "admin-1",
    blocked_at: 1,
  });
  await store.setMeta(
    "preset_visibility",
    JSON.stringify({ [publishedByDefault]: false, [hiddenByDefault]: true }),
  );
  await store.setMeta(
    "preset_premium",
    JSON.stringify({ [premiumByDefault]: false }),
  );
  await store.setMeta(
    "budget_fallback",
    JSON.stringify({ preset: "anthropic-haiku-5-5", effort: "low" }),
  );
  return store;
}

describe("importBotSnapshot", () => {
  test("a database restored from the bot's snapshot serves the same snapshot", async () => {
    const before = await snapshotOf(await source());
    const target = new MemoryStore();
    await target.migrate();
    const summary = await importBotSnapshot(target, before, { now: 5 });
    const after = await snapshotOf(target);

    const { version: oldVersion, ...oldRest } = before;
    const { version: newVersion, ...newRest } = after;
    expect(newRest).toEqual(oldRest);
    expect(newVersion).toBeGreaterThan(oldVersion);
    expect(summary).toMatchObject({
      guilds: 2,
      user_contexts: 1,
      user_overrides: 1,
      users: 2,
      blocked_users: 1,
    });

    // What the snapshot cannot carry is left for the next login.
    expect(await target.getUser("u1")).toEqual({
      discord_id: "u1",
      role: "premium",
      username: "",
      avatar: null,
    });
    expect(await target.listBlocked()).toEqual([
      {
        discord_id: "b1",
        username: null,
        reason: null,
        blocked_by: IMPORT_ACTOR,
        blocked_at: 5,
      },
    ]);
  });

  test("a login after the restore keeps the restored role", async () => {
    const target = new MemoryStore();
    await target.migrate();
    await importBotSnapshot(target, await snapshotOf(await source()));
    await target.upsertUser({
      discord_id: "u1",
      username: "alice",
      avatar: "a",
    });
    expect((await target.getUser("u1"))?.role).toBe("premium");
  });

  test("refuses a database that already has guilds or users unless forced", async () => {
    const snapshot = await snapshotOf(await source());
    const target = await source();
    await expect(importBotSnapshot(target, snapshot)).rejects.toThrow(
      "--force",
    );
    await expect(
      importBotSnapshot(target, snapshot, { force: true }),
    ).resolves.toBeDefined();
  });

  test("rejects input that is not a bot snapshot", async () => {
    const target = new MemoryStore();
    await target.migrate();
    await expect(importBotSnapshot(target, { guilds: {} })).rejects.toThrow(
      "Not a bot snapshot",
    );
    await expect(importBotSnapshot(target, [])).rejects.toThrow(
      "Not a bot snapshot",
    );
  });
});

describe("presetOverrides", () => {
  test("catalog defaults need no override", () => {
    const unpublished = ids.filter((id) => !catalogPublished(id));
    const premium = ids.filter((id) => isPremium(id, {}));
    expect(presetOverrides(unpublished, premium)).toEqual({
      visibility: {},
      premium: {},
    });
  });
});

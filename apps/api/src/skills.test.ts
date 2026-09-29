import { test, expect } from "bun:test";
import { createApp } from "./create-app";
import { loadTestEnv } from "./env";
import { MemoryStore } from "./store";
import { skillRow } from "./skills";

async function setup() {
  const store = new MemoryStore();
  await store.migrate();
  await store.upsertUser({
    discord_id: "user",
    username: "User",
    avatar: null,
  });
  await store.putSession(
    "skills-session",
    "user",
    "access",
    Date.now() + 60000,
  );
  const env = loadTestEnv();
  const app = createApp(env, store, {
    guildAccess: async (_, id) => id === "123" || id === "456",
  });
  const row = {
    guild_id: "123",
    name: "sample-skill",
    description: "Sample",
    builtin: false,
    enabled: true,
    files: {
      "SKILL.md": Buffer.from(
        "---\nname: sample-skill\ndescription: Sample\n---\nBody",
      ).toString("base64"),
      "assets/image.bin": Buffer.from([0, 255, 10]).toString("base64"),
    },
  };
  await store.replaceSkills([
    row,
    { ...row, guild_id: "0", name: "create-skill", builtin: true },
  ]);
  async function request(
    path: string,
    body?: unknown,
    internal = false,
    authenticated = true,
  ) {
    return app.handle(
      new Request(`http://localhost${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          ...(authenticated ? { cookie: "hibana_session=skills-session" } : {}),
          ...(internal ? { authorization: `Bearer ${env.internalToken}` } : {}),
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  }
  return { store, request, row };
}

test("skills require a session and source/destination access", async () => {
  const { request, store } = await setup();
  expect(
    (await request("/api/guilds/123/skills", undefined, false, false)).status,
  ).toBe(401);
  expect((await request("/api/guilds/999/skills")).status).toBe(404);
  expect(
    (
      await request("/api/guilds/456/skills", {
        action: "import",
        name: "sample-skill",
        source_guild_id: "999",
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await request("/api/guilds/999/skills", {
        action: "create",
        name: "sample-skill",
        description: "D",
        body: "B",
      })
    ).status,
  ).toBe(404);
  expect(await store.listSkillCommands()).toHaveLength(0);
});

test("chunked catalog publishes atomically and rejects incomplete uploads", async () => {
  const { request, store, row } = await setup();
  const replacement = [{ ...row, name: "chunked-skill" }];
  const bytes = Buffer.from(JSON.stringify(replacement));
  const split = Math.floor(bytes.length / 2);
  const first = {
    id: "0123456789abcdef",
    index: 0,
    total: 2,
    data: bytes.subarray(0, split).toString("base64"),
  };
  const last = {
    ...first,
    index: 1,
    data: bytes.subarray(split).toString("base64"),
  };
  expect((await request("/internal/skills/chunk", last, true)).status).toBe(
    409,
  );
  expect((await store.listSkills())[0]!.name).toBe("sample-skill");
  expect((await request("/internal/skills/chunk", first, true)).status).toBe(
    200,
  );
  expect((await store.listSkills())[0]!.name).toBe("sample-skill");
  expect((await request("/internal/skills/chunk", last, true)).status).toBe(
    200,
  );
  expect(await store.listSkills()).toEqual(replacement);
  expect(
    (await request("/internal/skills/chunk", { ...first, total: 129 }, true))
      .status,
  ).toBe(400);
  expect((await request("/internal/skills/chunk", first)).status).toBe(401);
});

test("copy, create, toggle and delete enter snapshot until acknowledged", async () => {
  const { request, store } = await setup();
  for (const body of [
    { action: "import", name: "sample-skill", source_guild_id: "123" },
    { action: "create", name: "new-skill", description: "D", body: "B" },
    { action: "enabled", name: "create-skill", enabled: false },
  ]) {
    expect((await request("/api/guilds/456/skills", body)).status).toBe(200);
  }
  expect(
    (
      await request("/api/guilds/123/skills", {
        action: "delete",
        name: "sample-skill",
      })
    ).status,
  ).toBe(200);
  const snapshot = (await (
    await request("/internal/snapshot", undefined, true)
  ).json()) as { skill_commands: { id: number }[] };
  expect(snapshot.skill_commands).toHaveLength(4);
  expect(
    (
      await request(
        "/internal/skills/ack",
        { id: snapshot.skill_commands[0]!.id, result: { ok: true } },
        true,
      )
    ).status,
  ).toBe(200);
  const next = (await (
    await request("/internal/snapshot", undefined, true)
  ).json()) as { skill_commands: unknown[] };
  expect(next.skill_commands).toHaveLength(3);
  expect((await store.listSkillCommands())[0]!.result).toEqual({ ok: true });
});

test("catalog preserves downloads, scopes builtin state and rejects invalid mutations", async () => {
  const { request, store, row } = await setup();
  await store.replaceSkills([
    row,
    { ...row, guild_id: "0", name: "create-skill", builtin: true },
    {
      ...row,
      guild_id: "123",
      name: "create-skill",
      builtin: true,
      enabled: false,
    },
  ]);
  const own = (await (await request("/api/guilds/123/skills")).json()) as {
    skills: (typeof row)[];
  };
  expect(own.skills.find((r) => r.name === "sample-skill")!.files).toEqual(
    row.files,
  );
  expect(own.skills.find((r) => r.name === "create-skill")!.enabled).toBe(
    false,
  );
  const other = (await (await request("/api/guilds/456/skills")).json()) as {
    skills: (typeof row)[];
  };
  expect(other.skills.find((r) => r.name === "create-skill")!.enabled).toBe(
    true,
  );
  expect(
    (
      await request("/api/guilds/123/skills", {
        action: "delete",
        name: "create-skill",
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await request("/api/guilds/123/skills", {
        action: "create",
        name: "sample-skill",
        description: "D",
        body: "B",
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await request("/api/guilds/123/skills", {
        action: "enabled",
        name: "sample-skill",
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await request("/api/guilds/123/skills", {
        action: "import",
        name: "sample-skill",
        source_guild_id: "../123",
      })
    ).status,
  ).toBe(400);
  expect(
    skillRow.safeParse({
      ...row,
      files: { "SKILL.md": "AA==", "assets/../../secret": "AA==" },
    }).success,
  ).toBe(false);
  expect((await request("/internal/skills", { skills: [row] })).status).toBe(
    401,
  );
});

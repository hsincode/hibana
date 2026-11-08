// A server's settings change only for those who manage it (decision record
// #166): Discord's Manage Server or Administrator there, the server's owner,
// or a hibana Moderator / Administrator. That holds for the slash commands and
// for the tools the model calls on someone's behalf; reading stays open.
import { describe, expect, test } from "bun:test";
import { PermissionFlagsBits, PermissionsBitField } from "discord.js";
import { Agent } from "../agent";
import { handleCommand } from "../commands";
import { loadConfig } from "../config";
import {
  MANAGE_SERVER_REQUIRED,
  canManageServerSettings,
} from "../guild-permission";
import { LlmClient } from "../llm";
import { Runtime } from "../runtime";
import { ToolRegistry } from "../tools";
import type { Context } from "../types";

const NONE = new PermissionsBitField();
const MANAGE = new PermissionsBitField(PermissionFlagsBits.ManageGuild);
const ADMIN = new PermissionsBitField(PermissionFlagsBits.Administrator);

const runtime = (role = "free") => {
  const rt = new Runtime(
    loadConfig({
      ANTHROPIC_API_KEY: "fixture",
      RUNTIME_STATE_PATH: "",
      SANDBOX_ENABLED: "false",
      SKILLS_ENABLED: "false",
    }),
  );
  rt.snapshot.user_roles = { u1: role };
  return rt;
};

/** Runs one slash command as u1; only what `handleCommand` reads is faked. */
async function slash(
  rt: Runtime,
  name: string,
  options: {
    strings?: Record<string, string>;
    permissions?: PermissionsBitField;
    owner?: boolean;
    guildId?: string | null;
  } = {},
) {
  let reply = "";
  const guildId = options.guildId === undefined ? "g1" : options.guildId;
  const i = {
    commandName: name,
    user: { id: "u1" },
    guildId,
    guild: guildId ? { ownerId: options.owner ? "u1" : "someone" } : null,
    memberPermissions: guildId ? (options.permissions ?? NONE) : null,
    channelId: "t1",
    client: { user: { id: "bot" } },
    channel: { isThread: () => false },
    options: {
      getString: (key: string) => options.strings?.[key] ?? null,
      getNumber: () => null,
      getInteger: () => null,
      getBoolean: () => null,
      getSubcommand: () => null,
    },
    deferReply: async () => {},
    reply: async () => {},
    editReply: async (text: string) => {
      reply = text;
    },
  };
  await handleCommand(
    i as never,
    rt,
    {} as never,
    {} as never,
    { leave: () => {} } as never,
    async () => {},
    {} as never,
  );
  return reply;
}

test("the rule: staff, the owner, Manage Server or Administrator", () => {
  const can = (role: string, permissions: PermissionsBitField, owner = false) =>
    canManageServerSettings({ role, owner, permissions });
  expect(can("free", NONE)).toBe(false);
  expect(can("premium", NONE)).toBe(false);
  expect(can("free", MANAGE)).toBe(true);
  expect(can("free", ADMIN)).toBe(true);
  expect(can("free", NONE, true)).toBe(true);
  expect(can("moderator", NONE)).toBe(true);
  expect(can("administrator", NONE)).toBe(true);
  expect(
    canManageServerSettings({ role: "free", owner: false, permissions: null }),
  ).toBe(false);
});

describe("slash commands", () => {
  test("a member who does not manage the server is refused and nothing changes", async () => {
    const rt = runtime("premium");
    const before = JSON.stringify(rt.guild("g1"));
    for (const [name, strings] of [
      ["switch", { effort: "high" }],
      ["server-tools", { mode: "off" }],
      ["thread-only", { mode: "on" }],
      ["suppress-embeds", { mode: "on" }],
      ["server-context", { text: "be brief" }],
      // In a server this one writes the server's context too.
      ["user-context", { text: "be brief" }],
    ] as const) {
      const reply = await slash(rt, name, { strings });
      expect(reply).toBe(`エラー: ${MANAGE_SERVER_REQUIRED}`);
    }
    expect(JSON.stringify(rt.guild("g1"))).toBe(before);
  });

  test("reading the values stays open to every member", async () => {
    const rt = runtime();
    expect(await slash(rt, "switch")).toContain('"model"');
    expect(await slash(rt, "server-context")).not.toContain("エラー");
  });

  test("Manage Server, Administrator, the owner and staff may change them", async () => {
    for (const [role, permissions, owner] of [
      ["free", MANAGE, false],
      ["free", ADMIN, false],
      ["free", NONE, true],
      ["moderator", NONE, false],
      ["administrator", NONE, false],
    ] as const) {
      const rt = runtime(role);
      const reply = await slash(rt, "thread-only", {
        strings: { mode: "on" },
        permissions,
        owner,
      });
      expect(reply).not.toContain("エラー");
      expect(rt.guild("g1").thread_only).toBe(true);
    }
  });

  test("a DM's /user-context is the person's own and needs no permission", async () => {
    const rt = runtime();
    const reply = await slash(rt, "user-context", {
      strings: { text: "call me Sam" },
      guildId: null,
    });
    expect(reply).not.toContain("エラー");
    expect(rt.resolve(undefined, "u1").context?.text).toBe("call me Sam");
  });
});

describe("settings tools", () => {
  const setup = (
    role: string,
    permissions: PermissionsBitField,
    owner = false,
  ) => {
    const rt = runtime(role);
    const fetched: string[] = [];
    // Only the guild and member lookups the check makes are faked.
    const client = {
      guilds: {
        fetch: async (id: string) => {
          fetched.push(id);
          return {
            ownerId: owner ? "u1" : "someone",
            members: { fetch: async () => ({ permissions }) },
          };
        },
      },
    };
    const registry = new ToolRegistry(
      rt,
      client as never,
      new Agent(new LlmClient(rt.config)),
    );
    const ctx: Context = {
      guildId: "g1",
      channelId: "c1",
      userId: "u1",
      botId: "bot",
      thread: false,
      depth: 0,
      delivered: false,
    };
    return { rt, registry, ctx, fetched };
  };

  test("are refused for a member who does not manage the server", async () => {
    const { rt, registry, ctx } = setup("premium", NONE);
    const before = JSON.stringify(rt.guild("g1"));
    for (const [name, args] of [
      ["set_bot_model", { effort: "high" }],
      ["set_triggers", { add: ["hey"] }],
      ["set_user_context", { text: "be brief" }],
    ] as const)
      await expect(registry.execute(name, args, ctx)).rejects.toThrow(
        MANAGE_SERVER_REQUIRED,
      );
    expect(JSON.stringify(rt.guild("g1"))).toBe(before);
    // Reading is not a change.
    expect(await registry.execute("get_triggers", {}, ctx)).toHaveProperty(
      "words",
    );
  });

  test("run for Manage Server and the owner, and staff are not looked up", async () => {
    for (const [role, permissions, owner] of [
      ["free", MANAGE, false],
      ["free", NONE, true],
    ] as const) {
      const { rt, registry, ctx } = setup(role, permissions, owner);
      await registry.execute("set_triggers", { add: ["hey"] }, ctx);
      expect(rt.guild("g1").extra_triggers).toContain("hey");
    }
    const staff = setup("moderator", NONE);
    await staff.registry.execute(
      "set_user_context",
      { text: "be brief" },
      staff.ctx,
    );
    expect(staff.rt.guild("g1").context?.text).toBe("be brief");
    expect(staff.fetched).toEqual([]);
  });
});

// `/thread-history` sets the thread retention and, since #124, how a long
// thread is summarized. Each option changes only itself. Since #161 these are
// app settings: one value for every server and DM, changed by Moderators and
// Administrators only.
import { expect, test } from "bun:test";
import { commands, handleCommand } from "../commands";
import { loadConfig } from "../config";
import { Runtime } from "../runtime";

const runtime = (role = "moderator") => {
  const rt = new Runtime(loadConfig({ ANTHROPIC_API_KEY: "fixture" }));
  rt.snapshot.user_roles = { u1: role };
  return rt;
};

/** Runs `/thread-history`; only what `handleCommand` reads is faked. */
async function slash(
  rt: Runtime,
  options: { strings?: Record<string, string>; ints?: Record<string, number> },
  guildId: string | null = "g1",
) {
  let reply = "";
  const i = {
    commandName: "thread-history",
    user: { id: "u1" },
    guildId,
    channelId: "t1",
    client: { user: { id: "bot" } },
    channel: { isThread: () => false },
    options: {
      getString: (key: string) => options.strings?.[key] ?? null,
      getInteger: (key: string) => options.ints?.[key] ?? null,
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

test("/thread-history offers the summary's mode and size", () => {
  const command = commands(runtime()).find((c) => c.name === "thread-history")!;
  const options = command.options as {
    name: string;
    choices?: { value: string }[];
    min_value?: number;
    max_value?: number;
  }[];
  expect(options.map((o) => o.name)).toEqual([
    "seconds",
    "compaction",
    "compaction_tokens",
  ]);
  expect(options[1]!.choices!.map((c) => c.value)).toEqual([
    "cache",
    "transcript",
    "off",
    "reset",
  ]);
  expect([options[2]!.min_value, options[2]!.max_value]).toEqual([
    1000, 1_000_000,
  ]);
});

test("the summary options leave the retention alone, and no option resets the retention as before", async () => {
  const rt = runtime();
  await slash(rt, { ints: { seconds: 600 } });
  expect(rt.app().thread_history_max_age_secs).toBe(600);

  await slash(rt, { strings: { compaction: "off" } });
  expect(rt.app().thread_compaction).toBe("off");
  expect(rt.app().thread_history_max_age_secs).toBe(600);

  await slash(rt, { ints: { compaction_tokens: 40_000 } });
  expect(rt.app().thread_compaction_tokens).toBe(40_000);
  expect(rt.app().thread_compaction).toBe("off");
  expect(rt.app().thread_history_max_age_secs).toBe(600);

  await slash(rt, { strings: { compaction: "reset" } });
  expect(rt.app().thread_compaction).toBe("cache");
  expect(rt.app().thread_compaction_tokens).toBe(40_000);

  await slash(rt, {});
  // Reset to the default retention.
  expect(rt.app().thread_history_max_age_secs).toBe(3600);
  expect(rt.app().thread_compaction_tokens).toBe(40_000);
});

test("the values are the app's: every server and DM reads them, and a DM may change them (#161)", async () => {
  const rt = runtime();
  const reply = await slash(rt, { ints: { seconds: 900 } }, null);
  expect(reply).toContain("全体の設定を変えました");
  expect(rt.app().thread_history_max_age_secs).toBe(900);
  for (const id of ["g1", "g2", undefined])
    expect(rt.resolve(id, "u1").thread_history_max_age_secs).toBe(900);
});

test("a member below Moderator is refused and nothing changes (#161)", async () => {
  for (const role of ["free", "standard", "premium"]) {
    const rt = runtime(role);
    const reply = await slash(rt, { ints: { seconds: 900 } });
    expect(reply).toContain("Moderator と Administrator だけ");
    expect(rt.app().thread_history_max_age_secs).toBe(3600);
  }
  const admin = runtime("administrator");
  await slash(admin, { ints: { seconds: 900 } });
  expect(admin.app().thread_history_max_age_secs).toBe(900);
});

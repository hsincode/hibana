// Scheduled actions on Discord: where a post may go, and where a clip plays.
// The client is a fake; nothing here reaches Discord.
import { describe, expect, test } from "bun:test";
import { AttachmentBuilder, PermissionFlagsBits } from "discord.js";
import { DiscordScheduleTarget } from "../schedule-discord";

const GUILD = "123456789012345678";

function setup(
  granted: bigint[] = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.AttachFiles,
  ],
) {
  const sent: Record<string, unknown>[] = [];
  const channel = (guildId: string) => ({
    guildId,
    guild: { members: { me: {} } },
    isTextBased: () => true,
    isThread: () => false,
    permissionsFor: () => ({
      has: (needed: bigint[]) => needed.every((p) => granted.includes(p)),
    }),
    send: async (message: Record<string, unknown>) => {
      sent.push(message);
    },
  });
  const channels = new Map<string, unknown>([
    ["c-here", channel(GUILD)],
    ["c-elsewhere", channel("999999999999999999")],
  ]);
  const client = {
    channels: {
      fetch: async (id: string) => {
        if (!channels.has(id)) throw new Error("Unknown Channel");
        return channels.get(id);
      },
    },
  };
  const played: string[] = [];
  const voice = (name: string, here: boolean) => ({
    play: async (guildId: string) => {
      if (!here || guildId !== GUILD) return false;
      played.push(name);
      return true;
    },
  });
  return { client, sent, played, voice };
}

describe("DiscordScheduleTarget", () => {
  test("posts the text and the file, and pings nobody", async () => {
    const s = setup();
    const target = new DiscordScheduleTarget(s.client as never, []);
    await target.post(GUILD, "c-here", {
      text: "@everyone 2時だよ",
      file: { name: "ema.mp4", data: Buffer.from("mp4") },
    });
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]!.content).toBe("@everyone 2時だよ");
    expect(s.sent[0]!.allowedMentions).toEqual({ parse: [] });
    const files = s.sent[0]!.files as AttachmentBuilder[];
    expect(files.map((f) => f.name)).toEqual(["ema.mp4"]);
  });

  test("a file alone is sent without text", async () => {
    const s = setup();
    const target = new DiscordScheduleTarget(s.client as never, []);
    await target.post(GUILD, "c-here", {
      text: " ",
      file: { name: "ema.png", data: Buffer.from("png") },
    });
    expect(s.sent[0]!.content).toBeUndefined();
  });

  test("a channel of another server, or none at all, is refused", async () => {
    const s = setup();
    const target = new DiscordScheduleTarget(s.client as never, []);
    await expect(
      target.post(GUILD, "c-elsewhere", { text: "hi" }),
    ).rejects.toThrow("is not in server");
    await expect(target.post(GUILD, "c-gone", { text: "hi" })).rejects.toThrow(
      "is not in server",
    );
    expect(s.sent).toEqual([]);
  });

  test("without Attach Files, text still goes and a file does not", async () => {
    const s = setup([
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
    ]);
    const target = new DiscordScheduleTarget(s.client as never, []);
    await expect(
      target.post(GUILD, "c-here", {
        text: "",
        file: { name: "ema.png", data: Buffer.from("png") },
      }),
    ).rejects.toThrow("may not post files");
    await target.post(GUILD, "c-here", { text: "hi" });
    expect(s.sent).toHaveLength(1);
  });

  test("a clip plays where the bot is in voice, and nowhere when it is not", async () => {
    const s = setup();
    const target = new DiscordScheduleTarget(s.client as never, [
      s.voice("join", false),
      s.voice("recording", true),
    ]);
    expect(await target.play(GUILD, "/a.wav", 1000)).toBe("played");
    expect(s.played).toEqual(["recording"]);
    expect(await target.play("999999999999999999", "/a.wav", 1000)).toBe(
      "absent",
    );
  });
});

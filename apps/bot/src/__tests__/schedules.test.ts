import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Schedule } from "@hibana/shared/schedules";
import {
  Scheduler,
  dueOccurrence,
  localClock,
  scanScheduleAssets,
  type ScheduleTarget,
} from "../schedules";

const GUILD = "123456789012345678";
const CHANNEL = "323456789012345678";
/** 2026-11-09 02:00:00 in Tokyo. */
const TWO_AM = Date.parse("2026-11-08T17:00:00Z");
const SEC = 1000;
const MIN = 60 * SEC;
const DAY = 24 * 60 * MIN;

const nightly = (over: Partial<Schedule> = {}): Schedule => ({
  id: "a1",
  name: "2時",
  enabled: true,
  time: "02:00",
  time_zone: "Asia/Tokyo",
  actions: [
    { type: "post", channel_id: CHANNEL, text: "", file: "ema.png" },
    { type: "voice_clip", audio: "ema.wav" },
  ],
  ...over,
});

describe("dueOccurrence", () => {
  test("is due from its minute for two minutes, on the local date", () => {
    const s = { time: "02:00", time_zone: "Asia/Tokyo" };
    expect(dueOccurrence(s, TWO_AM - SEC)).toBeNull();
    expect(dueOccurrence(s, TWO_AM)).toBe("2026-11-09 02:00");
    expect(dueOccurrence(s, TWO_AM + 119 * SEC)).toBe("2026-11-09 02:00");
    expect(dueOccurrence(s, TWO_AM + 120 * SEC)).toBeNull();
  });

  test("the same instant is a different local time in another time zone", () => {
    expect(localClock(TWO_AM, "UTC")).toEqual({
      date: "2026-11-08",
      time: "17:00",
    });
    expect(
      dueOccurrence({ time: "17:00", time_zone: "UTC" }, TWO_AM + 30 * SEC),
    ).toBe("2026-11-08 17:00");
  });

  test("23:59 is still due just after midnight, as the day before", () => {
    const midnight = Date.parse("2026-11-08T15:00:00Z"); // 2026-11-09 00:00 JST
    expect(
      dueOccurrence(
        { time: "23:59", time_zone: "Asia/Tokyo" },
        midnight + 30 * SEC,
      ),
    ).toBe("2026-11-08 23:59");
  });

  test("a local time that a daylight saving change skips never comes that day", () => {
    // New York skipped 02:00-02:59 on 2026-03-08.
    const s = { time: "02:30", time_zone: "America/New_York" };
    const from = Date.parse("2026-03-08T05:00:00Z");
    for (let t = from; t < from + DAY; t += 30 * SEC)
      expect(dueOccurrence(s, t)).toBeNull();
  });

  test("a local time that happens twice is one occurrence", () => {
    // New York went through 01:00-01:59 twice on 2026-11-01.
    const s = { time: "01:30", time_zone: "America/New_York" };
    const first = Date.parse("2026-11-01T05:30:00Z");
    const second = Date.parse("2026-11-01T06:30:00Z");
    expect(dueOccurrence(s, first)).toBe("2026-11-01 01:30");
    expect(dueOccurrence(s, second)).toBe("2026-11-01 01:30");
  });
});

class FakeTarget implements ScheduleTarget {
  posts: {
    guildId: string;
    channelId: string;
    text: string;
    file?: { name: string; data: string };
  }[] = [];
  plays: { guildId: string; path: string; maxMs: number }[] = [];
  inVoice = true;
  failPost?: Error;
  async post(
    guildId: string,
    channelId: string,
    message: { text: string; file?: { name: string; data: Buffer } },
  ) {
    if (this.failPost) throw this.failPost;
    this.posts.push({
      guildId,
      channelId,
      text: message.text,
      file: message.file && {
        name: message.file.name,
        data: message.file.data.toString(),
      },
    });
  }
  async play(guildId: string, path: string, maxMs: number) {
    if (!this.inVoice) return "absent" as const;
    this.plays.push({ guildId, path, maxMs });
    return "played" as const;
  }
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hibana-schedules-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function placeAssets(guildId = GUILD) {
  const assets = join(dir, "scheduled-assets", guildId);
  await mkdir(assets, { recursive: true });
  await writeFile(join(assets, "ema.png"), "png-bytes");
  await writeFile(join(assets, "ema.wav"), "wav-bytes");
  return assets;
}

function setup(
  schedules: Record<string, unknown>,
  over: { disabled?: string[] } = {},
) {
  let clock = TWO_AM;
  const target = new FakeTarget();
  const errors: unknown[] = [];
  const logs: Record<string, unknown>[] = [];
  const make = (): Scheduler =>
    new Scheduler({
      dataDir: dir,
      statePath: join(dir, "schedules_state.json"),
      schedules: () => state.schedules,
      disabled: (id) => (over.disabled ?? []).includes(id),
      target,
      report: (e) => errors.push(e),
      log: (_m, fields) => logs.push(fields),
      now: () => clock,
    });
  const state: { schedules: Record<string, unknown>; scheduler: Scheduler } = {
    schedules,
    scheduler: make(),
  };
  return {
    state,
    target,
    errors,
    logs,
    at: (ms: number) => {
      clock = ms;
    },
    /** A restart: a new scheduler on the same state file. */
    restart: () => {
      state.scheduler = make();
    },
    tick: async () => {
      await state.scheduler.tick();
      await state.scheduler.idle();
    },
  };
}

describe("Scheduler", () => {
  test("at its minute, posts the image and plays the clip, once", async () => {
    const assets = await placeAssets();
    const t = setup({ [GUILD]: [nightly()] });
    t.at(TWO_AM + 5 * SEC);
    await t.tick();
    expect(t.target.posts).toEqual([
      {
        guildId: GUILD,
        channelId: CHANNEL,
        text: "",
        file: { name: "ema.png", data: "png-bytes" },
      },
    ]);
    expect(t.target.plays).toEqual([
      { guildId: GUILD, path: join(assets, "ema.wav"), maxMs: 5 * MIN },
    ]);
    t.at(TWO_AM + 20 * SEC);
    await t.tick();
    expect(t.target.posts).toHaveLength(1);
    expect(t.target.plays).toHaveLength(1);
    expect(t.errors).toEqual([]);
  });

  test("a post may attach a video instead of an image", async () => {
    const assets = await placeAssets();
    await writeFile(join(assets, "ema.mp4"), "mp4-bytes");
    const t = setup({
      [GUILD]: [
        nightly({
          actions: [
            { type: "post", channel_id: CHANNEL, text: "2時", file: "ema.mp4" },
          ],
        }),
      ],
    });
    await t.tick();
    expect(t.target.posts).toEqual([
      {
        guildId: GUILD,
        channelId: CHANNEL,
        text: "2時",
        file: { name: "ema.mp4", data: "mp4-bytes" },
      },
    ]);
  });

  test("a restart in the same minute does not send it again; the next day does", async () => {
    await placeAssets();
    const t = setup({ [GUILD]: [nightly()] });
    t.at(TWO_AM + 5 * SEC);
    await t.tick();
    t.restart();
    t.at(TWO_AM + 70 * SEC);
    await t.tick();
    expect(t.target.posts).toHaveLength(1);
    t.at(TWO_AM + DAY + 3 * SEC);
    await t.tick();
    expect(t.target.posts).toHaveLength(2);
  });

  test("a day the bot was down past the grace period is skipped", async () => {
    await placeAssets();
    const t = setup({ [GUILD]: [nightly()] });
    t.at(TWO_AM + 3 * MIN);
    await t.tick();
    expect(t.target.posts).toEqual([]);
    expect(t.target.plays).toEqual([]);
  });

  test("a disabled schedule and a server with the bot switched off run nothing", async () => {
    await placeAssets();
    await placeAssets("223456789012345678");
    const t = setup(
      {
        [GUILD]: [nightly({ enabled: false })],
        "223456789012345678": [nightly()],
      },
      { disabled: ["223456789012345678"] },
    );
    await t.tick();
    expect(t.target.posts).toEqual([]);
  });

  test("a time moved later the same day runs again at the new time", async () => {
    await placeAssets();
    const t = setup({ [GUILD]: [nightly()] });
    await t.tick();
    t.state.schedules = { [GUILD]: [nightly({ time: "02:05" })] };
    t.at(TWO_AM + 5 * MIN + SEC);
    await t.tick();
    expect(t.target.posts).toHaveLength(2);
  });

  test("a failed post is reported, and the clip still plays", async () => {
    await placeAssets();
    const t = setup({ [GUILD]: [nightly()] });
    t.target.failPost = new Error("Missing Permissions");
    await t.tick();
    expect(t.errors).toEqual([t.target.failPost]);
    expect(t.target.plays).toHaveLength(1);
  });

  test("a missing file is reported, and the other action still runs", async () => {
    const assets = await placeAssets();
    await rm(join(assets, "ema.png"));
    const t = setup({ [GUILD]: [nightly()] });
    await t.tick();
    expect(String(t.errors[0])).toContain("image file not found: ema.png");
    expect(t.target.posts).toEqual([]);
    expect(t.target.plays).toHaveLength(1);
  });

  test("not in voice: the clip is skipped without an error", async () => {
    await placeAssets();
    const t = setup({ [GUILD]: [nightly()] });
    t.target.inVoice = false;
    await t.tick();
    expect(t.target.posts).toHaveLength(1);
    expect(t.errors).toEqual([]);
    expect(t.logs).toContainEqual({
      guild: GUILD,
      schedule: "a1",
      result: "absent",
    });
  });

  test("a schedule that does not parse is ignored", async () => {
    await placeAssets();
    const t = setup({
      [GUILD]: [nightly({ time_zone: "Mars/Olympus" }), { id: "x" }],
    });
    await t.tick();
    expect(t.target.posts).toEqual([]);
    expect(t.errors).toEqual([]);
  });

  test("an asset name cannot leave the server's directory", async () => {
    await placeAssets();
    // Another server's file: only reachable by a path, which never parses.
    const t = setup({
      [GUILD]: [
        {
          ...nightly(),
          actions: [
            { type: "voice_clip", audio: "../223456789012345678/ema.wav" },
          ],
        },
      ],
    });
    await t.tick();
    expect(t.target.plays).toEqual([]);
  });
});

describe("scheduled assets", () => {
  test("lists each server's images and audio, and leaves out what cannot be used", async () => {
    const assets = await placeAssets();
    await writeFile(join(assets, "ema.mp4"), "mp4-bytes");
    await writeFile(join(assets, "notes.txt"), "x");
    await writeFile(join(assets, ".hidden.png"), "x");
    await writeFile(join(assets, "with space.png"), "x");
    await writeFile(join(assets, "huge.png"), "");
    await truncate(join(assets, "huge.png"), 10 * 1024 * 1024 + 1);
    await mkdir(join(assets, "sub.png"));
    await mkdir(join(dir, "scheduled-assets", "not-a-guild"), {
      recursive: true,
    });
    expect(await scanScheduleAssets(dir)).toEqual({
      [GUILD]: [
        { name: "ema.mp4", kind: "video", size: 9 },
        { name: "ema.png", kind: "image", size: 9 },
        { name: "ema.wav", kind: "audio", size: 9 },
      ],
    });
  });

  test("no directory is no assets", async () => {
    expect(await scanScheduleAssets(join(dir, "missing"))).toEqual({});
  });

  test("the list is sent when it changes, and again after a failure", async () => {
    const assets = await placeAssets();
    const sent: unknown[] = [];
    let fail = false;
    const scheduler = new Scheduler({
      dataDir: dir,
      statePath: join(dir, "schedules_state.json"),
      schedules: () => ({}),
      disabled: () => false,
      target: new FakeTarget(),
      report: () => {},
      reportAssets: async (guilds) => {
        if (fail) throw new Error("API down");
        sent.push(guilds);
      },
    });
    await scheduler.syncAssets();
    await scheduler.syncAssets();
    expect(sent).toHaveLength(1);
    await writeFile(join(assets, "more.ogg"), "ogg");
    fail = true;
    await expect(scheduler.syncAssets()).rejects.toThrow("API down");
    fail = false;
    await scheduler.syncAssets();
    expect(sent).toHaveLength(2);
    expect((sent[1] as Record<string, unknown[]>)[GUILD]).toHaveLength(3);
  });
});

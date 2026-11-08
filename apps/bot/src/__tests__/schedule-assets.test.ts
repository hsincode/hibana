// Assets of scheduled actions added from Discord (decision record #168):
// `/schedule-asset add|list|remove` saves the attached file where assets
// placed by hand live, within the per-server and total limits. Discord's CDN
// is faked; the files are real, in a temporary directory.
import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionFlagsBits, PermissionsBitField } from "discord.js";
import { handleCommand } from "../commands";
import { loadConfig } from "../config";
import { MANAGE_SERVER_REQUIRED } from "../guild-permission";
import { Runtime } from "../runtime";
import { ScheduleAssets } from "../schedule-assets";
import { scanScheduleAssets } from "../schedules";

const G = "100000000000000001";
const OTHER = "100000000000000002";
const MB = 1024 * 1024;
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), "hibana-assets-"));
  dirs.push(dataDir);
  /** What the CDN serves, by URL. */
  const cdn = new Map<string, Buffer>();
  const fetched: string[] = [];
  let changed = 0;
  const assets = new ScheduleAssets({
    dataDir,
    fetch: async (url) => {
      fetched.push(url);
      const body = cdn.get(url);
      return body
        ? new Response(new Uint8Array(body))
        : new Response("gone", { status: 404 });
    },
    changed: () => changed++,
  });
  const dir = (guild = G) => join(dataDir, "scheduled-assets", guild);
  /** A file placed by hand, `size` bytes without writing them. */
  const place = (name: string, size: number, guild = G) => {
    mkdirSync(dir(guild), { recursive: true });
    writeFileSync(join(dir(guild), name), "");
    truncateSync(join(dir(guild), name), size);
  };
  /** An attachment on Discord: its name, URL and size. */
  const attach = (name: string, data: Buffer, size = data.length) => {
    const url = `https://cdn.discordapp.com/attachments/1/2/${name}`;
    cdn.set(url, data);
    return { name, url, size };
  };
  return {
    dataDir,
    assets,
    dir,
    place,
    attach,
    fetched,
    changed: () => changed,
  };
}

describe("ScheduleAssets", () => {
  test("an attached file is saved under its name, listed, and reported like one placed by hand", async () => {
    const s = setup();
    const result = await s.assets.add(
      G,
      s.attach("morning.mp3", Buffer.from("ID3 clip")),
    );
    expect(result).toEqual({
      name: "morning.mp3",
      kind: "audio",
      size: 8,
      replaced: false,
    });
    expect(readFileSync(join(s.dir(), "morning.mp3"), "utf8")).toBe("ID3 clip");
    expect(s.changed()).toBe(1);
    expect((await s.assets.list(G)).assets).toEqual([
      { name: "morning.mp3", kind: "audio", size: 8 },
    ]);
    expect(await scanScheduleAssets(s.dataDir)).toEqual({
      [G]: [{ name: "morning.mp3", kind: "audio", size: 8 }],
    });
  });

  test("the same name is replaced, and `name` renames the attachment", async () => {
    const s = setup();
    await s.assets.add(G, s.attach("a.png", Buffer.from("one")));
    const again = await s.assets.add(
      G,
      s.attach("IMG_0001.png", Buffer.from("two!")),
      "a.png",
    );
    expect(again.replaced).toBe(true);
    expect(readFileSync(join(s.dir(), "a.png"), "utf8")).toBe("two!");
    expect(readdirSync(s.dir())).toEqual(["a.png"]);
  });

  test("a name outside the rules, an unknown kind, or a renamed kind is refused before anything is fetched", async () => {
    const s = setup();
    await expect(
      s.assets.add(G, s.attach("朝の挨拶.mp3", Buffer.from("x"))),
    ).rejects.toThrow("`name` で指定してください");
    await expect(
      s.assets.add(G, s.attach("x.mp3", Buffer.from("x")), "../x.mp3"),
    ).rejects.toThrow("使えません");
    await expect(
      s.assets.add(G, s.attach("notes.txt", Buffer.from("x"))),
    ).rejects.toThrow("拡張子");
    await expect(
      s.assets.add(G, s.attach("photo.png", Buffer.from("x")), "photo.mp3"),
    ).rejects.toThrow("種類（image）");
    expect(s.fetched).toEqual([]);
    expect(s.changed()).toBe(0);
  });

  test("over the size of its kind: refused from Discord's size, or while downloading, and nothing is left", async () => {
    const s = setup();
    await expect(
      s.assets.add(G, s.attach("big.png", Buffer.alloc(1), 10 * MB + 1)),
    ).rejects.toThrow("10 MB まで");
    expect(s.fetched).toEqual([]);
    // Discord said less than it sent.
    await expect(
      s.assets.add(G, s.attach("big.mp3", Buffer.alloc(20 * MB + 1), 1)),
    ).rejects.toThrow("20 MB まで");
    expect(existsSync(s.dir())).toBe(false);
  });

  test("a server's assets stay within 200 MB; the file replaced is not counted", async () => {
    const s = setup();
    s.place("long.flac", 190 * MB);
    s.place("a.mp3", 5 * MB);
    await expect(
      s.assets.add(G, s.attach("b.mp3", Buffer.alloc(6 * MB))),
    ).rejects.toThrow("合計 200 MB まで");
    // 190 + 10 replacing the 5: exactly 200.
    await s.assets.add(G, s.attach("a.mp3", Buffer.alloc(10 * MB)));
    // Another server is not held to this one's limit.
    await s.assets.add(OTHER, s.attach("b.mp3", Buffer.alloc(6 * MB)));
  });

  test("every server's assets stay within 1 GB, counting files placed by hand", async () => {
    const s = setup();
    for (let i = 0; i < 6; i++)
      s.place("x.flac", 170 * MB, `10000000000000001${i}`);
    await expect(
      s.assets.add(G, s.attach("c.mp3", Buffer.alloc(5 * MB))),
    ).rejects.toThrow("1 GB の上限");
    expect(readdirSync(s.dataDir + "/scheduled-assets")).not.toContain(G);
  });

  test("a server holds at most 200 assets", async () => {
    const s = setup();
    for (let i = 0; i < 200; i++) s.place(`f${i}.png`, 1);
    await expect(
      s.assets.add(G, s.attach("one-more.png", Buffer.from("x"))),
    ).rejects.toThrow("200 件まで");
    await s.assets.add(G, s.attach("f0.png", Buffer.from("x")));
  });

  test("an asset is removed; one that is not there, or a path, is refused", async () => {
    const s = setup();
    s.place("a.png", 3);
    expect(await s.assets.remove(G, "a.png")).toEqual({ removed: "a.png" });
    expect(readdirSync(s.dir())).toEqual([]);
    expect(s.changed()).toBe(1);
    await expect(s.assets.remove(G, "a.png")).rejects.toThrow("ありません");
    s.place("b.png", 3, OTHER);
    await expect(s.assets.remove(G, `../${OTHER}/b.png`)).rejects.toThrow(
      "ありません",
    );
    expect(readdirSync(s.dir(OTHER))).toEqual(["b.png"]);
  });
});

describe("/schedule-asset", () => {
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
  async function slash(
    assets: ScheduleAssets,
    sub: string,
    options: {
      permissions?: PermissionsBitField;
      name?: string;
      file?: { name: string; url: string; size: number };
    } = {},
  ) {
    let reply = "";
    const i = {
      commandName: "schedule-asset",
      user: { id: "u1" },
      guildId: G,
      guild: { ownerId: "someone" },
      memberPermissions: options.permissions ?? new PermissionsBitField(),
      channelId: "t1",
      client: { user: { id: "bot" } },
      channel: { isThread: () => false },
      options: {
        getSubcommand: () => sub,
        getString: (key: string) =>
          key === "name" ? (options.name ?? null) : null,
        getAttachment: () => options.file,
        getNumber: () => null,
        getInteger: () => null,
        getBoolean: () => null,
      },
      deferReply: async () => {},
      reply: async () => {},
      editReply: async (text: string) => {
        reply = text;
      },
    };
    await handleCommand(
      i as never,
      runtime(),
      {} as never,
      {} as never,
      { leave: () => {} } as never,
      async () => {},
      {} as never,
      undefined,
      undefined,
      assets,
    );
    return reply;
  }
  const MANAGE = new PermissionsBitField(PermissionFlagsBits.ManageGuild);

  test("adding and removing take someone who manages the server; listing is open", async () => {
    const s = setup();
    s.place("a.png", 3);
    const file = s.attach("b.png", Buffer.from("png"));
    expect(await slash(s.assets, "add", { file })).toBe(
      `エラー: ${MANAGE_SERVER_REQUIRED}`,
    );
    expect(await slash(s.assets, "remove", { name: "a.png" })).toBe(
      `エラー: ${MANAGE_SERVER_REQUIRED}`,
    );
    expect(readdirSync(s.dir())).toEqual(["a.png"]);
    expect(await slash(s.assets, "list")).toContain('"a.png"');
  });

  test("someone who manages the server adds and removes", async () => {
    const s = setup();
    const file = s.attach("IMG.png", Buffer.from("png"));
    const added = await slash(s.assets, "add", {
      file,
      name: "banner.png",
      permissions: MANAGE,
    });
    expect(added).toContain("素材を保存しました");
    expect(readdirSync(s.dir())).toEqual(["banner.png"]);
    expect(
      await slash(s.assets, "remove", {
        name: "banner.png",
        permissions: MANAGE,
      }),
    ).not.toContain("エラー");
    expect(readdirSync(s.dir())).toEqual([]);
  });
});

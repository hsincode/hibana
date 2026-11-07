// The Discord side of the meeting recording (#118): who is listened to, and
// when. The voice connection and the xAI stream are fakes; nothing here
// reaches Discord or xAI.
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { loadConfig } from "../config";
import { DiscordRecordingPort } from "../recording-discord";
import { Runtime } from "../runtime";
import type { streamSpeech } from "../stt";

type StreamCall = {
  userId: string;
  /** What the stream is fed: the speaker's audio while they are received. */
  opus: PassThrough;
  onMessage: (data: Record<string, unknown>) => void;
  finish: () => void;
  ended: boolean;
};

function setup(
  options: {
    bots?: string[];
    failLookup?: boolean;
    /** xAI never gets ready: every stream fails. */
    refuse?: boolean;
    /** xAI gets ready, then closes at once (with an error event, if set). */
    closeAfterReady?: "quietly" | "with an error";
    /** A voice connection already open in the server. */
    existing?: { state: { status: string } };
    /** Clips play until `finishClip()`; without, they end at once. */
    holdClips?: boolean;
  } = {},
) {
  const runtime = new Runtime(
    loadConfig({
      ANTHROPIC_API_KEY: "fixture",
      XAI_API_KEY: "fixture",
      VOICE_ENABLED: "true",
    }),
  );
  const speaking = Object.assign(new EventEmitter(), {
    users: new Map<string, number>(),
  });
  const subscriptions = new Map<string, PassThrough>();
  // A stream is opened right after its speaker is subscribed, or again for
  // the same speaker after its limit.
  let subscribed = "";
  const lookups: string[] = [];
  const connection = Object.assign(new EventEmitter(), {
    state: { status: "ready" },
    destroyed: false,
    joinConfig: {
      channelId: "vc1",
      guildId: "g1",
      group: "default",
      selfDeaf: false,
      selfMute: true,
    },
    /** selfMute of each voice state sent after joining. */
    mutes: [] as boolean[],
    rejoin(config: { selfMute: boolean }) {
      this.mutes.push(config.selfMute);
      this.joinConfig = { ...this.joinConfig, ...config };
      return true;
    },
    /** The players subscribed, and how many were unsubscribed. */
    players: [] as unknown[],
    unsubscribed: 0,
    subscribe(player: unknown) {
      this.players.push(player);
      return {
        unsubscribe: () => {
          this.unsubscribed++;
        },
      };
    },
    destroy() {
      this.destroyed = true;
      this.state.status = "destroyed";
    },
    receiver: {
      speaking,
      subscribe(userId: string) {
        const opus = new PassThrough({ objectMode: true });
        // As Discord's receive stream: once it has ended, it closes.
        opus.once("end", () => opus.destroy());
        subscribed = userId;
        subscriptions.set(userId, opus);
        opus.once("close", () => subscriptions.delete(userId));
        return opus;
      },
    },
  });
  const guild = {
    voiceAdapterCreator: () => ({}),
    members: {
      fetch: async (id: string) => {
        lookups.push(id);
        if (options.failLookup) throw new Error("Unknown Member");
        return {
          user: { bot: options.bots?.includes(id) ?? false },
          displayName: `name-${id}`,
        };
      },
    },
  };
  const client = { guilds: { fetch: async () => guild } };
  const streams: StreamCall[] = [];
  const fakeStream = ((o: Parameters<typeof streamSpeech>[0]) => {
    let resolve!: () => void;
    const done = new Promise<void>((r) => {
      resolve = r;
    });
    const call: StreamCall = {
      userId: subscribed,
      opus: o.opus as PassThrough,
      onMessage: o.onMessage as StreamCall["onMessage"],
      finish: resolve,
      ended: false,
    };
    streams.push(call);
    if (options.refuse)
      queueMicrotask(() => {
        // The socket fails at once, and the stream drops what it was fed.
        call.opus.destroy();
        resolve();
      });
    else call.onMessage({ type: "transcript.created" });
    if (options.closeAfterReady)
      queueMicrotask(() => {
        if (options.closeAfterReady === "with an error")
          call.onMessage({ type: "error", message: "limit" });
        call.opus.destroy();
        resolve();
      });
    return {
      done,
      end: () => {
        call.ended = true;
        // The server finishes what was said, then closes.
        call.onMessage({
          type: "transcript.partial",
          is_final: true,
          speech_final: true,
          text: "最後まで",
          start: 0,
        });
        resolve();
      },
    };
  }) as typeof streamSpeech;
  const errors: unknown[] = [];
  const players: { played: string[]; stopped: boolean }[] = [];
  const clipEnds: (() => void)[] = [];
  const port = new DiscordRecordingPort(
    client as never,
    runtime,
    (e) => errors.push(e),
    {
      joinVoiceChannel: (() => connection) as never,
      // A player reaches Idle when its clip ends; the connection is Ready.
      entersState: (async (target: unknown) => {
        if (options.holdClips && players.includes(target as never))
          await new Promise<void>((r) => clipEnds.push(r));
        return target;
      }) as never,
      getVoiceConnection: (() => options.existing) as never,
      streamSpeech: fakeStream,
      createAudioPlayer: (() => {
        const player = Object.assign(new EventEmitter(), {
          played: [] as string[],
          stopped: false,
          play(resource: { path: string }) {
            this.played.push(resource.path);
          },
          stop() {
            this.stopped = true;
            return true;
          },
        });
        players.push(player);
        return player;
      }) as never,
      createAudioResource: ((path: string) => ({ path })) as never,
    },
  );
  const heard: { userId: string; name: string; text: string }[] = [];
  let disconnected = 0;
  let failing = 0;
  /** Each stretch of speech whose audio was kept, by speaker. */
  const audio: { userId: string; packets: string[]; ended: boolean }[] = [];
  const events = {
    utterance: (userId: string, name: string, _at: number, text: string) =>
      heard.push({ userId, name, text }),
    disconnected: () => disconnected++,
    failing: () => failing++,
    audio: (userId: string) => {
      const kept = { userId, packets: [] as string[], ended: false };
      audio.push(kept);
      return {
        packet: (data: Uint8Array) =>
          kept.packets.push(Buffer.from(data).toString()),
        end: () => {
          kept.ended = true;
        },
      };
    },
  };
  return {
    port,
    connection,
    speaking,
    streams,
    lookups,
    heard,
    errors,
    events,
    audio,
    disconnected: () => disconnected,
    failing: () => failing,
    players,
    /** The clip playing now ends. */
    finishClip: () => clipEnds.shift()?.(),
    join: () => port.join("g1", "vc1", events),
    /** The speaker sends a packet. */
    say: (userId: string, packet: string) =>
      subscriptions.get(userId)!.write(Buffer.from(packet)),
    /** The speaker pauses: Discord's receive stream ends. */
    pause: (userId: string) => subscriptions.get(userId)?.destroy(),
  };
}
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

describe("DiscordRecordingPort.join", () => {
  test("each speaker's speech goes to its own stream, and what the server finishes is heard under their name", async () => {
    const s = setup();
    await s.join();
    s.speaking.emit("start", "u1");
    s.speaking.emit("start", "u2");
    await tick();
    expect(s.streams.map((c) => c.userId)).toEqual(["u1", "u2"]);
    s.streams[0]!.onMessage({
      type: "transcript.partial",
      is_final: true,
      speech_final: true,
      text: "おはようございます",
      start: 0.5,
    });
    expect(s.heard).toEqual([
      { userId: "u1", name: "name-u1", text: "おはようございます" },
    ]);
  });

  test("a speaker who talks again while the last utterance is still being finished is heard again", async () => {
    const s = setup();
    await s.join();
    s.speaking.emit("start", "u1");
    await tick();
    // The receive stream ends at the pause; the xAI stream is still open.
    s.pause("u1");
    await tick();
    s.speaking.emit("start", "u1");
    await tick();
    expect(s.streams.length).toBe(2);
    expect(s.streams[1]!.userId).toBe("u1");
  });

  test("still talking when a stream reaches its limit, the speaker carries on in a new one", async () => {
    const s = setup();
    await s.join();
    s.speaking.users.set("u1", 1);
    s.speaking.emit("start", "u1");
    await tick();
    // Five minutes of speech: xAI has been sending text.
    s.streams[0]!.onMessage({
      type: "transcript.partial",
      is_final: true,
      speech_final: false,
      text: "説明を続けます",
      start: 0,
    });
    // The stream reaches its limit; the speaker is still received.
    s.streams[0]!.finish();
    await tick(20);
    expect(s.streams.length).toBe(2);
    expect(s.streams[1]!.userId).toBe("u1");
    // What the speaker says next goes to the new stream.
    s.say("u1", "next");
    await tick();
    expect(s.streams[1]!.opus.read()?.toString()).toBe("next");
    // Not talking any more: no new stream.
    s.pause("u1");
    await tick(20);
    expect(s.streams.length).toBe(2);
  });

  test("other bots are never transcribed, and not looked up again", async () => {
    const s = setup({ bots: ["music"] });
    await s.join();
    s.speaking.emit("start", "music");
    await tick();
    s.speaking.emit("start", "music");
    await tick();
    expect(s.streams).toEqual([]);
    expect(s.lookups).toEqual(["music"]);
  });

  test("a member lookup that keeps failing does not loop", async () => {
    const s = setup({ failLookup: true });
    await s.join();
    s.speaking.users.set("u1", 1);
    s.speaking.emit("start", "u1");
    await tick(30);
    expect(s.lookups).toEqual(["u1"]);
    expect(s.errors.length).toBe(1);
  });

  test("at most eight speakers are transcribed at once", async () => {
    const s = setup();
    await s.join();
    for (let i = 0; i < 10; i++) s.speaking.emit("start", `u${i}`);
    await tick();
    expect(s.streams.length).toBe(8);
  });

  test("utterances still being finished count too: at most sixteen xAI streams at once", async () => {
    const s = setup();
    await s.join();
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 8; i++) s.speaking.emit("start", `u${round}-${i}`);
      await tick();
      // They pause; xAI is still finishing each of them.
      for (let i = 0; i < 8; i++) s.pause(`u${round}-${i}`);
      await tick();
    }
    expect(s.streams.length).toBe(16);
  });

  test("xAI refusing every stream is not retried while someone talks, and is reported once five have failed", async () => {
    const s = setup({ refuse: true });
    await s.join();
    s.speaking.users.set("u1", 1);
    s.speaking.emit("start", "u1");
    await tick(30);
    // No reconnect loop, and still received.
    expect(s.streams.length).toBe(1);
    s.speaking.emit("start", "u1");
    await tick();
    expect(s.streams.length).toBe(1);
    // Each pause ends the speech; the next one is tried again.
    for (let i = 0; i < 6; i++) {
      s.pause("u1");
      await tick();
      s.speaking.emit("start", "u1");
      await tick();
    }
    expect(s.streams.length).toBe(7);
    expect(s.failing()).toBe(1);
  });

  test("the audio is kept for as long as the speaker is received, even when xAI refuses the stream (#138)", async () => {
    const s = setup({ refuse: true });
    await s.join();
    s.speaking.emit("start", "u1");
    await tick();
    s.say("u1", "a");
    await tick();
    // xAI has refused; the speaker goes on.
    s.say("u1", "b");
    s.say("u1", "c");
    await tick();
    expect(s.audio).toEqual([
      { userId: "u1", packets: ["a", "b", "c"], ended: false },
    ]);
    s.pause("u1");
    await tick();
    expect(s.audio[0]!.ended).toBe(true);
  });

  test("each stretch of speech is its own audio, and other bots' audio is not kept (#138)", async () => {
    const s = setup({ bots: ["music"] });
    await s.join();
    s.speaking.emit("start", "music");
    s.speaking.emit("start", "u1");
    await tick();
    s.say("u1", "one");
    s.pause("u1");
    await tick();
    s.speaking.emit("start", "u1");
    await tick();
    s.say("u1", "two");
    await tick();
    expect(s.audio.map((a) => [a.userId, a.packets, a.ended])).toEqual([
      ["u1", ["one"], true],
      ["u1", ["two"], false],
    ]);
    // The xAI stream got the same packets.
    expect(s.streams[1]!.opus.read()?.toString()).toBe("two");
  });

  test("xAI closing every stream right after it is ready is not retried while someone talks either (second review)", async () => {
    for (const how of ["quietly", "with an error"] as const) {
      const s = setup({ closeAfterReady: how });
      await s.join();
      s.speaking.users.set("u1", 1);
      s.speaking.emit("start", "u1");
      await tick(30);
      expect(s.streams.length).toBe(1);
      s.speaking.emit("start", "u1");
      await tick();
      expect(s.streams.length).toBe(1);
      for (let i = 0; i < 5; i++) {
        s.pause("u1");
        await tick();
        s.speaking.emit("start", "u1");
        await tick();
      }
      // An error event counts as a failure; a quiet close does not.
      expect(s.failing()).toBe(how === "with an error" ? 1 : 0);
    }
  });

  test("a voice connection already open in the server (a /join call connecting) is not taken", async () => {
    const s = setup({ existing: { state: { status: "connecting" } } });
    await expect(s.join()).rejects.toThrow("接続しています");
    const t = setup({ existing: { state: { status: "destroyed" } } });
    await t.join();
  });

  test("leaving with flush finishes open speech before it disconnects; without, at once", async () => {
    const s = setup();
    const handle = await s.join();
    s.speaking.emit("start", "u1");
    await tick();
    await handle.leave(true);
    expect(s.streams[0]!.ended).toBe(true);
    expect(s.heard.map((h) => h.text)).toEqual(["最後まで"]);
    // The receive stream ended too, and the audio with it.
    expect(s.audio[0]!.ended).toBe(true);
    expect(s.connection.destroyed).toBe(true);
    // Nothing more is listened to.
    s.speaking.emit("start", "u2");
    await tick();
    expect(s.streams.length).toBe(1);

    const t = setup();
    const other = await t.join();
    t.speaking.emit("start", "u1");
    await tick();
    await other.leave(false);
    expect(t.streams[0]!.ended).toBe(false);
    expect(t.connection.destroyed).toBe(true);
  });

  test("a disconnection that does not recover is reported once the bot gives up", async () => {
    const s = setup();
    const port = new DiscordRecordingPort(
      {
        guilds: { fetch: async () => ({ voiceAdapterCreator: () => ({}) }) },
      } as never,
      new Runtime(loadConfig({ ANTHROPIC_API_KEY: "fixture" })),
      () => {},
      {
        joinVoiceChannel: (() => s.connection) as never,
        entersState: (async (_c: unknown, status: string) => {
          if (status !== "ready") throw new Error("timeout");
          return s.connection;
        }) as never,
        getVoiceConnection: (() => undefined) as never,
        streamSpeech: (() => ({
          done: new Promise(() => {}),
          end() {},
        })) as never,
      },
    );
    await port.join("g1", "vc1", s.events);
    s.connection.emit("disconnected");
    await tick();
    expect(s.disconnected()).toBe(1);
  });
});

describe("scheduled clips during a recording", () => {
  test("a clip unmutes the recording while it plays, then mutes it again", async () => {
    const s = setup();
    const handle = await s.join();
    expect(await handle.play("/assets/ema.wav", 300_000)).toBe(true);
    expect(s.players.map((p) => p.played)).toEqual([["/assets/ema.wav"]]);
    expect(s.connection.mutes).toEqual([false, true]);
    expect(s.connection.unsubscribed).toBe(1);
    expect(s.players[0]!.stopped).toBe(true);
    expect(s.errors).toEqual([]);
  });

  test("a second clip waits for the one playing, which is not cut off", async () => {
    const s = setup({ holdClips: true });
    const handle = await s.join();
    const first = handle.play("/assets/a.wav", 300_000);
    const second = handle.play("/assets/b.wav", 300_000);
    await tick();
    expect(s.players).toHaveLength(1);
    expect(s.players[0]!.stopped).toBe(false);
    s.finishClip();
    await first;
    await tick();
    expect(s.players).toHaveLength(2);
    s.finishClip();
    await second;
    expect(s.connection.mutes).toEqual([false, true, false, true]);
  });

  test("leaving stops the clip, and nothing plays after", async () => {
    const s = setup({ holdClips: true });
    const handle = await s.join();
    const playing = handle.play("/assets/a.wav", 300_000);
    await tick();
    await handle.leave(false);
    expect(s.players[0]!.stopped).toBe(true);
    s.finishClip();
    await playing;
    // Left: no voice state is sent on a destroyed connection.
    expect(s.connection.mutes).toEqual([false]);
    expect(await handle.play("/assets/b.wav", 300_000)).toBe(false);
    expect(s.players).toHaveLength(1);
  });
});

describe("direct messages (#152)", () => {
  const portWith = (
    users: Record<string, { bot: boolean; error?: unknown }>,
  ) => {
    const sent: { userId: string; payload: Record<string, unknown> }[] = [];
    const client = {
      users: {
        fetch: async (id: string) => {
          const user = users[id];
          if (!user)
            throw Object.assign(new Error("Unknown User"), { code: 10013 });
          return {
            bot: user.bot,
            send: async (payload: Record<string, unknown>) => {
              if (user.error) throw user.error;
              sent.push({ userId: id, payload });
            },
          };
        },
      },
    };
    const port = new DiscordRecordingPort(
      client as never,
      new Runtime(loadConfig({ ANTHROPIC_API_KEY: "fixture" })),
      () => {},
    );
    return { port, sent };
  };

  test("a person is sent it with the file, and nobody is pinged", async () => {
    const t = portWith({ u1: { bot: false } });
    expect(
      await t.port.direct("u1", {
        content: "要約",
        files: [{ name: "transcript.txt", data: Buffer.from("全文") }],
      }),
    ).toBe("sent");
    expect(t.sent[0]!.payload.allowedMentions).toEqual({ parse: [] });
    expect((t.sent[0]!.payload.files as unknown[]).length).toBe(1);
  });

  test("a bot is not sent it", async () => {
    const t = portWith({ b1: { bot: true } });
    expect(await t.port.direct("b1", { content: "要約" })).toBe("bot");
    expect(t.sent).toEqual([]);
  });

  test("a closed inbox, or no server in common, is 'closed'; anything else throws", async () => {
    const t = portWith({
      closed: {
        bot: false,
        error: Object.assign(new Error("Cannot send"), { code: 50007 }),
      },
      left: {
        bot: false,
        error: Object.assign(new Error("No mutual guilds"), { code: 50278 }),
      },
      limited: {
        bot: false,
        error: Object.assign(new Error("Rate limited"), { code: 20016 }),
      },
    });
    expect(await t.port.direct("closed", { content: "要約" })).toBe("closed");
    expect(await t.port.direct("left", { content: "要約" })).toBe("closed");
    await expect(t.port.direct("limited", { content: "要約" })).rejects.toThrow(
      "Rate limited",
    );
    await expect(t.port.direct("gone", { content: "要約" })).rejects.toThrow(
      "Unknown User",
    );
  });
});

describe("icons for the recording's page (#155)", () => {
  type Owner = { bot: boolean; url: string };
  const portWith = (o: {
    members?: Record<string, Owner>;
    users?: Record<string, Owner>;
    respond?: (url: string) => Response;
  }) => {
    const asked: { url: string; options: unknown }[] = [];
    const fetched: string[] = [];
    const avatarOf = (owner: Owner) => (options: unknown) => {
      asked.push({ url: owner.url, options });
      return owner.url;
    };
    const client = {
      guilds: {
        fetch: async () => ({
          members: {
            fetch: async (id: string) => {
              const m = o.members?.[id];
              if (!m) throw new Error("Unknown Member");
              return {
                user: { bot: m.bot },
                displayAvatarURL: avatarOf(m),
              };
            },
          },
        }),
      },
      users: {
        fetch: async (id: string) => {
          const u = o.users?.[id];
          if (!u) throw new Error("Unknown User");
          return { bot: u.bot, displayAvatarURL: avatarOf(u) };
        },
      },
    };
    const port = new DiscordRecordingPort(
      client as never,
      new Runtime(loadConfig({ ANTHROPIC_API_KEY: "fixture" })),
      () => {},
      {
        fetch: async (url) => {
          fetched.push(url);
          return (
            o.respond?.(url) ??
            new Response(new Uint8Array([1, 2, 3]), {
              headers: { "content-type": "image/webp" },
            })
          );
        },
      },
    );
    return { port, asked, fetched };
  };

  test("the member's icon in the server, 512 px and still", async () => {
    const t = portWith({
      members: { u1: { bot: false, url: "https://cdn/guild-icon" } },
      users: { u1: { bot: false, url: "https://cdn/user-icon" } },
    });
    const avatar = await t.port.avatar("1001", "u1");
    expect(avatar).toEqual({ data: Buffer.from([1, 2, 3]), ext: "webp" });
    expect(t.fetched).toEqual(["https://cdn/guild-icon"]);
    expect(t.asked[0]!.options).toEqual({
      extension: "webp",
      size: 512,
      forceStatic: true,
    });
  });

  test("someone who left the server: their own icon", async () => {
    const t = portWith({
      users: { u1: { bot: false, url: "https://cdn/user-icon" } },
    });
    expect((await t.port.avatar("1001", "u1"))!.ext).toBe("webp");
    expect(t.fetched).toEqual(["https://cdn/user-icon"]);
  });

  test("Discord's default icon comes as PNG", async () => {
    const t = portWith({
      members: { u1: { bot: false, url: "https://cdn/embed/avatars/0.png" } },
      respond: () =>
        new Response(new Uint8Array([9]), {
          headers: { "content-type": "image/png" },
        }),
    });
    expect((await t.port.avatar("1001", "u1"))!.ext).toBe("png");
  });

  test("a bot has none taken", async () => {
    const t = portWith({
      members: { b1: { bot: true, url: "https://cdn/b" } },
    });
    expect(await t.port.avatar("1001", "b1")).toBeNull();
    expect(t.fetched).toEqual([]);
  });

  test("an error, something not an image, or one over 1 MB throws", async () => {
    const member = { u1: { bot: false, url: "https://cdn/icon" } };
    await expect(
      portWith({
        members: member,
        respond: () => new Response("", { status: 404 }),
      }).port.avatar("1001", "u1"),
    ).rejects.toThrow("HTTP 404");
    await expect(
      portWith({
        members: member,
        respond: () =>
          new Response("<html>", { headers: { "content-type": "text/html" } }),
      }).port.avatar("1001", "u1"),
    ).rejects.toThrow("not an image");
    await expect(
      portWith({
        members: member,
        respond: () =>
          new Response(new Uint8Array(1_000_001), {
            headers: { "content-type": "image/webp" },
          }),
      }).port.avatar("1001", "u1"),
    ).rejects.toThrow("too large");
    await expect(portWith({}).port.avatar("1001", "gone")).rejects.toThrow(
      "Unknown User",
    );
  });
});

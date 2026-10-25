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
  opus: PassThrough;
  onMessage: (data: Record<string, unknown>) => void;
  finish: () => void;
  ended: boolean;
};

function setup(
  options: {
    bots?: string[];
    failLookup?: boolean;
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
  const lookups: string[] = [];
  const connection = Object.assign(new EventEmitter(), {
    state: { status: "ready" },
    destroyed: false,
    destroy() {
      this.destroyed = true;
      this.state.status = "destroyed";
    },
    receiver: {
      speaking,
      subscribe(userId: string) {
        const opus = new PassThrough();
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
      userId: [...subscriptions].find(([, s]) => s === o.opus)![0],
      opus: o.opus as PassThrough,
      onMessage: o.onMessage as StreamCall["onMessage"],
      finish: resolve,
      ended: false,
    };
    streams.push(call);
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
  const port = new DiscordRecordingPort(
    client as never,
    runtime,
    (e) => errors.push(e),
    {
      joinVoiceChannel: (() => connection) as never,
      entersState: (async () => connection) as never,
      streamSpeech: fakeStream,
    },
  );
  const heard: { userId: string; name: string; text: string }[] = [];
  let disconnected = 0;
  const events = {
    utterance: (userId: string, name: string, _at: number, text: string) =>
      heard.push({ userId, name, text }),
    disconnected: () => disconnected++,
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
    disconnected: () => disconnected,
    join: () => port.join("g1", "vc1", events),
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
    s.streams[0]!.opus.destroy();
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
    s.streams[0]!.opus.destroy();
    await tick(20);
    expect(s.streams.length).toBe(2);
    // Not talking any more: no new stream.
    s.speaking.users.delete("u1");
    s.streams[1]!.opus.destroy();
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

  test("leaving with flush finishes open speech before it disconnects; without, at once", async () => {
    const s = setup();
    const handle = await s.join();
    s.speaking.emit("start", "u1");
    await tick();
    await handle.leave(true);
    expect(s.streams[0]!.ended).toBe(true);
    expect(s.heard.map((h) => h.text)).toEqual(["最後まで"]);
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

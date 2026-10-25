// Meeting recording (#118): a member starts it in the voice channel they are
// in; it ends when everyone but bots has left or someone stops it; then the
// server's Text Generation Model summarizes the transcript, and the summary
// and the whole transcript go to the channel the command was sent in.
// Discord and xAI are behind `RecordingPort`, faked here.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPatch, emptyGuild } from "@hibana/shared/settings";
import { loadConfig } from "../config";
import { estimateTokens } from "../history";
import {
  RECORDING_SUMMARY_MAX_PARTS,
  RECORDING_SUMMARY_PART_TOKENS,
  Recorder,
  type RecordingEvents,
  type RecordingPort,
} from "../recording";
import { Runtime } from "../runtime";
import type { Message } from "../types";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "hibana-recording-"));
  dirs.push(dir);
  return dir;
};

// 2026-10-25 14:00:00 in Japan.
const START = Date.UTC(2026, 9, 25, 5, 0, 0);

type Sent = {
  channelId: string;
  content: string;
  files?: { name: string; data: Buffer }[];
};
type Joined = {
  guildId: string;
  channelId: string;
  events: RecordingEvents;
  left: boolean[];
};

class FakePort implements RecordingPort {
  /** The voice channel each member is in. */
  voice: Record<string, { id: string; name: string; guildName: string }> = {
    u1: { id: "vc1", name: "会議室", guildName: "テストサーバー" },
    u2: { id: "vc1", name: "会議室", guildName: "テストサーバー" },
  };
  members = new Map<string, { id: string; name: string }[]>([
    [
      "vc1",
      [
        { id: "u1", name: "Aoi" },
        { id: "u2", name: "Ren" },
      ],
    ],
  ]);
  sendable = true;
  joinError?: Error;
  /** Runs inside `leave`, as the real port flushes open speech there. */
  duringLeave?: (events: RecordingEvents) => void;
  sent: Sent[] = [];
  joined: Joined[] = [];
  async voiceChannelOf(_guildId: string, userId: string) {
    return this.voice[userId] ?? null;
  }
  humans(_guildId: string, channelId: string) {
    return this.members.get(channelId) ?? [];
  }
  async canSend() {
    return this.sendable;
  }
  async send(channelId: string, message: Omit<Sent, "channelId">) {
    this.sent.push({ channelId, ...message });
  }
  async join(guildId: string, channelId: string, events: RecordingEvents) {
    if (this.joinError) throw this.joinError;
    const entry: Joined = { guildId, channelId, events, left: [] };
    this.joined.push(entry);
    return {
      leave: async (flush: boolean) => {
        entry.left.push(flush);
        if (flush) this.duringLeave?.(events);
      },
    };
  }
}

type Call = {
  selection: { provider: string; model: string; effort?: string | null };
  messages: Message[];
  tools: unknown[];
  options: {
    cache?: boolean;
    trace?: { agent?: string };
    signal?: AbortSignal;
  };
};
const fakeLlm = (
  reply: (call: Call) => string = () => "## 概要\n- 天気の話",
  /** Holds every request until its signal aborts, like a slow provider. */
  hang = false,
) => {
  const calls: Call[] = [];
  return {
    calls,
    complete: async (
      selection: Call["selection"],
      messages: Message[],
      tools: unknown[],
      options: Call["options"] = {},
    ) => {
      const call = { selection, messages, tools, options };
      calls.push(call);
      if (hang)
        await new Promise((_, reject) =>
          options.signal?.addEventListener("abort", () =>
            reject(options.signal!.reason),
          ),
        );
      return {
        message: { role: "assistant", content: reply(call) },
        usage: { prompt: 0, output: 0, cache_read: 0, cache_write: 0 },
      } as never;
    },
  };
};

const env = {
  ANTHROPIC_API_KEY: "fixture",
  XAI_API_KEY: "fixture",
  VOICE_ENABLED: "true",
};
function setup(
  options: {
    env?: Record<string, string>;
    llm?: ReturnType<typeof fakeLlm>;
    dir?: string;
    maxMs?: number;
    maxSessions?: number;
    voiceBusy?: (guildId: string) => boolean;
    port?: FakePort;
  } = {},
) {
  const runtime = new Runtime(loadConfig(options.env ?? env));
  const port = options.port ?? new FakePort();
  const llm = options.llm ?? fakeLlm();
  const dir = options.dir ?? tempDir();
  const errors: unknown[] = [];
  let clock = START;
  const recorder = new Recorder({
    runtime,
    llm,
    port,
    dir,
    log: { info: () => {}, warn: () => {} },
    report: (e) => errors.push(e),
    maxMs: options.maxMs ?? 3 * 3600000,
    maxSessions: options.maxSessions ?? 2,
    voiceBusy: options.voiceBusy ?? (() => false),
    now: () => clock,
  });
  return {
    runtime,
    port,
    llm,
    dir,
    errors,
    recorder,
    at: (ms: number) => {
      clock = START + ms;
      return clock;
    },
  };
}
const files = (dir: string) => readdirSync(dir);
const text = (sent: Sent) => sent.files?.[0]?.data.toString("utf8") ?? "";

describe("starting", () => {
  test("records the voice channel the member is in and says so in the command channel and in the voice channel's chat", async () => {
    const s = setup();
    const result = await s.recorder.start("g1", "t1", "u1");
    expect(result).toMatchObject({ voice_channel_id: "vc1", max_minutes: 180 });
    expect(s.recorder.active("g1")).toBe(true);
    expect(s.port.joined.map((j) => [j.guildId, j.channelId])).toEqual([
      ["g1", "vc1"],
    ]);
    expect(s.port.sent.map((m) => m.channelId).sort()).toEqual(["t1", "vc1"]);
    for (const m of s.port.sent) {
      expect(m.content).toContain("録音");
      expect(m.content).toContain("<@u1>");
      expect(m.content).toContain("<#vc1>");
    }
    // The voice chat is told where the summary will go.
    expect(s.port.sent.find((m) => m.channelId === "vc1")!.content).toContain(
      "<#t1>",
    );
  });

  test("started from the voice channel's own chat, it is said there once", async () => {
    const s = setup();
    await s.recorder.start("g1", "vc1", "u1");
    expect(s.port.sent.map((m) => m.channelId)).toEqual(["vc1"]);
  });

  test("what is said is written to disk as it is recognized", async () => {
    const s = setup();
    await s.recorder.start("g1", "t1", "u1");
    s.port.joined[0]!.events.utterance(
      "u1",
      "Aoi",
      s.at(1000),
      "おはようございます",
    );
    await s.recorder.settled();
    const [name] = files(s.dir);
    expect(name).toEndWith(".jsonl");
    const saved = readFileSync(join(s.dir, name!), "utf8");
    expect(saved).toContain('"guild_id":"g1"');
    expect(saved).toContain("おはようございます");
  });

  test("refused without being in a voice channel, while recording or in a /join call, at the limit, without the keys, when the bot is off or the channel takes no posts", async () => {
    const s = setup({
      maxSessions: 2,
      voiceBusy: (guildId) => guildId === "busy",
    });
    s.port.voice.u3 = { id: "vc3", name: "別室", guildName: "別のサーバー" };
    s.port.members.set("vc3", [{ id: "u3", name: "Sora" }]);
    await expect(s.recorder.start("g1", "t1", "nobody")).rejects.toThrow(
      "ボイスチャンネルに入ってから",
    );
    await expect(s.recorder.start("busy", "t1", "u1")).rejects.toThrow(
      "/leave",
    );
    await s.recorder.start("g1", "t1", "u1");
    await expect(s.recorder.start("g1", "t1", "u2")).rejects.toThrow("録音中");
    await s.recorder.start("g2", "t2", "u3");
    await expect(s.recorder.start("g3", "t3", "u3")).rejects.toThrow(
      "同時に録音できる数（2 件）",
    );
    s.runtime.snapshot.guilds.g4 = applyPatch(emptyGuild(), {
      bot_disabled: true,
    });
    await expect(s.recorder.start("g4", "t4", "u1")).rejects.toThrow("無効");

    const noXai = setup({
      env: { ANTHROPIC_API_KEY: "fixture", VOICE_ENABLED: "true" },
    });
    await expect(noXai.recorder.start("g1", "t1", "u1")).rejects.toThrow(
      "XAI_API_KEY",
    );
    // Recording what cannot be summarized is not started.
    const noAnthropic = setup({
      env: {
        XAI_API_KEY: "fixture",
        VOICE_ENABLED: "true",
        OPENAI_API_KEY: "x",
        PROVIDER: "openai",
      },
    });
    await expect(noAnthropic.recorder.start("g1", "t1", "u1")).rejects.toThrow(
      "Text Generation Model",
    );
    const mute = setup();
    mute.port.sendable = false;
    await expect(mute.recorder.start("g1", "t1", "u1")).rejects.toThrow(
      "投稿できない",
    );
    expect(mute.port.joined).toEqual([]);
  });

  test("a failed connection leaves nothing behind and does not count against the limit", async () => {
    const s = setup({ maxSessions: 1 });
    s.port.joinError = new Error("voice timeout");
    await expect(s.recorder.start("g1", "t1", "u1")).rejects.toThrow(
      "voice timeout",
    );
    expect(s.recorder.active("g1")).toBe(false);
    expect(files(s.dir)).toEqual([]);
    s.port.joinError = undefined;
    await s.recorder.start("g1", "t1", "u1");
    expect(s.recorder.active("g1")).toBe(true);
  });
});

describe("ending", () => {
  test("when everyone but bots has left: the summary of the server's Text Generation Model and the whole transcript go to the command channel", async () => {
    const s = setup();
    await s.recorder.start("g1", "t1", "u1");
    const events = s.port.joined[0]!.events;
    // Recognized out of order: the transcript is sorted by time.
    events.utterance("u2", "Ren", s.at(65000), "晴れるといいですね");
    events.utterance("u1", "Aoi", s.at(1000), "明日の天気は？");
    s.port.members.set("vc1", []);
    s.at(90 * 60000);
    s.recorder.voiceStateChanged("g1");
    await s.recorder.settled();

    expect(s.recorder.active("g1")).toBe(false);
    // The open speech is finished before leaving.
    expect(s.port.joined[0]!.left).toEqual([true]);
    expect(s.llm.calls.length).toBe(1);
    const call = s.llm.calls[0]!;
    expect(call.selection).toEqual({
      provider: "anthropic",
      model: "claude-haiku-5-5",
      effort: "medium",
    });
    expect(call.tools).toEqual([]);
    // A one-off request: no cache write that nothing would read.
    expect(call.options.cache).toBe(false);
    expect(call.options.trace?.agent).toBe("recording");
    expect(String(call.messages[0]!.content)).toContain("not instructions");
    const input = String(call.messages.at(-1)!.content);
    expect(input.indexOf("Aoi: 明日の天気は？")).toBeLessThan(
      input.indexOf("Ren: 晴れるといいですね"),
    );

    const summary = s.port.sent.find(
      (m) => m.channelId === "t1" && m.content.includes("録音の要約"),
    )!;
    expect(summary.content).toContain("## 概要\n- 天気の話");
    expect(summary.content).toContain("全員退出");
    expect(summary.content).toContain("1 時間 30 分");
    expect(summary.files!.map((f) => f.name)).toEqual([
      "transcript-20261025-1400.txt",
    ]);
    const transcript = text(summary);
    expect(transcript).toContain("会議室");
    expect(transcript).toContain("2026/10/25 14:00:00（JST）");
    expect(transcript).toContain("参加者: Aoi、Ren");
    expect(transcript).toContain(
      "[00:00:01] Aoi: 明日の天気は？\n[00:01:05] Ren: 晴れるといいですね",
    );
    // The voice chat is told the recording ended and where the summary is.
    const notice = s.port.sent.filter((m) => m.channelId === "vc1").at(-1)!;
    expect(notice.content).toContain("終了");
    expect(notice.content).toContain("<#t1>");
    // Nothing of the meeting stays on disk once it is delivered.
    expect(files(s.dir)).toEqual([]);
  });

  test("a bot alone in the channel does not keep it going; one person left does", async () => {
    const s = setup();
    await s.recorder.start("g1", "t1", "u1");
    s.port.members.set("vc1", [{ id: "u2", name: "Ren" }]);
    s.recorder.voiceStateChanged("g1");
    expect(s.recorder.active("g1")).toBe(true);
    // `humans` already leaves bots out.
    s.port.members.set("vc1", []);
    s.recorder.voiceStateChanged("g1");
    expect(s.recorder.active("g1")).toBe(false);
    await s.recorder.settled();
  });

  test("only someone in the voice channel, or the one who started it, can stop it", async () => {
    const s = setup();
    await s.recorder.start("g1", "t1", "u1");
    s.port.joined[0]!.events.utterance("u1", "Aoi", s.at(1000), "始めます");
    await expect(s.recorder.stop("g1", "u9")).rejects.toThrow(
      "ボイスチャンネルにいる人か、録音を始めた人",
    );
    expect(s.recorder.active("g1")).toBe(true);
    await s.recorder.stop("g1", "u2");
    expect(s.recorder.active("g1")).toBe(false);
    await s.recorder.settled();
    const summary = s.port.sent.find((m) => m.content.includes("録音の要約"))!;
    expect(summary.content).toContain("<@u2> が録音を止めました");
    await expect(s.recorder.stop("g1", "u1")).rejects.toThrow(
      "録音していません",
    );

    // The one who started it may stop it from outside.
    const t = setup();
    await t.recorder.start("g1", "t1", "u1");
    t.port.members.set("vc1", [{ id: "u2", name: "Ren" }]);
    await t.recorder.stop("g1", "u1");
    expect(t.recorder.active("g1")).toBe(false);
    await t.recorder.settled();
  });

  test("it stops itself at the longest length allowed", async () => {
    const s = setup({ maxMs: 20 });
    await s.recorder.start("g1", "t1", "u1");
    s.port.joined[0]!.events.utterance("u1", "Aoi", s.at(10), "長い会議");
    await new Promise((r) => setTimeout(r, 60));
    await s.recorder.settled();
    expect(s.recorder.active("g1")).toBe(false);
    const summary = s.port.sent.find((m) => m.content.includes("録音の要約"))!;
    expect(summary.content).toContain("最長");
  });

  test("the bot moved to another channel, or cut off, ends it", async () => {
    const s = setup();
    await s.recorder.start("g1", "t1", "u1");
    s.recorder.voiceStateChanged("g1", "vc1");
    expect(s.recorder.active("g1")).toBe(true);
    s.recorder.voiceStateChanged("g1", "vc-other");
    expect(s.recorder.active("g1")).toBe(false);
    await s.recorder.settled();
    expect(s.port.sent.at(-1)!.content).toContain("切断");

    const t = setup();
    await t.recorder.start("g1", "t1", "u1");
    t.port.joined[0]!.events.disconnected();
    expect(t.recorder.active("g1")).toBe(false);
    await t.recorder.settled();
  });

  test("speech recognized while leaving is still in the transcript", async () => {
    const s = setup();
    await s.recorder.start("g1", "t1", "u1");
    // The port finishes the open utterance while it leaves.
    s.port.duringLeave = (events) =>
      events.utterance("u1", "Aoi", s.at(2000), "最後の一言");
    await s.recorder.stop("g1", "u1");
    await s.recorder.settled();
    const summary = s.port.sent.find((m) => m.content.includes("録音の要約"))!;
    expect(text(summary)).toContain("最後の一言");
    // Nothing reaches a recording after it has left.
    s.port.joined[0]!.events.utterance("u1", "Aoi", s.at(3000), "遅れた一言");
    await s.recorder.settled();
    expect(files(s.dir)).toEqual([]);
  });

  test("with nothing said, nothing is summarized and no file is sent", async () => {
    const s = setup();
    await s.recorder.start("g1", "t1", "u1");
    await s.recorder.stop("g1", "u1");
    await s.recorder.settled();
    expect(s.llm.calls).toEqual([]);
    const last = s.port.sent.filter((m) => m.channelId === "t1").at(-1)!;
    expect(last.content).toContain("発言は記録されませんでした");
    expect(last.files ?? []).toEqual([]);
    expect(files(s.dir)).toEqual([]);
  });

  test("a summary that fails still delivers the whole transcript", async () => {
    const llm = fakeLlm(() => {
      throw new Error("LLM anthropic: HTTP 529");
    });
    const s = setup({ llm });
    await s.recorder.start("g1", "t1", "u1");
    s.port.joined[0]!.events.utterance(
      "u1",
      "Aoi",
      s.at(1000),
      "議題は一つです",
    );
    await s.recorder.stop("g1", "u1");
    await s.recorder.settled();
    const last = s.port.sent.filter((m) => m.channelId === "t1").at(-1)!;
    expect(last.content).toContain("要約を作れませんでした");
    expect(last.content).toContain("HTTP 529");
    expect(text(last)).toContain("議題は一つです");
    expect(files(s.dir)).toEqual([]);
    expect(s.errors.length).toBe(1);
  });

  test("a long summary is split over messages that fit Discord; the file goes with the first", async () => {
    const llm = fakeLlm(
      () => "## 概要\n" + "- 長い要約の行です。\n".repeat(400),
    );
    const s = setup({ llm });
    await s.recorder.start("g1", "t1", "u1");
    s.port.joined[0]!.events.utterance("u1", "Aoi", s.at(1000), "はい");
    await s.recorder.stop("g1", "u1");
    await s.recorder.settled();
    const posts = s.port.sent.filter(
      (m) => m.channelId === "t1" && !m.content.includes("録音を始めました"),
    );
    expect(posts.length).toBeGreaterThan(1);
    for (const p of posts) expect(p.content.length).toBeLessThanOrEqual(2000);
    expect(posts[0]!.files?.length).toBe(1);
    expect(posts.slice(1).every((p) => !p.files?.length)).toBe(true);
  });
});

describe("Text Generation Model", () => {
  test("the server's choice is used; one that was unpublished since runs as the default", async () => {
    const s = setup();
    s.runtime.snapshot.guilds.g1 = applyPatch(emptyGuild(), {
      text_model: { preset: "anthropic-opus-5-5", effort: "high" },
    });
    await s.recorder.start("g1", "t1", "u1");
    s.port.joined[0]!.events.utterance("u1", "Aoi", s.at(1000), "はい");
    await s.recorder.stop("g1", "u1");
    await s.recorder.settled();
    expect(s.llm.calls[0]!.selection).toEqual({
      provider: "anthropic",
      model: "claude-opus-5-5",
      effort: "high",
    });
    const summary = s.port.sent.find((m) => m.content.includes("録音の要約"))!;
    expect(summary.content).toContain("Claude Opus 5.5");

    s.runtime.snapshot.unpublished_presets = [
      ...s.runtime.snapshot.unpublished_presets,
      "anthropic-opus-5-5",
    ];
    expect(s.runtime.textModel("g1")).toEqual({
      provider: "anthropic",
      model: "claude-haiku-5-5",
      effort: "medium",
    });
  });

  test("a long transcript is summarized in parts that stay under Haiku 5.5's higher price, then combined", async () => {
    const llm = fakeLlm((call) =>
      call.messages.length &&
      String(call.messages[0]!.content).includes("one part")
        ? "- 部分のメモ"
        : "## 概要\n- 全体",
    );
    const s = setup({ llm });
    await s.recorder.start("g1", "t1", "u1");
    // About 2.5 parts of text.
    const line = "あ".repeat(1000);
    const count = Math.ceil((RECORDING_SUMMARY_PART_TOKENS * 2.5) / 1000);
    for (let i = 0; i < count; i++)
      s.port.joined[0]!.events.utterance(
        "u1",
        "Aoi",
        s.at(1000 + i * 1000),
        line,
      );
    await s.recorder.stop("g1", "u1");
    await s.recorder.settled();
    expect(s.llm.calls.length).toBe(4);
    for (const call of s.llm.calls.slice(0, 3)) {
      const input = String(call.messages.at(-1)!.content);
      expect(estimateTokens(input)).toBeLessThan(
        RECORDING_SUMMARY_PART_TOKENS + 2000,
      );
    }
    const last = String(s.llm.calls[3]!.messages.at(-1)!.content);
    expect(last.split("- 部分のメモ").length - 1).toBe(3);
    const summary = s.port.sent.find((m) => m.content.includes("録音の要約"))!;
    expect(summary.content).toContain("## 概要\n- 全体");
    // The file still has every line.
    expect(text(summary).split(line).length - 1).toBe(count);
  });

  test("the number of parts is bounded; what is past the bound is said to be left out of the summary", async () => {
    const llm = fakeLlm(() => "- メモ");
    const s = setup({ llm });
    await s.recorder.start("g1", "t1", "u1");
    const line = "い".repeat(2000);
    const count = Math.ceil(
      (RECORDING_SUMMARY_PART_TOKENS * (RECORDING_SUMMARY_MAX_PARTS + 1.5)) /
        2000,
    );
    for (let i = 0; i < count; i++)
      s.port.joined[0]!.events.utterance("u1", "Aoi", s.at(i * 1000), line);
    await s.recorder.stop("g1", "u1");
    await s.recorder.settled();
    expect(s.llm.calls.length).toBe(RECORDING_SUMMARY_MAX_PARTS + 1);
    const summary = s.port.sent.find((m) => m.content.includes("録音の要約"))!;
    expect(summary.content).toContain("要約に含めていません");
  });
});

describe("restarts", () => {
  test("a recording cut off by a restart is summarized and delivered after it, then removed", async () => {
    const dir = tempDir();
    const before = setup({ dir });
    await before.recorder.start("g1", "t1", "u1");
    before.port.joined[0]!.events.utterance(
      "u1",
      "Aoi",
      before.at(1000),
      "再起動の前",
    );
    await before.recorder.settled();
    await before.recorder.close();
    // Shutting down leaves at once, delivers nothing, and keeps the file.
    expect(before.port.joined[0]!.left).toEqual([false]);
    expect(before.llm.calls).toEqual([]);
    expect(files(dir).length).toBe(1);

    const after = setup({ dir });
    await after.recorder.recover();
    expect(after.recorder.active("g1")).toBe(false);
    const summary = after.port.sent.find((m) =>
      m.content.includes("録音の要約"),
    )!;
    expect(summary.channelId).toBe("t1");
    expect(summary.content).toContain("再起動");
    expect(text(summary)).toContain("再起動の前");
    // The voice chat is told too.
    expect(after.port.sent.some((m) => m.channelId === "vc1")).toBe(true);
    expect(files(dir)).toEqual([]);
  });

  test("one that had ended but was not yet delivered keeps why it ended", async () => {
    const dir = tempDir();
    const before = setup({ dir, llm: fakeLlm(undefined, true) });
    await before.recorder.start("g1", "t1", "u1");
    before.port.joined[0]!.events.utterance(
      "u1",
      "Aoi",
      before.at(1000),
      "はい",
    );
    await before.recorder.stop("g1", "u2");
    // The summary is still being written when the process shuts down.
    while (!before.llm.calls.length) await new Promise((r) => setTimeout(r, 1));
    await before.recorder.close();
    expect(before.port.sent.some((m) => m.content.includes("録音の要約"))).toBe(
      false,
    );
    expect(files(dir).length).toBe(1);

    const after = setup({ dir });
    await after.recorder.recover();
    const summary = after.port.sent.find((m) =>
      m.content.includes("録音の要約"),
    )!;
    expect(summary.content).toContain("<@u2> が録音を止めました");
    expect(files(dir)).toEqual([]);
  });

  test("a damaged file is removed without posting", async () => {
    const dir = tempDir();
    await Bun.write(join(dir, "g1-1.jsonl"), "not json\n");
    const s = setup({ dir });
    await s.recorder.recover();
    expect(s.port.sent).toEqual([]);
    expect(files(dir)).toEqual([]);
  });
});

// A meeting recording's audio (#138): Discord's Opus packets kept without
// re-encoding, as Ogg chunks in a file per speaker, published with the
// transcript as an artifact that lives three days, the room bounded over
// every recording. Discord, xAI and the browser are not involved; the
// artifact is served by a real `Sites` on a local port.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import OpusScript from "opusscript";
import prism from "prism-media";
import { loadConfig } from "../config";
import { OPUS_SILENCE, oggCrc, oggOpus, opusSamples } from "../ogg";
import {
  AudioCapture,
  AudioQuota,
  CHUNK_MAX_MS,
  ChunkBuilder,
  recordingManifest,
  type AudioChunk,
} from "../recording-audio";
import {
  Recorder,
  type RecordingEvents,
  type RecordingPort,
} from "../recording";
import { Runtime } from "../runtime";
import { Sites, byteRange } from "../tools/sites";

const dirs: string[] = [];
const servers: Sites[] = [];
afterEach(() => {
  for (const sites of servers.splice(0)) sites.stop();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "hibana-recording-audio-"));
  dirs.push(dir);
  return dir;
};

/** 20 ms of a tone, as Discord sends it: 48 kHz stereo Opus. */
const encoder = new OpusScript(48000, 2, OpusScript.Application.VOIP);
function packet(n = 0): Uint8Array {
  const pcm = Buffer.alloc(960 * 4);
  for (let i = 0; i < 960; i++) {
    const v = Math.round(Math.sin((n * 960 + i) / 10) * 8000);
    pcm.writeInt16LE(v, i * 4);
    pcm.writeInt16LE(v, i * 4 + 2);
  }
  return new Uint8Array(encoder.encode(pcm, 960));
}

/** The packets of an Ogg Opus stream, read back by prism-media. */
async function demux(data: Uint8Array) {
  const demuxer = new prism.opus.OggDemuxer();
  const out: Buffer[] = [];
  let head: Buffer | undefined;
  demuxer.on("head", (h: Buffer) => (head = h));
  await new Promise<void>((resolve, reject) => {
    Readable.from([Buffer.from(data)])
      .pipe(demuxer)
      .on("data", (p: Buffer) => out.push(p))
      .on("end", resolve)
      .on("error", reject);
  });
  return { head, packets: out };
}

describe("Ogg Opus", () => {
  test("the page checksum is Ogg's (CRC-32, polynomial 0x04c11db7, from 0)", () => {
    // CRC-32/POSIX of "123456789" is 0x765e7680 with its final inversion.
    expect(oggCrc(new TextEncoder().encode("123456789"))).toBe(
      (0x765e7680 ^ 0xffffffff) >>> 0,
    );
  });

  test("a packet's length is read from its TOC byte", () => {
    expect(opusSamples(OPUS_SILENCE)).toBe(960);
    expect(opusSamples(packet())).toBe(960);
    // SILK 60 ms, two frames (code 1).
    expect(opusSamples(new Uint8Array([(3 << 3) | 1]))).toBe(5760);
    // CELT 2.5 ms, code 3 with five frames.
    expect(opusSamples(new Uint8Array([(16 << 3) | 3, 5]))).toBe(600);
    expect(opusSamples(new Uint8Array())).toBe(0);
  });

  test("the packets come back as they went in, with the headers a player needs", async () => {
    const packets = Array.from({ length: 130 }, (_, i) => packet(i));
    // One longer than 255 bytes: it is laced over several segments.
    packets.push(new Uint8Array(600).fill(0xfc));
    const data = oggOpus(packets, { serial: 7, channels: 2 });
    const back = await demux(data);
    expect(back.head?.subarray(0, 8).toString()).toBe("OpusHead");
    expect(back.packets.map((p) => Buffer.from(p).toString("hex"))).toEqual(
      packets.map((p) => Buffer.from(p).toString("hex")),
    );
    // Page by page: the first begins the stream, the last ends it at the
    // samples of every packet, and each checksum holds.
    const pages: { flags: number; granule: number; sequence: number }[] = [];
    for (let at = 0; at < data.length;) {
      const view = new DataView(data.buffer, data.byteOffset + at);
      expect(view.getUint32(0, false)).toBe(0x4f676753); // "OggS"
      const lacing = data.subarray(at + 27, at + 27 + data[at + 26]!);
      const size = 27 + lacing.length + lacing.reduce((n, l) => n + l, 0);
      const page = data.slice(at, at + size);
      const crc = new DataView(page.buffer).getUint32(22, true);
      page.fill(0, 22, 26);
      expect(oggCrc(page)).toBe(crc);
      pages.push({
        flags: view.getUint8(5),
        granule: view.getUint32(6, true),
        sequence: view.getUint32(18, true),
      });
      at += size;
    }
    expect(pages.map((p) => p.sequence)).toEqual(pages.map((_, i) => i));
    expect(pages[0]!.flags).toBe(0x02);
    expect(pages.at(-1)!.flags).toBe(0x04);
    expect(pages.at(-1)!.granule).toBe(131 * 960);
  });
});

describe("chunks", () => {
  const build = () => {
    const chunks: { at: number; ms: number; data: Uint8Array }[] = [];
    let serial = 0;
    return {
      chunks,
      builder: new ChunkBuilder(
        (c) => chunks.push(c),
        () => ++serial,
      ),
    };
  };

  test("a pause inside speech is filled with silence, so the audio keeps the meeting's time; jitter is not", async () => {
    const { chunks, builder } = build();
    let at = 1_000;
    for (let i = 0; i < 10; i++) builder.push(packet(i), (at += 20));
    // A packet 40 ms late: jitter, nothing added.
    builder.push(packet(10), (at += 60));
    expect(chunks).toEqual([]);
    // Half a second without packets: the speaker paused. The gap is
    // measured from when the audio so far ends (the late packet's 20 ms
    // included), so the next packet plays when it arrived.
    builder.push(packet(11), (at += 520));
    builder.cut();
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.at).toBe(1_020);
    const { packets } = await demux(chunks[0]!.data);
    const silent = packets.filter(
      (p) => Buffer.compare(p, Buffer.from(OPUS_SILENCE)) === 0,
    ).length;
    expect(silent).toBe(27);
    expect(chunks[0]!.at + chunks[0]!.ms).toBe(at + 20);
  });

  test("a chunk ends at a minute even mid-speech, and after ten seconds at the next pause", async () => {
    const { chunks, builder } = build();
    let at = 0;
    for (let i = 0; i < CHUNK_MAX_MS / 20 + 5; i++)
      builder.push(packet(i), (at += 20));
    expect(chunks.map((c) => c.ms)).toEqual([CHUNK_MAX_MS]);
    for (let i = 0; i < 600; i++) builder.push(packet(i), (at += 20));
    // A pause after twelve seconds of speech starts a new chunk at the
    // speech after it, anchored at its arrival.
    builder.push(packet(0), (at += 3_000));
    builder.cut();
    expect(chunks.length).toBe(3);
    expect(chunks[1]!.ms).toBe(605 * 20);
    expect(chunks[2]!.at).toBe(at);
    expect(chunks[2]!.ms).toBe(20);
  });

  test("a packet whose length cannot be read is dropped", () => {
    const { chunks, builder } = build();
    builder.push(new Uint8Array(), 0);
    builder.cut();
    expect(chunks).toEqual([]);
  });
});

/** Recordings already published, as `Sites` reports them. */
function published(sizes: { token: string; bytes: number }[]) {
  const dropped: string[] = [];
  return {
    dropped,
    sizes,
    recordingBytes: () => sizes.reduce((n, s) => n + s.bytes, 0),
    dropOldestRecording: async (except?: string) => {
      const i = sizes.findIndex((s) => s.token !== except);
      if (i < 0) return false;
      dropped.push(sizes.splice(i, 1)[0]!.token);
      return true;
    },
  };
}

describe("the room for audio", () => {
  test("making room removes the oldest recordings first; with nothing left to remove, the audio is refused", async () => {
    const p = published([
      { token: "old", bytes: 400 },
      { token: "new", bytes: 400 },
    ]);
    const quota = new AudioQuota(1000, p);
    expect(await quota.take(150)).toBe(true);
    expect(p.dropped).toEqual([]);
    expect(await quota.take(100)).toBe(true);
    expect(p.dropped).toEqual(["old"]);
    // 400 published and 250 pending: 400 more needs "new" gone.
    expect(await quota.take(400)).toBe(true);
    expect(p.dropped).toEqual(["old", "new"]);
    // 650 pending: nothing to remove.
    expect(await quota.take(400)).toBe(false);
  });

  test("publishing stops counting a recording as pending, and makes room for one left by a restart without removing it", async () => {
    const p = published([{ token: "old", bytes: 600 }]);
    const quota = new AudioQuota(1000, p);
    expect(await quota.take(300)).toBe(true);
    await quota.publish(300, async () => {
      p.sizes.push({ token: "a", bytes: 300 });
      return { token: "a" };
    });
    expect(p.dropped).toEqual([]);
    // Left by a restart: it took nothing in this process.
    await quota.publish(0, async () => {
      p.sizes.push({ token: "b", bytes: 500 });
      return { token: "b" };
    });
    expect(p.dropped).toEqual(["old"]);
    expect(p.sizes.map((s) => s.token)).toEqual(["a", "b"]);
  });

  test("a publish that fails gives the room back", async () => {
    const quota = new AudioQuota(1000, published([]));
    expect(await quota.take(900)).toBe(true);
    await expect(
      quota.publish(900, async () => {
        throw new Error("disk");
      }),
    ).rejects.toThrow("disk");
    expect(await quota.take(900)).toBe(true);
  });
});

describe("capture", () => {
  test("each speaker's chunks go to their own file, one after another, each noted with where it is", async () => {
    const dir = tempDir();
    const records: AudioChunk[] = [];
    const capture = new AudioCapture({
      dir,
      quota: new AudioQuota(10_000_000, published([])),
      record: (c) => records.push(c),
      full: () => {},
      report: (e) => {
        throw e;
      },
    });
    const a = capture.sink("u1", "Aoi");
    const b = capture.sink("u2", "Ren");
    for (let i = 0; i < 5; i++) {
      a.packet(packet(i), 1_000 + i * 20);
      b.packet(packet(i), 2_000 + i * 20);
    }
    a.end();
    const again = capture.sink("u1", "Aoi");
    again.packet(packet(), 5_000);
    // Ended by leaving: what is open is written.
    await capture.finish();
    expect(readdirSync(dir).sort()).toEqual(["s1.ogg", "s2.ogg"]);
    const s1 = records.filter((r) => r.speaker === 1);
    expect(s1.map((r) => [r.at, r.ms, r.offset])).toEqual([
      [1_000, 100, 0],
      [5_000, 20, s1[0]!.bytes],
    ]);
    const file = readFileSync(join(dir, "s1.ogg"));
    expect(file.length).toBe(s1[0]!.bytes + s1[1]!.bytes);
    // Each byte range is a whole stream.
    const second = await demux(
      file.subarray(s1[1]!.offset, s1[1]!.offset + s1[1]!.bytes),
    );
    expect(second.packets.length).toBe(1);
    expect(capture.bytes).toBe(records.reduce((n, r) => n + r.bytes, 0));
  });

  test("out of room, the audio stops and it is said once", async () => {
    const dir = tempDir();
    let full = 0;
    const capture = new AudioCapture({
      dir,
      quota: new AudioQuota(10, published([])),
      record: () => {},
      full: () => full++,
      report: () => {},
    });
    const sink = capture.sink("u1", "Aoi");
    sink.packet(packet(), 0);
    sink.end();
    capture.sink("u2", "Ren").packet(packet(), 0);
    await capture.finish();
    expect(full).toBe(1);
    expect(capture.stopped).toBe(true);
    expect(capture.chunks).toEqual([]);
  });
});

test("the page's data has no Discord IDs, and a line of someone whose audio is not kept has no speaker", () => {
  const m = recordingManifest({
    title: "会議室 の会議",
    guild: "サーバー",
    channel: "会議室",
    startedAt: 1_000,
    endedAt: 61_000,
    ending: "終わり",
    expiresAt: 999,
    participants: ["Aoi", "Ren"],
    chunks: [
      {
        speaker: 1,
        user_id: "111111111111111111",
        name: "Aoi",
        offset: 0,
        bytes: 10,
        at: 2_000,
        ms: 500,
      },
    ],
    lines: [
      { at: 2_000, user_id: "111111111111111111", name: "Aoi", text: "はい" },
      { at: 3_000, user_id: "222222222222222222", name: "Ren", text: "どうも" },
    ],
  });
  expect(JSON.stringify(m)).not.toContain("111111111111111111");
  expect(JSON.stringify(m)).not.toContain("222222222222222222");
  expect(m.speakers).toEqual([{ id: 1, name: "Aoi", file: "audio/s1.ogg" }]);
  expect(m.chunks).toEqual([{ s: 1, o: 0, b: 10, t: 1_000, d: 500 }]);
  expect(m.lines.map((l) => l.s)).toEqual([1, null]);
});

test("a byte range is read as browsers send it", () => {
  expect(byteRange(null, 100)).toBeUndefined();
  expect(byteRange("bytes=10-19", 100)).toEqual([10, 19]);
  expect(byteRange("bytes=90-", 100)).toEqual([90, 99]);
  expect(byteRange("bytes=-5", 100)).toEqual([95, 99]);
  expect(byteRange("bytes=50-500", 100)).toEqual([50, 99]);
  expect(byteRange("bytes=100-", 100)).toBeNull();
  expect(byteRange("bytes=0-1,5-6", 100)).toBeUndefined();
});

// --- The recorder with a real `Sites` -------------------------------------

const START = Date.UTC(2026, 9, 30, 5, 0, 0);

class Port implements RecordingPort {
  sent: { channelId: string; content: string }[] = [];
  events?: RecordingEvents;
  async voiceChannelOf() {
    return { id: "3001", name: "会議室", guildName: "テストサーバー" };
  }
  humans() {
    return [{ id: "u1", name: "Aoi" }];
  }
  async canSend() {
    return true;
  }
  async send(channelId: string, message: { content: string }) {
    this.sent.push({ channelId, content: message.content });
  }
  /** Who takes direct messages. Nobody by default: the result then goes to
   *  the channel. */
  dmOpen = new Set<string>();
  directs: { userId: string; content: string }[] = [];
  async direct(userId: string, message: { content: string }) {
    if (!this.dmOpen.has(userId)) return "closed" as const;
    this.directs.push({ userId, content: message.content });
    return "sent" as const;
  }
  async join(_g: string, _c: string, events: RecordingEvents) {
    this.events = events;
    return { leave: async () => {} };
  }
}

async function sitesIn(root: string, siteEnabled = true) {
  const config = loadConfig({
    HIBANA_DATA_DIR: root,
    STATIC_SITE_ENABLED: siteEnabled ? "true" : "false",
    STATIC_SITE_BIND: "127.0.0.1:0",
    STATIC_SITE_BASE_URL: "https://artifacts.example",
  });
  const sites = new Sites(config, {} as never);
  await sites.load();
  await sites.start();
  servers.push(sites);
  return sites;
}

function recorderWith(
  root: string,
  sites: Sites,
  options: { max?: number; now?: () => number } = {},
) {
  const port = new Port();
  const errors: unknown[] = [];
  const llm = {
    complete: async () =>
      ({
        message: { role: "assistant", content: "## 概要\n- 話した" },
        usage: { prompt: 0, output: 0, cache_read: 0, cache_write: 0 },
      }) as never,
  };
  const recorder = new Recorder({
    runtime: new Runtime(
      loadConfig({
        ANTHROPIC_API_KEY: "fixture",
        XAI_API_KEY: "fixture",
        VOICE_ENABLED: "true",
      }),
    ),
    llm,
    port,
    dir: join(root, "recordings"),
    log: { info: () => {}, warn: () => {} },
    report: (e) => errors.push(e),
    maxMs: 3 * 3600_000,
    maxSessions: 2,
    voiceBusy: () => false,
    audio: {
      sites,
      quota: new AudioQuota(options.max ?? 1_000_000_000, sites),
      ttlMs: 72 * 3600_000,
      player: async () => ({ html: "<p>page</p>", js: "// player" }),
    },
    now: options.now ?? (() => START),
  });
  return { recorder, port, errors };
}

/** Someone speaks for `ms`, the packets arriving in time. */
function speak(events: RecordingEvents, user: string, at: number, ms: number) {
  const sink = events.audio!(user, user === "u1" ? "Aoi" : "Ren")!;
  for (let t = 0; t < ms; t += 20) sink.packet(packet(t / 20), at + t);
  sink.end();
}

describe("recording with audio", () => {
  test("the start says the audio is kept; at the end it becomes an artifact the summary links, and nothing stays behind", async () => {
    const root = tempDir();
    const sites = await sitesIn(root);
    const { recorder, port, errors } = recorderWith(root, sites);
    await recorder.start("1001", "2001", "u1");
    expect(port.sent[0]!.content).toContain("音声も保存し");
    expect(port.sent[0]!.content).toContain("3 日");
    const events = port.events!;
    speak(events, "u1", START + 1_000, 2_000);
    events.utterance("u1", "Aoi", START + 1_000, "おはようございます");
    speak(events, "u2", START + 4_000, 1_000);
    await recorder.stop("1001", "u1");
    await recorder.settled();
    expect(errors).toEqual([]);

    const [site] = sites.list();
    expect(site).toMatchObject({
      retention: "recording",
      guild_id: "1001",
      channel_id: "2001",
      expires_at_unix: Math.floor((START + 72 * 3600_000) / 1000),
    });
    expect(site!.source_path).toContain("会議室");
    const summary = port.sent.find((m) => m.content.includes("録音の要約"))!;
    expect(summary.content).toContain(site!.url);
    expect(summary.content).toContain("だれでも開けます");
    // The transcript file and the audio left the recordings directory.
    expect(readdirSync(join(root, "recordings"))).toEqual([]);

    const dir = join(root, "sites", site!.directory!);
    expect(readdirSync(dir).sort()).toEqual([
      "audio",
      "index.html",
      "manifest.json",
      "player.js",
    ]);
    const manifest = JSON.parse(
      readFileSync(join(dir, "manifest.json"), "utf8"),
    );
    expect(manifest.speakers.map((s: { name: string }) => s.name)).toEqual([
      "Aoi",
      "Ren",
    ]);
    expect(manifest.lines).toEqual([
      { t: 1_000, s: 1, name: "Aoi", text: "おはようございます" },
    ]);
    expect(manifest.chunks.map((c: { t: number }) => c.t)).toEqual([
      1_000, 4_000,
    ]);
    // Counted against the recordings' room, not the published sites'.
    expect(sites.recordingBytes()).toBe(site!.bytes);
  });

  test("the link reaches the participants' direct messages, also when nothing was turned into text (#152)", async () => {
    for (const said of [true, false]) {
      const root = tempDir();
      const sites = await sitesIn(root);
      const { recorder, port, errors } = recorderWith(root, sites);
      port.dmOpen.add("u1");
      await recorder.start("1001", "2001", "u1");
      const events = port.events!;
      speak(events, "u1", START + 1_000, 2_000);
      if (said) events.utterance("u1", "Aoi", START + 1_000, "おはよう");
      await recorder.stop("1001", "u1");
      await recorder.settled();
      expect(errors).toEqual([]);
      const [site] = sites.list();
      expect(port.directs.map((d) => d.userId)).toEqual(["u1"]);
      expect(port.directs[0]!.content).toContain(site!.url);
      const notice = port.sent
        .filter((m) => m.channelId === "2001")
        .at(-1)!.content;
      expect(notice).not.toContain(site!.url);
      expect(notice).toContain(
        said
          ? "要約と全文を参加者 1 人の DM に送りました"
          : "音声と全文のページを参加者 1 人の DM に送りました",
      );
    }
  });

  test("the page serves a chunk as a byte range, and a recording cannot be extended or replaced", async () => {
    const root = tempDir();
    const sites = await sitesIn(root);
    const { recorder, port } = recorderWith(root, sites);
    await recorder.start("1001", "2001", "u1");
    speak(port.events!, "u1", START, 500);
    await recorder.stop("1001", "u1");
    await recorder.settled();
    const [site] = sites.list();
    const dir = join(root, "sites", site!.directory!);
    const manifest = JSON.parse(
      readFileSync(join(dir, "manifest.json"), "utf8"),
    );
    const c = manifest.chunks[0];
    const r = await sites.serve(
      new Request(`https://artifacts.example/s/${site!.token}/audio/s1.ogg`, {
        headers: { Range: `bytes=${c.o}-${c.o + c.b - 1}` },
      }),
    );
    expect(r.status).toBe(206);
    expect(r.headers.get("content-type")).toBe("audio/ogg");
    const bytes = new Uint8Array(await r.arrayBuffer());
    expect(bytes.length).toBe(c.b);
    expect((await demux(bytes)).packets.length).toBe(25);

    const ctx = {
      guildId: "1001",
      channelId: "2001",
      thread: false,
      userId: "0",
      botId: "0",
      depth: 0,
      delivered: false,
    };
    for (const mode of ["month", "permanent", "unpermanent"])
      await expect(sites.mutate(ctx, site!.token, mode)).rejects.toThrow(
        "neither extended nor made permanent",
      );
    await expect(sites.publish(ctx, "x", site!.token)).rejects.toThrow();
    // Deleting is allowed.
    await sites.mutate(ctx, site!.token, "delete");
    expect(sites.list()).toEqual([]);
  });

  test("over the room for audio, the oldest recording goes first", async () => {
    const root = tempDir();
    const sites = await sitesIn(root);
    let clock = START;
    // Ten seconds of the test's tone take about 125 kB (with the page): two fit.
    const { recorder, port, errors } = recorderWith(root, sites, {
      max: 300_000,
      now: () => clock,
    });
    const urls: string[] = [];
    for (let i = 0; i < 3; i++) {
      clock += 3600_000;
      await recorder.start("1001", "2001", "u1");
      speak(port.events!, "u1", clock, 10_000);
      await recorder.stop("1001", "u1");
      await recorder.settled();
      urls.push(sites.list().at(-1)!.url);
      // Listed a second apart, so "oldest" is decided.
      await new Promise((r) => setTimeout(r, 1100));
    }
    expect(errors).toEqual([]);
    const live = sites.list().map((s) => s.url);
    expect(live).not.toContain(urls[0]);
    expect(live).toContain(urls[2]);
    expect(live).toContain(urls[1]);
    expect(sites.recordingBytes()).toBeLessThanOrEqual(300_000);
  }, 10_000);

  test("with no room at all, the recording goes on without audio and says so once", async () => {
    const root = tempDir();
    const sites = await sitesIn(root);
    const { recorder, port } = recorderWith(root, sites, { max: 100 });
    await recorder.start("1001", "2001", "u1");
    speak(port.events!, "u1", START, 1_000);
    port.events!.utterance("u1", "Aoi", START, "はい");
    speak(port.events!, "u1", START + 2_000, 1_000);
    // Out of room while recording.
    await new Promise((r) => setTimeout(r, 20));
    await recorder.stop("1001", "u1");
    await recorder.settled();
    const notices = port.sent.filter((m) =>
      m.content.includes("この先の音声は残しません"),
    );
    expect(notices.map((m) => m.channelId).sort()).toEqual(["2001", "3001"]);
    expect(sites.list()).toEqual([]);
    // The transcript is still delivered.
    expect(port.sent.some((m) => m.content.includes("録音の要約"))).toBe(true);
  });

  test("a restart keeps the audio written so far and publishes it with the transcript", async () => {
    const root = tempDir();
    const sites = await sitesIn(root);
    const before = recorderWith(root, sites);
    await before.recorder.start("1001", "2001", "u1");
    speak(before.port.events!, "u1", START + 1_000, 1_000);
    before.port.events!.utterance("u1", "Aoi", START + 1_000, "再起動の前");
    await before.recorder.settled();
    await before.recorder.close();
    expect(readdirSync(join(root, "recordings")).length).toBe(2);
    expect(sites.list()).toEqual([]);

    const after = recorderWith(root, sites);
    await after.recorder.recover();
    const [site] = sites.list();
    expect(site?.retention).toBe("recording");
    const summary = after.port.sent.find((m) =>
      m.content.includes("録音の要約"),
    )!;
    expect(summary.content).toContain(site!.url);
    expect(readdirSync(join(root, "recordings"))).toEqual([]);
  });

  test("a restart after the artifact was made links the same one, and audio whose transcript is gone is removed", async () => {
    const root = tempDir();
    const sites = await sitesIn(root);
    const before = recorderWith(root, sites);
    await before.recorder.start("1001", "2001", "u1");
    speak(before.port.events!, "u1", START, 500);
    // The process ends as the summary is about to be posted.
    let closing: Promise<void> | undefined;
    before.port.send = async () => {
      closing ??= before.recorder.close();
      throw new Error("shutting down");
    };
    before.port.events!.utterance("u1", "Aoi", START, "はい");
    await before.recorder.stop("1001", "u1");
    while (!closing) await new Promise((r) => setTimeout(r, 1));
    await closing;
    await before.recorder.settled();
    expect(sites.list().length).toBe(1);

    // Left over from a recording whose transcript was removed.
    const stray = join(root, "recordings", "1009-1.audio");
    await Bun.write(join(stray, "s1.ogg"), "x");

    const after = recorderWith(root, sites);
    await after.recorder.recover();
    expect(sites.list().length).toBe(1);
    const summary = after.port.sent.find((m) =>
      m.content.includes("録音の要約"),
    )!;
    expect(summary.content).toContain(sites.list()[0]!.url);
    expect(readdirSync(join(root, "recordings"))).toEqual([]);
  });

  test("without static sites, no audio is kept and nothing changes", async () => {
    const root = tempDir();
    const sites = await sitesIn(root, false);
    const { recorder, port } = recorderWith(root, sites);
    await recorder.start("1001", "2001", "u1");
    expect(port.sent[0]!.content).not.toContain("音声も保存し");
    expect(port.events!.audio!("u1", "Aoi")).toBeUndefined();
    port.events!.utterance("u1", "Aoi", START, "はい");
    await recorder.stop("1001", "u1");
    await recorder.settled();
    const summary = port.sent.find((m) => m.content.includes("録音の要約"))!;
    expect(summary.content).not.toContain("🎧");
  });
});

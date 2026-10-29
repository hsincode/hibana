// The audio of a meeting recording (#138). Discord's Opus packets are kept as
// they arrive, never re-encoded: the VPS has one vCPU, and the browser mixes
// the speakers when someone listens (`recording-player/`). Each speaker has
// one file; it is a run of chunks, each a whole Ogg Opus stream of at most a
// minute, so the page can fetch and decode any of them alone (a byte range).
// When the recording is delivered, the files become an artifact that lives
// for three days, and the room they take is bounded over every recording.
import {
  appendFile,
  mkdir,
  rename,
  rm,
  truncate,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { Serial } from "./io";
import { OPUS_SILENCE, oggOpus, opusSamples } from "./ogg";

/** A pause shorter than this is the network's jitter, not silence: it is not
 *  filled, so a late packet does not push the rest of the speech back. */
export const GAP_MS = 100;
/** A pause cuts a chunk once it is this long, so chunks start at speech. */
export const CHUNK_MIN_MS = 10_000;
/** A chunk ends here even mid-speech: a minute of 48 kHz stereo decodes to
 *  about 23 MB in the browser. */
export const CHUNK_MAX_MS = 60_000;
const FRAME_MS = 20;

/** One chunk of one speaker's audio, as kept with the recording. */
export type AudioChunk = {
  /** The speaker's number in this recording, from 1: `s<n>.ogg`. */
  speaker: number;
  user_id: string;
  name: string;
  /** Where the chunk is in the speaker's file. */
  offset: number;
  bytes: number;
  /** When it begins (epoch ms) and how long it plays (ms). */
  at: number;
  ms: number;
};

/** Where one stretch of a speaker's speech goes, packet by packet. */
export type AudioSink = {
  /** One Opus packet, and when it arrived (epoch ms). */
  packet(data: Uint8Array, at: number): void;
  /** The speech ended (a pause, or leaving). */
  end(): void;
};

/**
 * Builds chunks from one stretch of speech. Discord sends nothing while a
 * speaker pauses for less than the 1.2 seconds that end the stretch, so a
 * pause is measured from when packets arrive and filled with silence: the
 * audio keeps the meeting's time. Each chunk is anchored at its first
 * packet's arrival, so what jitter adds does not build up past a chunk.
 */
export class ChunkBuilder {
  private packets: Uint8Array[] = [];
  private samples = 0;
  private start = 0;
  constructor(
    private emit: (chunk: { at: number; ms: number; data: Uint8Array }) => void,
    private serial: () => number,
  ) {}
  private get ms() {
    return this.samples / 48;
  }
  push(packet: Uint8Array, at: number) {
    const samples = opusSamples(packet);
    // A packet whose length cannot be read would put the stream's timing
    // out; it is dropped.
    if (!samples) return;
    if (!this.packets.length) this.start = at;
    else {
      const gap = at - (this.start + this.ms);
      if (gap >= GAP_MS) {
        if (this.ms >= CHUNK_MIN_MS) {
          this.cut();
          this.start = at;
        } else
          for (let i = Math.round(gap / FRAME_MS); i > 0; i--) {
            this.packets.push(OPUS_SILENCE);
            this.samples += FRAME_MS * 48;
          }
      }
    }
    this.packets.push(packet);
    this.samples += samples;
    if (this.ms >= CHUNK_MAX_MS) this.cut();
  }
  /** Emits what is left. */
  cut() {
    if (!this.packets.length) return;
    const data = oggOpus(this.packets, { serial: this.serial(), channels: 2 });
    const chunk = { at: this.start, ms: Math.round(this.ms), data };
    this.packets = [];
    this.samples = 0;
    this.emit(chunk);
  }
}

/** The recordings already published as artifacts, as the room for audio
 *  sees them (`Sites`). */
export type PublishedRecordings = {
  /** Bytes they take now. */
  recordingBytes(): number;
  /** Removes the oldest one (never `except`); false when none is left. */
  dropOldestRecording(except?: string): Promise<boolean>;
};

/**
 * The room for recordings' audio, shared by every recording: published ones
 * and ones still being recorded (`pending`). Making room removes the oldest
 * published recordings first (#138). When nothing more can be removed, the
 * audio is refused and the recording goes on without it.
 */
export class AudioQuota {
  private pending = 0;
  private serial = new Serial();
  constructor(
    readonly max: number,
    private published: PublishedRecordings,
  ) {}
  /** Takes room for `bytes` more of a recording in progress. */
  take(bytes: number): Promise<boolean> {
    return this.serial.run(async () => {
      while (this.published.recordingBytes() + this.pending + bytes > this.max)
        if (!(await this.published.dropOldestRecording())) return false;
      this.pending += bytes;
      return true;
    });
  }
  /** Gives back room a recording took and no longer uses. */
  give(bytes: number) {
    return this.serial.run(async () => {
      this.pending = Math.max(0, this.pending - bytes);
    });
  }
  /** Publishes a recording that took `bytes`: they stop being pending once
   *  they are counted as published. A recording left by a restart took
   *  nothing in this process, so older ones make room for it afterwards. */
  publish<T extends { token: string }>(
    bytes: number,
    task: () => Promise<T>,
  ): Promise<T> {
    return this.serial.run(async () => {
      try {
        const site = await task();
        this.pending = Math.max(0, this.pending - bytes);
        while (
          this.published.recordingBytes() + this.pending > this.max &&
          (await this.published.dropOldestRecording(site.token))
        );
        return site;
      } catch (error) {
        this.pending = Math.max(0, this.pending - bytes);
        throw error;
      }
    });
  }
}

/**
 * One recording's audio while it is recorded: a file per speaker in `dir`,
 * appended a chunk at a time. Every chunk written is handed to `record`,
 * which keeps it with the transcript, so a restart knows what the files hold
 * (a chunk not finished when the process ends is lost).
 */
export class AudioCapture {
  readonly chunks: AudioChunk[] = [];
  /** Room taken from the quota. */
  bytes = 0;
  private speakers = new Map<
    string,
    { n: number; name: string; size: number; writes: Serial }
  >();
  private builders = new Set<ChunkBuilder>();
  private work = new Set<Promise<unknown>>();
  private serials = 0;
  /** Out of room, or a write failed: nothing more is kept. */
  stopped = false;
  constructor(
    private o: {
      dir: string;
      quota: AudioQuota;
      record: (chunk: AudioChunk) => void;
      /** The quota ran out (said once). */
      full: () => void;
      report: (error: unknown) => void;
    },
  ) {}

  sink(userId: string, name: string): AudioSink {
    const builder = new ChunkBuilder(
      (chunk) => this.store(userId, name, chunk),
      () => (Date.now() + ++this.serials) >>> 0,
    );
    this.builders.add(builder);
    let ended = false;
    return {
      packet: (data, at) => {
        if (!ended && !this.stopped) builder.push(data, at);
      },
      end: () => {
        if (ended) return;
        ended = true;
        this.builders.delete(builder);
        builder.cut();
      },
    };
  }

  /** Writes what every speaker has left, and waits for the writes. */
  async finish() {
    for (const builder of this.builders) builder.cut();
    this.builders.clear();
    while (this.work.size) await Promise.allSettled([...this.work]);
  }

  private store(
    userId: string,
    name: string,
    chunk: { at: number; ms: number; data: Uint8Array },
  ) {
    if (this.stopped) return;
    let speaker = this.speakers.get(userId);
    if (!speaker) {
      speaker = {
        n: this.speakers.size + 1,
        name,
        size: 0,
        writes: new Serial(),
      };
      this.speakers.set(userId, speaker);
    }
    const s = speaker;
    const task = s.writes
      .run(async () => {
        if (this.stopped) return;
        const length = chunk.data.length;
        if (!(await this.o.quota.take(length))) {
          // Several speakers may run out at once: said once.
          if (!this.stopped) this.o.full();
          this.stopped = true;
          return;
        }
        try {
          await mkdir(this.o.dir, { recursive: true, mode: 0o700 });
          await appendFile(join(this.o.dir, `s${s.n}.ogg`), chunk.data, {
            mode: 0o600,
          });
        } catch (error) {
          // A file that may now hold part of a chunk: nothing after it is
          // added, and what is recorded keeps to whole chunks.
          this.stopped = true;
          await this.o.quota.give(length);
          throw error;
        }
        const record: AudioChunk = {
          speaker: s.n,
          user_id: userId,
          name: s.name,
          offset: s.size,
          bytes: length,
          at: chunk.at,
          ms: chunk.ms,
        };
        s.size += length;
        this.bytes += length;
        this.chunks.push(record);
        this.o.record(record);
      })
      .catch(this.o.report)
      .finally(() => this.work.delete(task));
    this.work.add(task);
  }
}

/** What `Sites` needs to place a recording's artifact. */
export type RecordingSites = PublishedRecordings & {
  /** Fills a new artifact's directory with `build`, and lists it. */
  addRecording(o: {
    guildId: string;
    channelId: string;
    title: string;
    expiresAt: number;
    build: (dir: string) => Promise<void>;
  }): Promise<{ token: string; url: string; bytes: number }>;
};

export type RecordingManifest = {
  version: 1;
  title: string;
  guild: string;
  channel: string;
  started_at: number;
  ended_at: number;
  ending: string;
  expires_at: number;
  participants: string[];
  speakers: { id: number; name: string; file: string }[];
  /** `t` and `d` are milliseconds from the start of the recording. */
  chunks: { s: number; o: number; b: number; t: number; d: number }[];
  /** `s` is the speaker's number, or null when none of their audio is kept. */
  lines: { t: number; s: number | null; name: string; text: string }[];
};

/** Builds the page's data. Discord IDs are left out: the page is reachable
 *  by anyone with its URL. */
export function recordingManifest(o: {
  title: string;
  guild: string;
  channel: string;
  startedAt: number;
  endedAt: number;
  ending: string;
  expiresAt: number;
  participants: string[];
  chunks: AudioChunk[];
  lines: { at: number; user_id: string; name: string; text: string }[];
}): RecordingManifest {
  const speakers = new Map<
    number,
    { id: number; name: string; file: string }
  >();
  const byUser = new Map<string, number>();
  for (const c of o.chunks) {
    byUser.set(c.user_id, c.speaker);
    if (!speakers.has(c.speaker))
      speakers.set(c.speaker, {
        id: c.speaker,
        name: c.name,
        file: `audio/s${c.speaker}.ogg`,
      });
  }
  return {
    version: 1,
    title: o.title,
    guild: o.guild,
    channel: o.channel,
    started_at: o.startedAt,
    ended_at: o.endedAt,
    ending: o.ending,
    expires_at: o.expiresAt,
    participants: o.participants,
    speakers: [...speakers.values()].sort((a, b) => a.id - b.id),
    chunks: o.chunks
      .map((c) => ({
        s: c.speaker,
        o: c.offset,
        b: c.bytes,
        t: c.at - o.startedAt,
        d: c.ms,
      }))
      .sort((a, b) => a.t - b.t),
    lines: o.lines.map((l) => ({
      t: l.at - o.startedAt,
      s: byUser.get(l.user_id) ?? null,
      name: l.name,
      text: l.text,
    })),
  };
}

/**
 * Moves a recording's audio into a new artifact with its page, and lists it.
 * A speaker's file is cut back to its last whole chunk (a restart may have
 * left part of one).
 */
export async function publishRecording(o: {
  sites: RecordingSites;
  quota: AudioQuota;
  audioDir: string;
  guildId: string;
  channelId: string;
  title: string;
  /** Takes the time the page expires at. */
  manifest: (expiresAt: number) => RecordingManifest;
  expiresAt: number;
  chunks: AudioChunk[];
  /** Room the recording took in this process. */
  taken: number;
  player: () => Promise<{ html: string; js: string }>;
}) {
  const ends = new Map<number, number>();
  for (const c of o.chunks)
    ends.set(c.speaker, Math.max(ends.get(c.speaker) ?? 0, c.offset + c.bytes));
  const page = await o.player();
  const manifest = o.manifest(o.expiresAt);
  return o.quota.publish(o.taken, () =>
    o.sites.addRecording({
      guildId: o.guildId,
      channelId: o.channelId,
      title: o.title,
      expiresAt: o.expiresAt,
      build: async (dir) => {
        await mkdir(join(dir, "audio"), { recursive: true });
        for (const [n, end] of ends) {
          const from = join(o.audioDir, `s${n}.ogg`);
          await truncate(from, end);
          await rename(from, join(dir, "audio", `s${n}.ogg`));
        }
        await writeFile(join(dir, "index.html"), page.html);
        await writeFile(join(dir, "player.js"), page.js);
        await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest));
        await rm(o.audioDir, { recursive: true, force: true });
      },
    }),
  );
}

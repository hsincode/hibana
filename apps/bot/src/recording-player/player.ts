/// <reference lib="dom" />
// The recording page (#138), bundled into `player.js` when a recording is
// published (`build.ts`). The server keeps each speaker's audio as it came
// from Discord; this page mixes the speakers itself, so the VPS only serves
// files: Web Audio plays each chunk at its time in the meeting, and a
// download is rendered a minute at a time and encoded here (Opus through
// WebCodecs where the browser has it, otherwise WAV).
import { oggOpus } from "../ogg";
import type { RecordingManifest } from "../recording-audio";
import {
  chunksIn,
  clock,
  fileStem,
  japanTime,
  length,
  lineRange,
  pcm16,
  wavHeader,
  type Chunk,
} from "./timeline";

/** Chunks are scheduled this far ahead of what is playing. */
const AHEAD_MS = 15_000;
/** A download is rendered this much at a time: eight speakers talking at
 *  once over a minute decode to about 400 MB. */
const WINDOW_MS = 60_000;
/** Decoded chunks kept for playing. */
const CACHE = 24;

const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
};

/** Fetches a chunk's bytes: a byte range of its speaker's file. */
async function bytesOf(m: RecordingManifest, c: Chunk): Promise<ArrayBuffer> {
  const file = m.speakers.find((s) => s.id === c.s)!.file;
  const r = await fetch(file, {
    headers: { Range: `bytes=${c.o}-${c.o + c.b - 1}` },
  });
  if (!r.ok) throw new Error(`音声を取得できませんでした（HTTP ${r.status}）`);
  const data = await r.arrayBuffer();
  // A server that ignored the range sent the whole file.
  return r.status === 206 ? data : data.slice(c.o, c.o + c.b);
}

class Playback {
  private ctx?: AudioContext;
  private cache = new Map<Chunk, Promise<AudioBuffer>>();
  private sources = new Set<AudioBufferSourceNode>();
  private scheduled = new Set<Chunk>();
  private timer?: ReturnType<typeof setInterval>;
  private generation = 0;
  private from = 0;
  private base = 0;
  private until = 0;
  private speakers: ReadonlySet<number> | null = null;
  playing = false;
  onState = () => {};
  onError = (_: unknown) => {};
  constructor(private m: RecordingManifest) {}

  position() {
    if (!this.playing || !this.ctx) return this.from;
    const at = this.from + (this.ctx.currentTime - this.base) * 1000;
    return Math.min(this.until, Math.max(this.from, at));
  }

  private load(c: Chunk) {
    let buffer = this.cache.get(c);
    if (!buffer) {
      buffer = bytesOf(this.m, c).then((data) =>
        this.ctx!.decodeAudioData(data),
      );
      buffer.catch(() => this.cache.delete(c));
      this.cache.set(c, buffer);
      // The oldest decoded chunks go first.
      while (this.cache.size > CACHE)
        this.cache.delete(this.cache.keys().next().value!);
    }
    return buffer;
  }

  /** Plays from `from` (ms) until `until`, the speakers given (all: null). */
  async play(
    from: number,
    until: number,
    speakers: ReadonlySet<number> | null,
  ) {
    this.stop();
    const generation = ++this.generation;
    this.ctx ??= new AudioContext();
    await this.ctx.resume();
    this.from = from;
    this.until = until;
    this.speakers = speakers;
    this.playing = true;
    this.onState();
    // What plays first is decoded before the clock starts.
    await Promise.allSettled(
      chunksIn(this.m.chunks, from, Math.min(until, from + 5000), speakers).map(
        (c) => this.load(c),
      ),
    );
    if (generation !== this.generation) return;
    this.base = this.ctx.currentTime + 0.05;
    const tick = () => {
      if (generation !== this.generation) return;
      const now = this.position();
      if (now >= this.until) {
        this.stop();
        return;
      }
      const upcoming = chunksIn(
        this.m.chunks,
        now,
        Math.min(this.until, now + AHEAD_MS),
        this.speakers,
      );
      for (const c of upcoming) {
        if (this.scheduled.has(c)) continue;
        this.scheduled.add(c);
        this.load(c)
          .then((buffer) => {
            if (generation === this.generation) this.schedule(c, buffer);
          })
          .catch(this.onError);
      }
    };
    tick();
    this.timer = setInterval(tick, 500);
  }

  private schedule(c: Chunk, buffer: AudioBuffer) {
    const ctx = this.ctx!;
    // Where in the chunk to start, and when on the context's clock.
    let offset = Math.max(0, this.from - c.t) / 1000;
    let when = this.base + Math.max(0, c.t - this.from) / 1000;
    // Decoded late: start where the meeting is now.
    if (when < ctx.currentTime) {
      offset += ctx.currentTime - when;
      when = ctx.currentTime;
    }
    const end = Math.min(c.t + c.d, this.until);
    const duration = (end - c.t) / 1000 - offset;
    if (duration <= 0) return;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.onended = () => this.sources.delete(source);
    source.start(when, offset, duration);
    this.sources.add(source);
  }

  /** Paused: the next play starts at `ms`. */
  cue(ms: number) {
    this.stop();
    this.from = ms;
  }

  stop() {
    this.generation++;
    if (this.playing) this.from = this.position();
    clearInterval(this.timer);
    for (const source of this.sources) source.stop();
    this.sources.clear();
    this.scheduled.clear();
    const was = this.playing;
    this.playing = false;
    if (was) this.onState();
  }
}

/** Collects the mixed samples, and makes the file. */
type Writer = {
  ext: string;
  rate: number;
  add(samples: Float32Array<ArrayBuffer>): Promise<void>;
  finish(): Promise<Blob>;
};

const OPUS_CONFIG = {
  codec: "opus",
  sampleRate: 48000,
  numberOfChannels: 1,
  bitrate: 64000,
};

async function opusWriter(): Promise<Writer | undefined> {
  if (typeof AudioEncoder === "undefined") return;
  try {
    if (!(await AudioEncoder.isConfigSupported(OPUS_CONFIG)).supported) return;
  } catch {
    return;
  }
  const packets: Uint8Array[] = [];
  let preSkip = 0;
  let failure: unknown;
  const encoder = new AudioEncoder({
    output: (chunk, meta) => {
      const bytes = new Uint8Array(chunk.byteLength);
      chunk.copyTo(bytes);
      packets.push(bytes);
      // The encoder's own identification header, when it gives one, says
      // how many samples it put first.
      const head = meta?.decoderConfig?.description;
      if (head) {
        const data = ArrayBuffer.isView(head)
          ? new Uint8Array(head.buffer, head.byteOffset, head.byteLength)
          : new Uint8Array(head);
        if (
          data.length >= 12 &&
          String.fromCharCode(...data.slice(0, 8)) === "OpusHead"
        )
          preSkip = data[10]! | (data[11]! << 8);
      }
    },
    error: (e) => {
      failure = e;
    },
  });
  encoder.configure(OPUS_CONFIG);
  let frames = 0;
  return {
    ext: "ogg",
    rate: 48000,
    async add(samples) {
      if (failure) throw failure;
      const data = new AudioData({
        format: "f32-planar",
        sampleRate: 48000,
        numberOfFrames: samples.length,
        numberOfChannels: 1,
        timestamp: Math.round((frames / 48000) * 1e6),
        data: samples,
      });
      frames += samples.length;
      encoder.encode(data);
      data.close();
      while (encoder.encodeQueueSize > 4)
        await new Promise((r) => setTimeout(r, 10));
    },
    async finish() {
      await encoder.flush();
      encoder.close();
      if (failure) throw failure;
      const serial = (Math.random() * 2 ** 32) >>> 0;
      return new Blob([oggOpus(packets, { serial, channels: 1, preSkip })], {
        type: "audio/ogg",
      });
    },
  };
}

function wavWriter(): Writer {
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let bytes = 0;
  return {
    ext: "wav",
    rate: 16000,
    async add(samples) {
      const pcm = pcm16(samples);
      parts.push(pcm);
      bytes += pcm.length;
    },
    async finish() {
      return new Blob([wavHeader(16000, bytes), ...parts], {
        type: "audio/wav",
      });
    },
  };
}

/** Mixes the speakers given (all: null) into one file, a window at a time. */
async function render(
  m: RecordingManifest,
  speakers: ReadonlySet<number> | null,
  progress: (done: number) => void,
): Promise<{ blob: Blob; ext: string }> {
  const writer = (await opusWriter()) ?? wavWriter();
  const total = length(m);
  // A chunk that runs into the next window is decoded once.
  let carried = new Map<Chunk, AudioBuffer>();
  for (let from = 0; from < total; from += WINDOW_MS) {
    const to = Math.min(total, from + WINDOW_MS);
    const frames = Math.max(1, Math.round(((to - from) / 1000) * writer.rate));
    const ctx = new OfflineAudioContext(1, frames, writer.rate);
    const next = new Map<Chunk, AudioBuffer>();
    for (const c of chunksIn(m.chunks, from, to, speakers)) {
      const buffer =
        carried.get(c) ?? (await ctx.decodeAudioData(await bytesOf(m, c)));
      if (c.t + c.d > to) next.set(c, buffer);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      const at = (c.t - from) / 1000;
      if (at >= 0) source.start(at);
      else source.start(0, -at);
    }
    carried = next;
    const mixed = await ctx.startRendering();
    await writer.add(mixed.getChannelData(0));
    progress(to / total);
  }
  return { blob: await writer.finish(), ext: writer.ext };
}

function save(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function main() {
  const status = $("status");
  let m: RecordingManifest;
  try {
    const r = await fetch("manifest.json");
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    m = (await r.json()) as RecordingManifest;
  } catch (e) {
    status.textContent = `録音を読み込めませんでした（${String(e)}）。`;
    return;
  }
  const total = length(m);
  document.title = m.title;
  $("title").textContent = m.title;
  $("meta").textContent = [
    `${m.guild} / ${m.channel}`,
    `${japanTime(m.started_at)} から ${clock(m.ended_at - m.started_at)}`,
    `参加者: ${m.participants.join("、") || "—"}`,
  ].join(" · ");
  $("ending").textContent = m.ending;
  $("expires").textContent =
    `${japanTime(m.expires_at)}（日本時間）に消えます。URL を知っていれば、だれでも開けます。`;
  $("total").textContent = clock(total);

  const player = new Playback(m);
  const toggle = $<HTMLButtonElement>("play");
  const seek = $<HTMLInputElement>("seek");
  const now = $("now");
  seek.max = String(total);
  let seeking = false;
  /** The line playing alone, if one is. */
  let solo: HTMLElement | undefined;
  const heard = new Set(m.speakers.map((s) => s.id));
  const shown = () => {
    toggle.textContent = player.playing ? "⏸ 一時停止" : "▶ 再生";
    toggle.setAttribute("aria-pressed", String(player.playing));
    if (!player.playing && solo) {
      solo.classList.remove("playing");
      solo = undefined;
    }
  };
  player.onState = shown;
  player.onError = (e) => {
    status.textContent = `音声を再生できませんでした（${String(e)}）。`;
  };
  setInterval(() => {
    const at = player.position();
    now.textContent = clock(at);
    if (!seeking) seek.value = String(at);
  }, 250);
  const playAll = (from: number) => {
    status.textContent = "";
    void player
      .play(from, total, heard.size === m.speakers.length ? null : heard)
      .catch(player.onError);
  };
  toggle.onclick = () => {
    if (player.playing) player.stop();
    else playAll(player.position() >= total ? 0 : player.position());
  };
  seek.oninput = () => {
    seeking = true;
    now.textContent = clock(Number(seek.value));
  };
  seek.onchange = () => {
    seeking = false;
    const wasPlaying = player.playing && !solo;
    player.stop();
    if (wasPlaying) playAll(Number(seek.value));
    else player.cue(Number(seek.value));
  };

  // Who is heard when everyone plays.
  const who = $("speakers");
  for (const s of m.speakers) {
    const box = el("input", { type: "checkbox", checked: true });
    box.onchange = () => {
      if (box.checked) heard.add(s.id);
      else heard.delete(s.id);
      if (player.playing && !solo) playAll(player.position());
    };
    who.append(el("label", {}, box, ` ${s.name}`));
  }
  if (!m.speakers.length) {
    who.append("音声は残っていません。");
    toggle.disabled = true;
  }

  // Downloads.
  const choice = $<HTMLSelectElement>("who");
  choice.append(el("option", { value: "" }, "全員を重ねた 1 本"));
  for (const s of m.speakers)
    choice.append(el("option", { value: String(s.id) }, `${s.name} だけ`));
  const download = $<HTMLButtonElement>("download");
  download.disabled = !m.speakers.length;
  download.onclick = async () => {
    const id = Number(choice.value) || null;
    const speaker = m.speakers.find((s) => s.id === id);
    download.disabled = true;
    status.textContent = "ダウンロードの準備をしています（0%）…";
    try {
      const { blob, ext } = await render(
        m,
        speaker ? new Set([speaker.id]) : null,
        (done) => {
          status.textContent = `ダウンロードの準備をしています（${Math.floor(done * 100)}%）…`;
        },
      );
      save(blob, `${fileStem(m.started_at, speaker?.name)}.${ext}`);
      status.textContent =
        ext === "wav"
          ? "WAV で保存しました（このブラウザは Opus で書き出せないため）。"
          : "保存しました。";
    } catch (e) {
      status.textContent = `ダウンロードを作れませんでした（${String(e)}）。`;
    } finally {
      download.disabled = false;
    }
  };

  // The transcript, each line playable alone.
  const list = $("lines");
  for (const [i, line] of m.lines.entries()) {
    const range = lineRange(m, i);
    const row = el("li");
    const button = el("button", {
      type: "button",
      className: "line-play",
      textContent: "▶",
      disabled: !range,
      title: range ? "この発言を再生" : "この人の音声は残っていません",
    });
    button.setAttribute(
      "aria-label",
      `${clock(line.t)} ${line.name} の発言を再生`,
    );
    button.onclick = () => {
      if (!range) return;
      player.stop();
      solo = row;
      row.classList.add("playing");
      void player
        .play(range.from, range.until, new Set([range.speaker]))
        .catch(player.onError);
    };
    row.append(
      button,
      el("span", { className: "t" }, clock(line.t)),
      el("span", { className: "name" }, line.name),
      el("span", { className: "text" }, line.text),
    );
    list.append(row);
  }
  if (!m.lines.length)
    list.append(el("li", {}, "発言は文字にできませんでした。"));
  shown();
}

void main();

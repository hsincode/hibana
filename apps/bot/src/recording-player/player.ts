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
  clipRange,
  clock,
  fileStem,
  japanTime,
  length,
  lineRange,
  parseClock,
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

/** Mixes the speakers given (all: null) into one file, a window at a time,
 *  between `start` and `end` (ms; a part of the recording, #150). */
async function render(
  m: RecordingManifest,
  speakers: ReadonlySet<number> | null,
  start: number,
  end: number,
  progress: (done: number) => void,
): Promise<{ blob: Blob; ext: string }> {
  const writer = (await opusWriter()) ?? wavWriter();
  // A chunk that runs into the next window is decoded once.
  let carried = new Map<Chunk, AudioBuffer>();
  for (let from = start; from < end; from += WINDOW_MS) {
    const to = Math.min(end, from + WINDOW_MS);
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
    progress((to - start) / (end - start));
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

/** A speaker's color: the categorical slots in fixed order (`index.html`),
 *  gray past the eighth. Never color alone: each lane and line names them. */
const colorOf = (id: number | null) =>
  id !== null && id >= 1 && id <= 8 ? `var(--s${id})` : "var(--s-other)";
const initial = (name: string) => [...name.trim()][0]?.toUpperCase() ?? "?";
const ICON = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.4-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>',
  pause:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6.5" y="5" width="4" height="14" rx="1.2"/><rect x="13.5" y="5" width="4" height="14" rx="1.2"/></svg>',
};

async function main() {
  const status = $("status");
  const say = (text: string, tone: "info" | "error" = "info") => {
    status.textContent = text;
    status.dataset.tone = tone;
    status.hidden = !text;
  };
  let m: RecordingManifest;
  try {
    const r = await fetch("manifest.json");
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    m = (await r.json()) as RecordingManifest;
  } catch (e) {
    say(`録音を読み込めませんでした（${String(e)}）。`, "error");
    return;
  }
  const total = length(m);
  const span = Math.max(1, total);
  document.title = m.title;
  $("title").textContent = m.title;
  const chips = $("chips");
  for (const text of [
    `${m.guild} / ${m.channel}`,
    `${japanTime(m.started_at)} 開始`,
    clock(m.ended_at - m.started_at),
    `参加者 ${m.participants.length} 人`,
  ])
    chips.insertBefore(el("li", { className: "chip" }, text), $("expires"));
  $("ending").textContent = m.ending;
  $("participants").textContent = m.participants.join("、");
  $("expires").textContent = `${japanTime(m.expires_at)} に削除`;
  $("total").textContent = clock(total);

  const player = new Playback(m);
  const toggle = $<HTMLButtonElement>("play");
  const seek = $<HTMLInputElement>("seek");
  const now = $("now");
  const head = $("playhead");
  seek.max = String(total);
  let seeking = false;
  /** The line playing alone, if one is. */
  let solo: HTMLElement | undefined;
  const heard = new Set(m.speakers.map((s) => s.id));
  const shown = () => {
    toggle.innerHTML = player.playing ? ICON.pause : ICON.play;
    toggle.setAttribute("aria-label", player.playing ? "一時停止" : "再生");
    toggle.classList.toggle("is-playing", player.playing);
    if (!player.playing && solo) {
      solo.classList.remove("solo");
      solo = undefined;
    }
  };
  player.onState = shown;
  player.onError = (e) =>
    say(`音声を再生できませんでした（${String(e)}）。`, "error");
  const playAll = (from: number) => {
    say("");
    void player
      .play(
        Math.max(0, Math.min(total, from)),
        total,
        heard.size === m.speakers.length ? null : heard,
      )
      .catch(player.onError);
  };
  /** Moves the playhead; playing goes on from there. */
  const jump = (to: number) => {
    const at = Math.max(0, Math.min(total, to));
    if (player.playing && !solo) playAll(at);
    else player.cue(at);
  };
  toggle.onclick = () => {
    if (player.playing) player.stop();
    else playAll(player.position() >= total ? 0 : player.position());
  };
  $("back").onclick = () => jump(player.position() - 10_000);
  $("ahead").onclick = () => jump(player.position() + 10_000);
  seek.oninput = () => {
    seeking = true;
    now.textContent = clock(Number(seek.value));
  };
  seek.onchange = () => {
    seeking = false;
    jump(Number(seek.value));
  };

  // The timeline: a lane per speaker, their speech as segments on one time
  // axis. Clicking a lane moves the playhead there; dragging along it picks
  // the part of the recording to download (#150).
  const lanes = $("lanes");
  const laneOf = new Map<number, HTMLElement>();
  for (const s of m.speakers) {
    const track = el("div", { className: "track" });
    for (const c of m.chunks.filter((c) => c.s === s.id)) {
      const seg = el("span", {
        className: "seg",
        title: `${s.name}  ${clock(c.t)}〜${clock(c.t + c.d)}`,
      });
      seg.style.left = `${(c.t / span) * 100}%`;
      seg.style.width = `max(2px, ${(c.d / span) * 100}%)`;
      track.append(seg);
    }
    const lane = el(
      "div",
      { className: "lane" },
      el("span", { className: "lane-name", title: s.name }, s.name),
      track,
    );
    lane.style.setProperty("--c", colorOf(s.id));
    laneOf.set(s.id, lane);
    lanes.append(lane);
  }
  let drag: { x: number; box: DOMRect; moved: boolean } | undefined;
  const timeAt = (box: DOMRect, x: number) =>
    Math.max(0, Math.min(1, (x - box.left) / box.width)) * total;
  lanes.onpointerdown = (e) => {
    const area = (e.target as HTMLElement).closest(".track");
    if (!area || e.button !== 0) return;
    drag = { x: e.clientX, box: area.getBoundingClientRect(), moved: false };
    lanes.setPointerCapture(e.pointerId);
  };
  lanes.onpointermove = (e) => {
    if (!drag) return;
    // A few pixels of a click's wobble do not make a drag.
    if (!drag.moved && Math.abs(e.clientX - drag.x) < 5) return;
    drag.moved = true;
    band(timeAt(drag.box, drag.x), timeAt(drag.box, e.clientX));
  };
  lanes.onpointerup = (e) => {
    if (!drag) return;
    const { x, box, moved } = drag;
    drag = undefined;
    if (moved) pick(timeAt(box, x), timeAt(box, e.clientX));
    else jump(timeAt(box, e.clientX));
  };
  lanes.onpointercancel = () => {
    drag = undefined;
    shownClip();
  };

  // Who is heard when everyone plays.
  const who = $("speakers");
  for (const s of m.speakers) {
    const chip = el(
      "button",
      { type: "button", className: "speaker" },
      el("span", { className: "dot" }),
      s.name,
    );
    chip.style.setProperty("--c", colorOf(s.id));
    chip.setAttribute("aria-pressed", "true");
    chip.onclick = () => {
      const on = !heard.has(s.id);
      if (on) heard.add(s.id);
      else heard.delete(s.id);
      chip.setAttribute("aria-pressed", String(on));
      laneOf.get(s.id)?.classList.toggle("muted", !on);
      if (player.playing && !solo) playAll(player.position());
    };
    who.append(chip);
  }
  if (!m.speakers.length) {
    who.append(el("span", { className: "muted" }, "音声は残っていません。"));
    toggle.disabled = true;
  }

  // The part of the recording to download (#150): typed, taken from the
  // playhead, or dragged along the timeline. Whole seconds, as the fields
  // show them.
  const whole = $<HTMLInputElement>("span-all");
  const part = $<HTMLInputElement>("span-part");
  const fields = $("clip");
  const fromField = $<HTMLInputElement>("clip-start");
  const toField = $<HTMLInputElement>("clip-end");
  const clipLength = $("clip-length");
  const clipBand = $("clip-band");
  const clip = () =>
    clipRange(parseClock(fromField.value), parseClock(toField.value), total);
  /** Marks a stretch on the timeline. */
  const band = (a: number, b: number) => {
    const [from, to] = a < b ? [a, b] : [b, a];
    clipBand.hidden = false;
    clipBand.style.left = `${(from / span) * 100}%`;
    clipBand.style.width = `${((to - from) / span) * 100}%`;
  };
  const shownClip = () => {
    fields.hidden = !part.checked;
    const range = clip();
    if (part.checked && typeof range !== "string") band(range.from, range.to);
    else clipBand.hidden = true;
    clipLength.textContent = !part.checked
      ? ""
      : typeof range === "string"
        ? range
        : `長さ ${clock(range.to - range.from)}`;
    clipLength.dataset.tone = typeof range === "string" ? "error" : "";
  };
  /** Picks the stretch between two times, in whole seconds. */
  const pick = (a: number, b: number) => {
    const from = Math.floor(Math.min(a, b) / 1000) * 1000;
    const to = Math.min(total, Math.ceil(Math.max(a, b) / 1000) * 1000);
    fromField.value = clock(from);
    toField.value = clock(Math.max(to, from + 1000));
    part.checked = true;
    shownClip();
  };
  fromField.value = clock(0);
  toField.value = clock(Math.min(total, 60_000));
  whole.onchange = part.onchange = shownClip;
  fromField.oninput = toField.oninput = shownClip;
  // A whole second typed short ("7", "56:21") is shown in full.
  fromField.onchange = toField.onchange = (e) => {
    const field = e.target as HTMLInputElement;
    const ms = parseClock(field.value);
    if (ms !== undefined && ms % 1000 === 0) field.value = clock(ms);
  };
  $("clip-start-now").onclick = () => {
    fromField.value = clock(player.position());
    shownClip();
  };
  $("clip-end-now").onclick = () => {
    toField.value = clock(Math.ceil(player.position() / 1000) * 1000);
    shownClip();
  };
  shownClip();

  // Downloads.
  const choice = $<HTMLSelectElement>("who");
  choice.append(el("option", { value: "" }, "全員を重ねた 1 本"));
  for (const s of m.speakers)
    choice.append(el("option", { value: String(s.id) }, `${s.name} だけ`));
  const download = $<HTMLButtonElement>("download");
  const bar = $<HTMLProgressElement>("progress");
  download.disabled = !m.speakers.length;
  download.onclick = async () => {
    const id = Number(choice.value) || null;
    const speaker = m.speakers.find((s) => s.id === id);
    const range = part.checked ? clip() : { from: 0, to: total };
    if (typeof range === "string") {
      say(range, "error");
      return;
    }
    download.disabled = true;
    bar.hidden = false;
    bar.value = 0;
    say("ダウンロードの準備をしています…");
    try {
      const { blob, ext } = await render(
        m,
        speaker ? new Set([speaker.id]) : null,
        range.from,
        range.to,
        (done) => {
          bar.value = done;
          say(`ダウンロードの準備をしています（${Math.floor(done * 100)}%）…`);
        },
      );
      const stem = part.checked
        ? fileStem(m.started_at, speaker?.name, range)
        : fileStem(m.started_at, speaker?.name);
      save(blob, `${stem}.${ext}`);
      say(
        ext === "wav"
          ? "WAV で保存しました（このブラウザは Opus で書き出せないため）。"
          : "保存しました。",
      );
    } catch (e) {
      say(`ダウンロードを作れませんでした（${String(e)}）。`, "error");
    } finally {
      download.disabled = false;
      bar.hidden = true;
    }
  };

  // Hears the part before downloading it: the speakers the download takes.
  const clipPlay = $<HTMLButtonElement>("clip-play");
  clipPlay.disabled = !m.speakers.length;
  clipPlay.onclick = () => {
    const range = clip();
    if (typeof range === "string") {
      say(range, "error");
      return;
    }
    const id = Number(choice.value) || null;
    say("");
    void player
      .play(range.from, range.to, id ? new Set([id]) : null)
      .catch(player.onError);
  };

  // The transcript: each line plays alone, a click on the line (or its
  // time) plays everyone from there (#150), and the line being heard is
  // marked.
  const list = $("lines");
  const rows: { row: HTMLElement; t: number; search: string }[] = [];
  for (const [i, line] of m.lines.entries()) {
    const range = lineRange(m, i);
    const row = el("li", { className: "line" });
    row.style.setProperty("--c", colorOf(line.s));
    const solo1 = el("button", {
      type: "button",
      className: "line-play",
      innerHTML: ICON.play,
      disabled: !range,
      title: range ? "この発言だけを再生" : "この人の音声は残っていません",
    });
    solo1.setAttribute("aria-label", `${line.name} の発言を再生`);
    solo1.onclick = () => {
      if (!range) return;
      player.stop();
      solo = row;
      row.classList.add("solo");
      void player
        .play(range.from, range.until, new Set([range.speaker]))
        .catch(player.onError);
    };
    const time = el("button", {
      type: "button",
      className: "time",
      textContent: clock(line.t),
      title: "ここから全員を再生",
    });
    time.onclick = () => playAll(line.t);
    // Anywhere else on the line does the same, unless text was being
    // selected to copy. The buttons keep their own.
    row.onclick = (e) => {
      if ((e.target as HTMLElement).closest("button")) return;
      if (getSelection()?.toString()) return;
      playAll(line.t);
    };
    row.append(
      el(
        "span",
        { className: "avatar", ariaHidden: "true" },
        initial(line.name),
      ),
      el(
        "div",
        { className: "body" },
        el(
          "div",
          { className: "who" },
          el("span", { className: "name" }, line.name),
          time,
        ),
        el("p", { className: "text" }, line.text),
      ),
      solo1,
    );
    rows.push({
      row,
      t: line.t,
      search: `${line.name} ${line.text}`.toLowerCase(),
    });
    list.append(row);
  }
  if (!m.lines.length)
    list.append(
      el("li", { className: "empty" }, "発言は文字にできませんでした。"),
    );
  $("count").textContent = `${m.lines.length} 件`;

  const find = $<HTMLInputElement>("find");
  find.oninput = () => {
    const q = find.value.trim().toLowerCase();
    let hits = 0;
    for (const r of rows) {
      const hit = !q || r.search.includes(q);
      r.row.hidden = !hit;
      if (hit) hits++;
    }
    $("count").textContent = q
      ? `${hits} / ${rows.length} 件`
      : `${rows.length} 件`;
  };
  const follow = $<HTMLInputElement>("follow");

  let current: HTMLElement | undefined;
  setInterval(() => {
    const at = player.position();
    now.textContent = clock(at);
    head.style.left = `${(at / span) * 100}%`;
    if (!seeking) {
      seek.value = String(at);
      seek.style.setProperty("--f", String(at / span));
    }
    // The line being heard while everyone plays.
    let line: HTMLElement | undefined;
    if (player.playing && !solo)
      for (const r of rows) {
        if (r.t > at) break;
        line = r.row;
      }
    if (line !== current) {
      current?.classList.remove("current");
      line?.classList.add("current");
      current = line;
      if (line && follow.checked && !line.hidden)
        line.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, 250);
  shown();
}

void main();

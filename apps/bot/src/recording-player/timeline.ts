// The recording page's arithmetic (#138), apart from the DOM so it can be
// tested: which chunks a stretch of time needs, what a transcript line plays,
// and the WAV a browser without an Opus encoder downloads.
import type { RecordingManifest } from "../recording-audio";

export type Chunk = RecordingManifest["chunks"][number];

/** How long the recording runs (ms). */
export function length(m: RecordingManifest) {
  const audio = m.chunks.reduce((n, c) => Math.max(n, c.t + c.d), 0);
  return Math.max(m.ended_at - m.started_at, audio);
}

/** The chunks heard between `from` and `to` (ms), of the speakers given
 *  (every speaker when null), in the order they start. */
export function chunksIn(
  chunks: Chunk[],
  from: number,
  to: number,
  speakers: ReadonlySet<number> | null,
): Chunk[] {
  return chunks
    .filter(
      (c) => c.t < to && c.t + c.d > from && (!speakers || speakers.has(c.s)),
    )
    .sort((a, b) => a.t - b.t);
}

/** Played before a line's start, since the transcript's times come from
 *  the speech recognizer and may be a little late. */
export const LEAD_MS = 300;
/** Chunks of one speaker this close together are one stretch of speech. */
const JOIN_MS = 1500;

/**
 * What a transcript line plays: its speaker alone, from just before it to
 * their next line, or to the end of the speech it is in when it is their
 * last. Undefined when none of the speaker's audio is kept.
 */
export function lineRange(
  m: RecordingManifest,
  index: number,
): { speaker: number; from: number; until: number } | undefined {
  const line = m.lines[index];
  if (!line || line.s === null) return;
  const speaker = line.s;
  const from = Math.max(0, line.t - LEAD_MS);
  const next = m.lines.slice(index + 1).find((l) => l.s === speaker);
  // The speech the line is in: the speaker's chunks around it, joined
  // while the gaps are short.
  const own = m.chunks.filter((c) => c.s === speaker).sort((a, b) => a.t - b.t);
  let at = own.findIndex((c) => c.t + c.d > line.t);
  if (at < 0) return;
  let end = own[at]!.t + own[at]!.d;
  while (own[at + 1] && own[at + 1]!.t - end <= JOIN_MS) {
    at++;
    end = Math.max(end, own[at]!.t + own[at]!.d);
  }
  const until = next ? Math.min(Math.max(next.t, line.t + 1000), end) : end;
  return until > from ? { speaker, from, until } : undefined;
}

/** "01:02:03". */
export function clock(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

const jst = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
/** "2026/10/30 14:00" in Japan time. */
export function japanTime(ms: number) {
  return jst.format(new Date(ms));
}

/** "recording-20261030-1400", from the start in Japan time, with the
 *  speaker's name when it is one speaker's file. */
export function fileStem(startedAt: number, speaker?: string) {
  const part = Object.fromEntries(
    jst.formatToParts(new Date(startedAt)).map((p) => [p.type, p.value]),
  );
  const name = speaker
    ? `-${speaker.replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 40)}`
    : "";
  return `recording-${part.year}${part.month}${part.day}-${part.hour}${part.minute}${name}`;
}

/** 16-bit PCM from samples in [-1, 1] (louder ones are clipped). */
export function pcm16(samples: Float32Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return out;
}

/** The header of a mono 16-bit WAV file holding `bytes` of samples. */
export function wavHeader(
  rate: number,
  bytes: number,
): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(44);
  const view = new DataView(out.buffer);
  const text = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i);
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + bytes, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, bytes, true);
  return out;
}

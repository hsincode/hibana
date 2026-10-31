// The recording page (#138): what a stretch of time and a transcript line
// play, the WAV a browser without an Opus encoder gets, and the bundle the
// page loads. The page itself runs in a browser and is not run here.
import { describe, expect, test } from "bun:test";
import type { RecordingManifest } from "../recording-audio";
import { recordingPlayer } from "../recording-player/build";
import {
  LEAD_MS,
  chunksIn,
  clipRange,
  clock,
  fileStem,
  length,
  lineRange,
  parseClock,
  pcm16,
  wavHeader,
} from "../recording-player/timeline";

const manifest = (
  chunks: RecordingManifest["chunks"],
  lines: RecordingManifest["lines"],
): RecordingManifest => ({
  version: 1,
  title: "会議",
  guild: "サーバー",
  channel: "会議室",
  started_at: 0,
  ended_at: 60_000,
  ending: "",
  expires_at: 0,
  participants: [],
  speakers: [
    { id: 1, name: "Aoi", file: "audio/s1.ogg" },
    { id: 2, name: "Ren", file: "audio/s2.ogg" },
  ],
  chunks,
  lines,
});

describe("timeline", () => {
  const chunks = [
    { s: 1, o: 0, b: 1, t: 1_000, d: 5_000 },
    { s: 2, o: 0, b: 1, t: 3_000, d: 2_000 },
    { s: 1, o: 1, b: 1, t: 6_500, d: 4_000 },
    { s: 1, o: 2, b: 1, t: 30_000, d: 1_000 },
  ];

  test("a stretch of time needs the chunks heard in it, of the speakers chosen", () => {
    expect(chunksIn(chunks, 0, 2_000, null).map((c) => c.t)).toEqual([1_000]);
    expect(chunksIn(chunks, 4_000, 7_000, null).map((c) => c.t)).toEqual([
      1_000, 3_000, 6_500,
    ]);
    expect(
      chunksIn(chunks, 4_000, 7_000, new Set([2])).map((c) => c.t),
    ).toEqual([3_000]);
    // A chunk ending where the stretch starts is not heard in it.
    expect(chunksIn(chunks, 6_000, 6_400, null)).toEqual([]);
  });

  test("a line plays its speaker alone, from just before it to their next line", () => {
    const m = manifest(chunks, [
      { t: 1_200, s: 1, name: "Aoi", text: "一つ目" },
      { t: 3_100, s: 2, name: "Ren", text: "相づち" },
      { t: 4_000, s: 1, name: "Aoi", text: "二つ目" },
      { t: 30_100, s: 1, name: "Aoi", text: "最後" },
      { t: 31_000, s: null, name: "Mio", text: "音声なし" },
    ]);
    expect(lineRange(m, 0)).toEqual({
      speaker: 1,
      from: 1_200 - LEAD_MS,
      until: 4_000,
    });
    // Their last line in a stretch of speech: to its end. The chunks half
    // a second apart are one stretch; the one at 30 s is not.
    expect(lineRange(m, 2)).toEqual({
      speaker: 1,
      from: 4_000 - LEAD_MS,
      until: 10_500,
    });
    expect(lineRange(m, 3)).toEqual({
      speaker: 1,
      from: 30_100 - LEAD_MS,
      until: 31_000,
    });
    expect(lineRange(m, 4)).toBeUndefined();
  });

  test("the length is the recording's, or its audio's when that runs on", () => {
    expect(length(manifest(chunks, []))).toBe(60_000);
    expect(
      length(manifest([{ s: 1, o: 0, b: 1, t: 59_000, d: 3_000 }], [])),
    ).toBe(62_000);
  });

  test("times, and a file name in Japan time", () => {
    expect(clock(3_723_000)).toBe("01:02:03");
    const start = Date.UTC(2026, 9, 30, 5, 7);
    expect(fileStem(start)).toBe("recording-20261030-1407");
    expect(fileStem(start, "A/o i")).toBe("recording-20261030-1407-A_o_i");
    // A part of the recording names its stretch, as elapsed time (#150).
    expect(fileStem(start, "Ren", { from: 3_381_000, to: 3_403_500 })).toBe(
      "recording-20261030-1407-005621-005643-Ren",
    );
    expect(fileStem(start, undefined, { from: 0, to: 22_000 })).toBe(
      "recording-20261030-1407-000000-000022",
    );
  });

  test("a time typed for a part of the recording (#150)", () => {
    expect(parseClock("00:56:21")).toBe(3_381_000);
    expect(parseClock("56:21")).toBe(3_381_000);
    expect(parseClock(" 1:02:03 ")).toBe(3_723_000);
    expect(parseClock("１：０２")).toBe(62_000);
    expect(parseClock("45")).toBe(45_000);
    expect(parseClock("1:30.5")).toBe(90_500);
    for (const bad of ["", "abc", "1:60", "1:2:3:4", "-5", "1::2"])
      expect(parseClock(bad)).toBeUndefined();
  });

  test("a part of the recording runs forward, inside it (#150)", () => {
    expect(clipRange(1_000, 5_000, 60_000)).toEqual({ from: 1_000, to: 5_000 });
    expect(clipRange(0, 60_000, 60_000)).toEqual({ from: 0, to: 60_000 });
    expect(clipRange(5_000, 5_000, 60_000)).toBeString();
    expect(clipRange(6_000, 5_000, 60_000)).toBeString();
    expect(clipRange(0, 61_000, 60_000)).toBeString();
    expect(clipRange(undefined, 5_000, 60_000)).toBeString();
  });
});

test("the WAV fallback is 16-bit mono PCM with a header that says so", () => {
  const pcm = pcm16(new Float32Array([0, 1, -1, 2]));
  const view = new DataView(pcm.buffer);
  expect([0, 1, 2, 3].map((i) => view.getInt16(i * 2, true))).toEqual([
    0, 32767, -32768, 32767,
  ]);
  const header = wavHeader(16000, pcm.length);
  const h = new DataView(header.buffer);
  expect(new TextDecoder().decode(header.subarray(0, 4))).toBe("RIFF");
  expect(h.getUint32(4, true)).toBe(36 + 8);
  expect(h.getUint16(22, true)).toBe(1);
  expect(h.getUint32(24, true)).toBe(16000);
  expect(h.getUint16(34, true)).toBe(16);
  expect(h.getUint32(40, true)).toBe(8);
});

test("the page loads one script, bundled with nothing left to import", async () => {
  const page = await recordingPlayer();
  expect(page.html).toContain('<script type="module" src="player.js">');
  expect(page.js).not.toMatch(/\bimport\s*[{*"']/);
  expect(page.js).not.toMatch(/\bfrom\s*"/);
  // Built once a process.
  expect(await recordingPlayer()).toBe(page);
});

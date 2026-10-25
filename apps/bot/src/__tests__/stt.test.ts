// xAI Speech to Text over a WebSocket: the part the voice conversation
// (`/join`) and the meeting recording (#118) share. Nothing here reaches the
// network: the socket and the Opus decoder are fakes.
import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import {
  UtteranceAssembler,
  conversationQuery,
  downsample,
  recordingQuery,
  streamSpeech,
  type SttSocket,
} from "../stt";
import type { Json } from "../types";

class FakeSocket implements SttSocket {
  readyState = 0;
  sent: (Buffer | string)[] = [];
  closed = false;
  private listeners = new Map<
    string,
    ((event: { data?: unknown }) => void)[]
  >();
  constructor(
    readonly url: string,
    readonly headers: Record<string, string>,
  ) {}
  addEventListener(
    type: string,
    listener: (event: { data?: unknown }) => void,
    options?: { once?: boolean },
  ) {
    const wrapped = options?.once
      ? (event: { data?: unknown }) => {
          this.off(type, wrapped);
          listener(event);
        }
      : listener;
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), wrapped]);
  }
  private off(type: string, listener: (event: { data?: unknown }) => void) {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((l) => l !== listener),
    );
  }
  emit(type: string, event: { data?: unknown } = {}) {
    for (const l of [...(this.listeners.get(type) ?? [])]) l(event);
  }
  open() {
    this.readyState = 1;
    this.emit("open");
  }
  message(data: Json) {
    this.emit("message", { data: JSON.stringify(data) });
  }
  send(data: Buffer | string) {
    this.sent.push(data);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.emit("close");
  }
}

/** One sample of 48 kHz stereo PCM repeated `frames` times (six samples a frame). */
const pcm = (value: number, frames: number) => {
  const buffer = Buffer.alloc(frames * 12);
  for (let i = 0; i < frames * 6; i++) buffer.writeInt16LE(value, i * 2);
  return buffer;
};
const tick = () => new Promise((r) => setTimeout(r, 5));

describe("downsample", () => {
  test("averages each group of six 48 kHz stereo samples into one 16 kHz mono sample", () => {
    const input = Buffer.alloc(26);
    for (let i = 0; i < 6; i++) input.writeInt16LE(600, i * 2);
    // 100, -100, 300, -300, 500, -500 average to zero.
    [100, -100, 300, -300, 500, -500].forEach((v, i) =>
      input.writeInt16LE(v, 12 + i * 2),
    );
    // Two bytes that make no whole group are dropped.
    const output = downsample(input);
    expect(output.length).toBe(4);
    expect(output.readInt16LE(0)).toBe(600);
    expect(output.readInt16LE(2)).toBe(0);
  });
});

describe("query parameters", () => {
  test("the voice conversation sends what it sent before the recording existed", () => {
    expect([
      ...conversationQuery(true, ["ひばな", "hibana"]).entries(),
    ]).toEqual([
      ["sample_rate", "16000"],
      ["encoding", "pcm"],
      ["interim_results", "false"],
      ["smart_turn", "0.7"],
      ["smart_turn_timeout", "2500"],
      ["language", "ja"],
      ["filler_words", "false"],
      ["keyterm", "ひばな"],
      ["keyterm", "hibana"],
    ]);
    expect(conversationQuery(false, []).get("filler_words")).toBe("true");
  });

  test("the recording waits for no turn and sends no wake words", () => {
    expect([...recordingQuery(true).entries()]).toEqual([
      ["sample_rate", "16000"],
      ["encoding", "pcm"],
      ["interim_results", "false"],
      ["language", "ja"],
      ["filler_words", "false"],
    ]);
    expect(recordingQuery(false).get("filler_words")).toBe("true");
  });
});

describe("UtteranceAssembler", () => {
  const event = (fields: Json) => ({ type: "transcript.partial", ...fields });

  test("an utterance is the text of the utterance-final event, which stitches the chunks before it", () => {
    const a = new UtteranceAssembler();
    expect(
      a.push(
        event({
          is_final: true,
          speech_final: false,
          text: "今日は",
          start: 1.2,
        }),
      ),
    ).toBeUndefined();
    expect(
      a.push(
        event({
          is_final: true,
          speech_final: true,
          text: "今日は晴れです。",
          start: 1.2,
        }),
      ),
    ).toEqual({ text: "今日は晴れです。", start: 1.2 });
    // The chunk is not repeated at the end of the stream.
    expect(a.flush()).toBeUndefined();
  });

  test("interim results and other events are ignored", () => {
    const a = new UtteranceAssembler();
    expect(a.push(event({ is_final: false, text: "あし" }))).toBeUndefined();
    expect(a.push({ type: "transcript.created" })).toBeUndefined();
    expect(a.push({ type: "error", message: "x" })).toBeUndefined();
    expect(a.flush()).toBeUndefined();
  });

  test("chunks a stream ended without an utterance-final event are kept", () => {
    const a = new UtteranceAssembler();
    a.push(
      event({ is_final: true, speech_final: false, text: "明日は", start: 5 }),
    );
    a.push(
      event({
        is_final: true,
        speech_final: false,
        text: "雨です。",
        start: 8,
      }),
    );
    expect(a.flush()).toEqual({ text: "明日は雨です。", start: 5 });
    a.push(
      event({ is_final: true, speech_final: false, text: "See you", start: 9 }),
    );
    a.push(
      event({
        is_final: true,
        speech_final: false,
        text: "tomorrow.",
        start: 10,
      }),
    );
    expect(a.flush()).toEqual({ text: "See you tomorrow.", start: 9 });
  });

  test("an utterance-final event with no text still ends the chunks before it", () => {
    const a = new UtteranceAssembler();
    a.push(
      event({ is_final: true, speech_final: false, text: "はい", start: 2 }),
    );
    expect(
      a.push(event({ is_final: true, speech_final: true, text: "" })),
    ).toEqual({ text: "はい", start: 2 });
    expect(
      a.push(event({ is_final: true, speech_final: true, text: "  " })),
    ).toBeUndefined();
  });
});

describe("streamSpeech", () => {
  const setup = (maxMs = 10000) => {
    const opus = new PassThrough();
    const sockets = new Set<SttSocket>();
    const messages: Json[] = [];
    const errors: unknown[] = [];
    let socket!: FakeSocket;
    const stream = streamSpeech({
      opus,
      // The fake decoder hands the bytes through as if they were PCM.
      decoder: () => new PassThrough(),
      socket: (url, headers) => (socket = new FakeSocket(url, headers)),
      query: new URLSearchParams({ sample_rate: "16000", language: "ja" }),
      key: "fixture",
      sockets,
      maxMs,
      onMessage: (data) => messages.push(data),
      report: (e) => errors.push(e),
    });
    return { opus, sockets, messages, errors, socket: () => socket, stream };
  };

  test("connects with the key, holds the audio until the server is ready, then sends it as 16 kHz mono", async () => {
    const s = setup();
    const socket = s.socket();
    expect(socket.url).toBe(
      "wss://api.x.ai/v1/stt?sample_rate=16000&language=ja",
    );
    expect(socket.headers).toEqual({ Authorization: "Bearer fixture" });
    expect(s.sockets.has(socket)).toBe(true);
    s.opus.write(pcm(1000, 10));
    await tick();
    socket.open();
    expect(socket.sent).toEqual([]);
    socket.message({ type: "transcript.created" });
    expect(socket.sent.length).toBe(1);
    const sent = socket.sent[0] as Buffer;
    expect(sent.length).toBe(20);
    expect(sent.readInt16LE(0)).toBe(1000);
    // Once ready, audio goes straight out.
    s.opus.write(pcm(-200, 2));
    await tick();
    expect((socket.sent[1] as Buffer).length).toBe(4);
    expect(s.messages).toEqual([{ type: "transcript.created" }]);
  });

  test("at the end of the speech, half a second of silence makes the server finish the utterance; the close ends the stream", async () => {
    const s = setup();
    const socket = s.socket();
    socket.open();
    socket.message({ type: "transcript.created" });
    s.opus.write(pcm(1, 4));
    s.opus.end();
    await tick();
    expect(socket.sent.at(-1)).toEqual(Buffer.alloc(16000));
    const final = {
      type: "transcript.partial",
      is_final: true,
      speech_final: true,
      text: "おはようございます",
    };
    socket.message(final);
    expect(s.messages.at(-1)).toEqual(final);
    socket.close();
    await s.stream.done;
    expect(s.sockets.size).toBe(0);
    expect(s.errors).toEqual([]);
  });

  test("speech that ends before the server is ready is still sent, then finished", async () => {
    const s = setup();
    const socket = s.socket();
    s.opus.write(pcm(7, 3));
    s.opus.end();
    await tick();
    socket.open();
    socket.message({ type: "transcript.created" });
    expect((socket.sent[0] as Buffer).length).toBe(6);
    expect(socket.sent.at(-1)).toEqual(Buffer.alloc(16000));
    socket.close();
    await s.stream.done;
  });

  test("end() finishes the speech the same way", async () => {
    const s = setup();
    const socket = s.socket();
    socket.open();
    socket.message({ type: "transcript.created" });
    s.stream.end();
    await tick();
    expect(socket.sent.at(-1)).toEqual(Buffer.alloc(16000));
    socket.close();
    await s.stream.done;
  });

  test("a stream that runs past its limit is closed", async () => {
    const s = setup(20);
    await s.stream.done;
    expect(s.socket().closed).toBe(true);
    expect(s.sockets.size).toBe(0);
  });

  test("a failed connection is reported and ends the stream", async () => {
    const s = setup();
    s.socket().emit("error");
    await s.stream.done;
    expect(String(s.errors[0])).toContain("xAI STT connection failed");
    expect(s.socket().closed).toBe(true);
  });
});

// xAI Speech to Text over a WebSocket (`wss://api.x.ai/v1/stt`), shared by
// the voice conversation (`/join`) and the meeting recording (#118). One
// stream carries one speaker's speech from Discord, from when they start
// talking until a pause.
// Protocol: https://docs.x.ai/developers/rest-api-reference/inference/speech-to-text
// (read 2026-10-25). The server sends `transcript.created` when it is ready
// for audio; `transcript.partial` events carry text, `is_final` locking a
// chunk of about three seconds and `speech_final` ending an utterance with
// the chunks before it stitched in.
import { Readable, Transform } from "node:stream";
import prism from "prism-media";
import WebSocket from "ws";
import type { Json } from "./types";

/** The part of a `ws` WebSocket a stream uses; tests pass a fake. */
export type SttSocket = {
  readonly readyState: number;
  send(data: Buffer | string): void;
  close(): void;
  addEventListener(
    type: string,
    listener: (event: { data?: unknown }) => void,
    options?: { once?: boolean },
  ): void;
};
const OPEN = 1;

/** Discord is 48 kHz stereo. Average each group of six samples into 16 kHz mono. */
export function downsample(pcm: Buffer): Buffer {
  const mono = Buffer.alloc(Math.floor(pcm.length / 12) * 2);
  for (let i = 0; i < mono.length / 2; i++) {
    let sum = 0;
    for (let j = 0; j < 6; j++) sum += pcm.readInt16LE(i * 12 + j * 2);
    mono.writeInt16LE(Math.round(sum / 6), i * 2);
  }
  return mono;
}

/** The voice conversation's parameters: Smart Turn waits for the end of a
 *  turn before it answers, and the wake words are key terms. Unchanged by
 *  the recording (#118). */
export function conversationQuery(fillerRemoval: boolean, words: string[]) {
  const query = new URLSearchParams({
    sample_rate: "16000",
    encoding: "pcm",
    interim_results: "false",
    smart_turn: "0.7",
    smart_turn_timeout: "2500",
    language: "ja",
    filler_words: fillerRemoval ? "false" : "true",
  });
  for (const word of words) query.append("keyterm", word);
  return query;
}

/** The recording's parameters: nothing answers, so no turn is waited for
 *  and no wake word is a key term. Japanese, as the conversation (#118). */
export function recordingQuery(fillerRemoval: boolean) {
  return new URLSearchParams({
    sample_rate: "16000",
    encoding: "pcm",
    interim_results: "false",
    language: "ja",
    filler_words: fillerRemoval ? "false" : "true",
  });
}

export type SpeechStream = {
  /** Settles once the stream is over: closed by the server, failed, or past
   *  its limit. Never rejects. */
  done: Promise<void>;
  /** Ends the speech as a pause would: what was said is still finished. */
  end(): void;
};

/**
 * Sends one speaker's Opus from Discord to xAI as 16 kHz mono PCM.
 * Audio is held (up to 1 MB) until the server is ready. When the speech ends,
 * half a second of silence lets the server finish the utterance, and the
 * stream closes five seconds later at the latest. `maxMs` bounds the whole
 * stream. Every parsed server message is handed to `onMessage`.
 */
export function streamSpeech(options: {
  opus: Readable;
  query: URLSearchParams;
  key: string;
  /** The session's open sockets, so leaving can close them all. */
  sockets: Set<{ close(): void }>;
  maxMs: number;
  onMessage: (data: Json) => void;
  report: (error: unknown) => void;
  /** Tests replace the Opus decoder and the socket. */
  decoder?: () => Transform;
  socket?: (url: string, headers: Record<string, string>) => SttSocket;
}): SpeechStream {
  const { opus, sockets } = options;
  const decoder =
    options.decoder?.() ??
    new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
  opus.pipe(decoder);
  const url = `wss://api.x.ai/v1/stt?${options.query}`;
  const headers = { Authorization: `Bearer ${options.key}` };
  const ws: SttSocket =
    options.socket?.(url, headers) ??
    (new WebSocket(url, { headers }) as unknown as SttSocket);
  sockets.add(ws);
  let ready = false;
  const pending: Buffer[] = [];
  let buffered = 0;
  let finished = false,
    ended = false;
  let complete!: () => void;
  const done = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const finish = () => {
    if (finished) return;
    finished = true;
    complete();
    sockets.delete(ws);
    opus.destroy();
    decoder.destroy();
    ws.close();
    clearTimeout(timer);
  };
  const timer = setTimeout(finish, options.maxMs);
  const flushEnd = () => {
    ws.send(Buffer.alloc(16000));
    setTimeout(finish, 5000).unref();
  };
  decoder.on("data", (pcm: Buffer) => {
    const mono = downsample(pcm);
    if (ready && ws.readyState === OPEN) ws.send(mono);
    else if (buffered < 1024 * 1024) {
      pending.push(mono);
      buffered += mono.length;
    }
  });
  decoder.on("error", finish);
  opus.on("error", finish);
  decoder.on("end", () => {
    ended = true;
    if (ready && ws.readyState === OPEN) flushEnd();
  });
  ws.addEventListener("error", () => {
    options.report(new Error("xAI STT connection failed"));
    finish();
  });
  ws.addEventListener("close", finish, { once: true });
  ws.addEventListener("message", (event) => {
    let data: Json;
    try {
      data = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (data.type === "transcript.created") {
      ready = true;
      for (const bytes of pending) ws.send(bytes);
      pending.length = 0;
      if (ended) flushEnd();
    }
    options.onMessage(data);
  });
  return {
    done,
    // A Discord receive stream ends after a pause; ending it here takes the
    // same path, through the decoder, to the silence above. A second call
    // after the end is ignored by the stream.
    end: () => {
      if (!finished && !opus.destroyed) opus.push(null);
    },
  };
}

/**
 * Builds a recording's utterances from one stream's events (#118). The text
 * of an utterance-final event is the whole utterance. Chunks locked before it
 * are kept only in case the stream ends without one (a limit, a failure),
 * and then joined.
 */
export class UtteranceAssembler {
  private chunks: { text: string; start: number }[] = [];
  push(data: Json): { text: string; start: number } | undefined {
    if (data.type !== "transcript.partial" || data.is_final !== true) return;
    const text = typeof data.text === "string" ? data.text.trim() : "";
    const start = typeof data.start === "number" ? data.start : undefined;
    if (data.speech_final !== true) {
      if (text) this.chunks.push({ text, start: start ?? 0 });
      return;
    }
    if (!text) return this.flush();
    const first = this.chunks[0]?.start;
    this.chunks = [];
    return { text, start: start ?? first ?? 0 };
  }
  flush(): { text: string; start: number } | undefined {
    if (!this.chunks.length) return;
    const start = this.chunks[0]!.start;
    // Japanese runs on without spaces; words of other scripts take one.
    const text = this.chunks
      .map((c) => c.text)
      .reduce((all, next) =>
        /[\x00-\x7f]$/.test(all) && /^[\x00-\x7f]/.test(next)
          ? `${all} ${next}`
          : all + next,
      );
    this.chunks = [];
    return { text, start };
  }
}

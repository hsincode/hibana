import WebSocket from "ws";
import {
  joinVoiceChannel,
  entersState,
  VoiceConnectionStatus,
  EndBehaviorType,
  createAudioPlayer,
  createAudioResource,
  StreamType,
  AudioPlayerStatus,
  type AudioPlayer,
  type VoiceConnection,
} from "@discordjs/voice";
import { Client, ChannelType, PermissionFlagsBits } from "discord.js";
import prism from "prism-media";
import { Readable } from "node:stream";
import { Serial } from "./io";
import { matchesKeyword, triggerWords } from "./triggers";
import type { Runtime } from "./runtime";
import type { ToolRegistry } from "./tools";
import type { Context, Json } from "./types";
type Session = {
  connection: VoiceConnection;
  abort: AbortController;
  player?: AudioPlayer;
  websockets: Set<WebSocket>;
  timer: ReturnType<typeof setTimeout>;
  queue: Serial;
};
export class Voice {
  private sessions = new Map<string, Session>();
  constructor(
    private runtime: Runtime,
    private tools: ToolRegistry,
    private client: Client,
    private respond: (text: string, ctx: Context) => Promise<string>,
    private report: (error: unknown) => void,
  ) {}
  async join(guildId: string, channelId: string, userId: string) {
    const c = this.runtime.config;
    if (!c.voiceEnabled || !c.xaiKey)
      throw new Error("VOICE_ENABLED and XAI_API_KEY are required");
    const channel = await this.client.channels.fetch(channelId);
    if (
      !channel ||
      !("guildId" in channel) ||
      channel.guildId !== guildId ||
      ![ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(
        channel.type,
      )
    )
      throw new Error("Select a voice channel in this server");
    const member = await channel.guild.members.fetch(userId);
    if (
      !channel
        .permissionsFor(member)
        ?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect])
    )
      throw new Error("Voice channel access denied");
    if (!this.sessions.has(guildId) && this.sessions.size >= 3)
      throw new Error("Voice session limit reached");
    this.leave(guildId);
    const connection = joinVoiceChannel({
      channelId,
      guildId,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 30000);
    } catch (error) {
      connection.destroy();
      throw error;
    }
    const session: Session = {
      connection,
      abort: new AbortController(),
      websockets: new Set(),
      timer: setTimeout(() => this.leave(guildId), 1800000),
      queue: new Serial(),
    };
    this.sessions.set(guildId, session);
    connection.on("error", this.report);
    connection.on(VoiceConnectionStatus.Disconnected, () =>
      this.leave(guildId),
    );
    const active = new Set<string>();
    connection.receiver.speaking.on("start", (speaker) => {
      if (
        active.has(speaker) ||
        active.size >= 8 ||
        session.abort.signal.aborted ||
        this.runtime.snapshot.blocked_users.includes(speaker) ||
        this.runtime.guild(guildId).bot_disabled
      )
        return;
      active.add(speaker);
      void this.transcribe(session, guildId, channelId, speaker)
        .catch(this.report)
        .finally(() => active.delete(speaker));
    });
    return { ok: true, channel_id: channelId };
  }
  leave(guildId: string) {
    const session = this.sessions.get(guildId);
    if (!session) return;
    this.sessions.delete(guildId);
    clearTimeout(session.timer);
    session.abort.abort(new Error("Voice session ended"));
    session.player?.stop(true);
    for (const ws of session.websockets) ws.close();
    session.connection.destroy();
  }
  private async transcribe(
    session: Session,
    guildId: string,
    channelId: string,
    userId: string,
  ) {
    const member = await this.client.guilds
      .fetch(guildId)
      .then((g) => g.members.fetch(userId));
    if (member.user.bot || session.abort.signal.aborted) return;
    const opus = session.connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 1200 },
    });
    const decoder = new prism.opus.Decoder({
      rate: 48000,
      channels: 2,
      frameSize: 960,
    });
    opus.pipe(decoder);
    const query = new URLSearchParams({
      sample_rate: "16000",
      encoding: "pcm",
      interim_results: "false",
      smart_turn: "0.7",
      smart_turn_timeout: "2500",
      language: "ja",
      filler_words: this.runtime.guild(guildId).filler_removal
        ? "false"
        : "true",
    });
    const words = triggerWords(
      this.runtime.guild(guildId),
      this.runtime.config.extraTriggers,
    );
    for (const word of words) query.append("keyterm", word);
    const ws = new WebSocket(`wss://api.x.ai/v1/stt?${query}`, {
      headers: { Authorization: `Bearer ${this.runtime.config.xaiKey}` },
    });
    session.websockets.add(ws);
    let ready = false;
    const pending: Buffer[] = [];
    let buffered = 0;
    let finished = false,
      ended = false;
    let complete!: () => void;
    const completed = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const finish = () => {
      if (finished) return;
      finished = true;
      complete();
      session.websockets.delete(ws);
      opus.destroy();
      decoder.destroy();
      ws.close();
      clearTimeout(timer);
    };
    const timer = setTimeout(finish, 120000);
    decoder.on("data", (pcm: Buffer) => {
      // Discord is 48 kHz stereo. Average each group of six samples into 16 kHz mono.
      const mono = Buffer.alloc(Math.floor(pcm.length / 12) * 2);
      for (let i = 0; i < mono.length / 2; i++) {
        let sum = 0;
        for (let j = 0; j < 6; j++) sum += pcm.readInt16LE(i * 12 + j * 2);
        mono.writeInt16LE(Math.round(sum / 6), i * 2);
      }
      if (ready && ws.readyState === WebSocket.OPEN) ws.send(mono);
      else if (buffered < 1024 * 1024) {
        pending.push(mono);
        buffered += mono.length;
      }
    });
    decoder.on("error", finish);
    opus.on("error", finish);
    decoder.on("end", () => {
      ended = true;
      if (ready && ws.readyState === WebSocket.OPEN) {
        ws.send(Buffer.alloc(16000));
        setTimeout(finish, 5000).unref();
      }
    });
    ws.addEventListener("error", () => {
      this.report(new Error("xAI STT connection failed"));
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
        if (ended) {
          ws.send(Buffer.alloc(16000));
          setTimeout(finish, 5000).unref();
        }
      }
      if (
        data.speech_final &&
        typeof data.text === "string" &&
        matchesKeyword(data.text, words)
      ) {
        const text = data.text;
        clearTimeout(session.timer);
        session.timer = setTimeout(() => this.leave(guildId), 1800000);
        const ctx: Context = {
          guildId,
          channelId,
          userId,
          botId: this.client.user!.id,
          thread: false,
          depth: 0,
          delivered: false,
          signal: session.abort.signal,
        };
        void session.queue
          .run(async () => {
            session.abort.signal.throwIfAborted();
            if (this.runtime.guild(guildId).voice_mode === "s2s")
              await this.speak(session, text, ctx);
            else await this.respond(text, ctx);
          })
          .catch(this.report);
      }
    });
    await completed;
  }
  private async speak(session: Session, text: string, ctx: Context) {
    const ws = new WebSocket(
      `wss://api.x.ai/v1/realtime?model=${encodeURIComponent(this.runtime.config.voiceModel)}`,
      { headers: { Authorization: `Bearer ${this.runtime.config.xaiKey}` } },
    );
    session.websockets.add(ws);
    const send = (data: unknown) => ws.send(JSON.stringify(data));
    const tools = this.tools.base({ ...ctx, depth: 1 });
    const audio: Buffer[] = [];
    let audioBytes = 0,
      rounds = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const messages = new Serial();
    let transcript = "";
    try {
      await new Promise<void>((resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Voice response timed out")),
          180000,
        );
        ws.addEventListener(
          "close",
          () => {
            clearTimeout(timer);
            reject(new Error("Voice connection closed"));
          },
          { once: true },
        );
        ws.addEventListener(
          "error",
          () => {
            clearTimeout(timer);
            reject(new Error("Voice connection failed"));
          },
          { once: true },
        );
        ws.addEventListener("open", () =>
          send({
            type: "session.update",
            session: {
              voice: this.runtime.config.voiceName,
              instructions:
                "You are Hibana. Respond in Japanese. Use tools to fulfill requests.",
              turn_detection: null,
              tools: tools.map((t) => ({ type: "function", ...t.function })),
              audio: {
                input: { format: { type: "audio/pcm", rate: 24000 } },
                output: { format: { type: "audio/pcm", rate: 24000 } },
              },
            },
          }),
        );
        let started = false;
        ws.addEventListener("message", (event) => {
          void messages
            .run(async () => {
              const data = JSON.parse(String(event.data)) as Json;
              if (data.type === "session.updated" && !started) {
                started = true;
                send({
                  type: "conversation.item.create",
                  item: {
                    type: "message",
                    role: "user",
                    content: [{ type: "input_text", text }],
                  },
                });
                send({ type: "response.create" });
              }
              if (
                data.type === "response.audio.delta" &&
                typeof data.delta === "string"
              ) {
                const chunk = Buffer.from(data.delta, "base64");
                audioBytes += chunk.length;
                if (audioBytes > 16 * 1024 * 1024)
                  throw new Error("Voice audio limit exceeded");
                audio.push(chunk);
              }
              if (
                data.type === "response.audio_transcript.delta" ||
                data.type === "response.text.delta"
              )
                transcript += String(data.delta ?? "");
              if (data.type === "response.done") {
                const output = ((data.response as Json)?.output ??
                  []) as Json[];
                const calls = output.filter((x) => x.type === "function_call");
                if (calls.length) {
                  if (++rounds > 24)
                    throw new Error("Voice tool round limit reached");
                  for (const call of calls) {
                    let result: unknown;
                    try {
                      if (!tools.some((t) => t.function.name === call.name))
                        throw new Error("Voice tool unavailable");
                      result = await this.tools.execute(
                        String(call.name),
                        JSON.parse(String(call.arguments)),
                        ctx,
                      );
                    } catch (e) {
                      result = { error: String(e) };
                    }
                    send({
                      type: "conversation.item.create",
                      item: {
                        type: "function_call_output",
                        call_id: call.call_id,
                        output: JSON.stringify(result),
                      },
                    });
                  }
                  send({ type: "response.create" });
                } else {
                  clearTimeout(timer);
                  resolve();
                }
              }
              if (data.type === "error") {
                clearTimeout(timer);
                reject(new Error("Voice provider rejected the request"));
              }
            })
            .catch(reject);
        });
      });
      if (transcript) {
        const channel = await this.client.channels.fetch(ctx.channelId);
        if (channel && "send" in channel)
          await channel.send({
            content: transcript.slice(0, 1900),
            allowedMentions: { parse: [] },
          });
      }
      if (audio.length) {
        const mono = Buffer.concat(audio),
          stereo = Buffer.alloc(mono.length * 4);
        for (let i = 0; i + 1 < mono.length; i += 2) {
          const sample = mono.readInt16LE(i);
          for (let j = 0; j < 4; j++)
            stereo.writeInt16LE(sample, i * 4 + j * 2);
        }
        const player = createAudioPlayer();
        session.player = player;
        player.on("error", this.report);
        session.connection.subscribe(player);
        player.play(
          createAudioResource(Readable.from([stereo]), {
            inputType: StreamType.Raw,
          }),
        );
        try {
          await entersState(player, AudioPlayerStatus.Idle, 180000);
        } finally {
          player.stop(true);
          if (session.player === player) session.player = undefined;
        }
      }
    } finally {
      clearTimeout(timer);
      session.websockets.delete(ws);
      ws.close();
    }
  }
  close() {
    for (const id of this.sessions.keys()) this.leave(id);
  }
}

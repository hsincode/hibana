// The Discord and xAI side of the meeting recording (#118): the voice
// connection, one xAI stream per speaker, and the posts. The recorder itself
// (`recording.ts`) only sees `RecordingPort`.
import {
  EndBehaviorType,
  VoiceConnectionStatus,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
} from "@discordjs/voice";
import {
  AttachmentBuilder,
  PermissionFlagsBits,
  type Client,
  type GuildBasedChannel,
} from "discord.js";
import { PassThrough } from "node:stream";
import { sleep } from "./io";
import type { RecordingEvents, RecordingPort, VoiceHandle } from "./recording";
import type { Runtime } from "./runtime";
import { UtteranceAssembler, recordingQuery, streamSpeech } from "./stt";

/** Speakers received at once in one recording, as in the voice
 *  conversation. */
const MAX_SPEAKERS = 8;
/** xAI connections open at once in one recording: the speakers being
 *  received, and utterances still being finished after a pause. */
const MAX_STREAMS = 16;
/** Streams in a row that xAI never got ready for before the channels are
 *  told that speech is not being transcribed. */
const FAILURES_TO_WARN = 5;
/** One stream is cut here; a speaker still talking goes on in a new one. The
 *  conversation's two minutes would drop the middle of a long explanation. */
const STREAM_MAX_MS = 5 * 60000;
/** Leaving waits this long at most for open speech to be finished. */
const FLUSH_MS = 7000;

export class DiscordRecordingPort implements RecordingPort {
  constructor(
    private client: Client,
    private runtime: Runtime,
    private report: (error: unknown) => void,
    /** Tests replace the voice connection and the xAI stream. */
    private deps: {
      joinVoiceChannel?: typeof joinVoiceChannel;
      entersState?: typeof entersState;
      getVoiceConnection?: typeof getVoiceConnection;
      streamSpeech?: typeof streamSpeech;
    } = {},
  ) {}

  async voiceChannelOf(guildId: string, userId: string) {
    const guild = await this.client.guilds.fetch(guildId);
    const member = await guild.members.fetch(userId);
    const channel = member.voice.channel;
    if (!channel) return null;
    const me = await guild.members.fetchMe();
    if (
      !channel
        .permissionsFor(me)
        .has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect])
    )
      throw new Error("bot にこのボイスチャンネルへ接続する権限がありません。");
    return { id: channel.id, name: channel.name, guildName: guild.name };
  }

  humans(guildId: string, channelId: string) {
    const channel = this.client.guilds.cache
      .get(guildId)
      ?.channels.cache.get(channelId);
    if (!channel?.isVoiceBased()) return [];
    return [...channel.members.values()]
      .filter((m) => !m.user.bot)
      .map((m) => ({ id: m.id, name: m.displayName }));
  }

  async canSend(channelId: string) {
    const channel = await this.client.channels
      .fetch(channelId)
      .catch(() => null);
    if (!channel?.isSendable()) return false;
    if (channel.isDMBased()) return true;
    const guildChannel = channel as GuildBasedChannel;
    const me = guildChannel.guild.members.me;
    return Boolean(
      me &&
      guildChannel
        .permissionsFor(me)
        ?.has([
          PermissionFlagsBits.ViewChannel,
          channel.isThread()
            ? PermissionFlagsBits.SendMessagesInThreads
            : PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.AttachFiles,
        ]),
    );
  }

  async send(
    channelId: string,
    message: { content: string; files?: { name: string; data: Buffer }[] },
  ) {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel?.isSendable()) throw new Error("Channel is not sendable");
    await channel.send({
      content: message.content,
      files: message.files?.map(
        (f) => new AttachmentBuilder(f.data, { name: f.name }),
      ),
      // The notices name people and channels; nobody is pinged.
      allowedMentions: { parse: [] },
    });
  }

  async join(
    guildId: string,
    channelId: string,
    events: RecordingEvents,
  ): Promise<VoiceHandle> {
    const join = this.deps.joinVoiceChannel ?? joinVoiceChannel;
    const waitFor = this.deps.entersState ?? entersState;
    const stream = this.deps.streamSpeech ?? streamSpeech;
    // A server has one voice connection, and joining again returns it. One
    // still open (a /join call connecting, a recording leaving) is not taken.
    const existing = (this.deps.getVoiceConnection ?? getVoiceConnection)(
      guildId,
    );
    if (existing && existing.state.status !== VoiceConnectionStatus.Destroyed)
      throw new Error(
        "このサーバーでは bot がボイスチャンネルに接続しています（/join の通話など）。終わってから始めてください。",
      );
    const guild = await this.client.guilds.fetch(guildId);
    const connection = join({
      channelId,
      guildId,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
      // A recording never speaks.
      selfMute: true,
    });
    try {
      await waitFor(connection, VoiceConnectionStatus.Ready, 30000);
    } catch (error) {
      connection.destroy();
      throw error;
    }
    const abort = new AbortController();
    const sockets = new Set<{ close(): void }>();
    // Speakers whose speech is being received now. A speaker's slot is the
    // Discord receive stream, which ends at a pause; the xAI streams are fed
    // from it. Once it ends, the utterance is still being finished (up to
    // five seconds), and the speaker may already be talking again.
    const speakers = new Map<string, { end?: () => void }>();
    /** Every utterance still being received or finished. */
    const tasks = new Set<Promise<void>>();
    // Other bots (a music bot) are not part of the meeting.
    const bots = new Set<string>();
    let failures = 0;
    const listen = (userId: string) => {
      if (
        abort.signal.aborted ||
        bots.has(userId) ||
        speakers.has(userId) ||
        speakers.size >= MAX_SPEAKERS ||
        tasks.size >= MAX_STREAMS
      )
        return;
      const entry: { end?: () => void } = {};
      speakers.set(userId, entry);
      const release = () => {
        if (speakers.get(userId) === entry) speakers.delete(userId);
      };
      const task = (async () => {
        const member = await guild.members.fetch(userId);
        if (member.user.bot) {
          bots.add(userId);
          return;
        }
        if (abort.signal.aborted) return;
        const opus = connection.receiver.subscribe(userId, {
          end: { behavior: EndBehaviorType.AfterSilence, duration: 1200 },
        });
        let receiving = true;
        // Until a stream is open, leaving just ends the receive stream.
        entry.end = () => {
          if (!opus.destroyed) opus.push(null);
        };
        const received = new Promise<void>((resolve) =>
          opus.once("close", () => {
            receiving = false;
            release();
            resolve();
          }),
        );
        // The audio is kept for as long as the speaker is received (#138),
        // whatever happens to the transcription.
        const sink = events.audio?.(userId, member.displayName);
        if (sink) {
          opus.on("data", (packet: Buffer) => sink.packet(packet, Date.now()));
          void received.then(() => sink.end());
        }
        // One xAI stream at a time. A stream that reached its limit while
        // the speaker is still talking is followed by a new one, but only
        // after one xAI was transcribing: one it refused or closed at once
        // (a bad key, an outage, a limit) is not retried until the speaker
        // pauses.
        while (receiving && !abort.signal.aborted) {
          const input = new PassThrough({ objectMode: true });
          let feeding = true;
          const feed = (packet: Buffer) => {
            if (feeding && !input.destroyed) input.write(packet);
          };
          const stop = () => {
            if (!feeding) return;
            feeding = false;
            if (!input.destroyed) input.end();
          };
          opus.on("data", feed);
          opus.once("close", stop);
          const startedAt = Date.now();
          const assembler = new UtteranceAssembler();
          const emit = (u: { text: string; start: number } | undefined) => {
            if (u)
              events.utterance(
                userId,
                member.displayName,
                startedAt + Math.round(u.start * 1000),
                u.text,
              );
          };
          const state: {
            /** xAI took the stream (`transcript.created`). */
            ready?: boolean;
            /** xAI sent an error event: the stream counts as failed. */
            failed?: boolean;
            /** xAI sent text: it was transcribing speech. */
            transcribed?: boolean;
          } = {};
          const speech = stream({
            opus: input,
            query: recordingQuery(this.runtime.guild(guildId).filler_removal),
            key: this.runtime.config.xaiKey,
            sockets,
            maxMs: STREAM_MAX_MS,
            report: this.report,
            onMessage: (data) => {
              if (data.type === "transcript.created") state.ready = true;
              if (data.type === "transcript.partial") state.transcribed = true;
              if (data.type === "error") state.failed = true;
              emit(assembler.push(data));
            },
          });
          // Leaving ends the speech as a pause would: what was said is
          // finished, and the receive stream (and the audio) ends.
          entry.end = () => {
            feeding = false;
            speech.end();
            if (!opus.destroyed) opus.push(null);
          };
          await speech.done;
          opus.off("data", feed);
          opus.off("close", stop);
          feeding = false;
          emit(assembler.flush());
          if (state.ready && !state.failed) failures = 0;
          else if (++failures === FAILURES_TO_WARN && !abort.signal.aborted)
            events.failing();
          if (!state.transcribed) break;
        }
        await received;
      })()
        .catch(this.report)
        .finally(() => {
          release();
          tasks.delete(task);
        });
      tasks.add(task);
    };
    connection.receiver.speaking.on("start", listen);
    connection.on("error", this.report);
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      // A move between channels, or a short drop, reconnects by itself.
      try {
        await Promise.race([
          waitFor(connection, VoiceConnectionStatus.Signalling, 5000),
          waitFor(connection, VoiceConnectionStatus.Connecting, 5000),
        ]);
      } catch {
        if (!abort.signal.aborted) events.disconnected();
      }
    });
    return {
      leave: async (flush) => {
        if (abort.signal.aborted) return;
        abort.abort();
        connection.receiver.speaking.off("start", listen);
        if (flush) {
          for (const s of speakers.values()) s.end?.();
          await Promise.race([Promise.allSettled([...tasks]), sleep(FLUSH_MS)]);
        }
        for (const ws of sockets) ws.close();
        if (connection.state.status !== VoiceConnectionStatus.Destroyed)
          connection.destroy();
      },
    };
  }
}

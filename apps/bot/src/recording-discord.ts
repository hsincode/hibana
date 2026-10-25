// The Discord and xAI side of the meeting recording (#118): the voice
// connection, one xAI stream per speaker, and the posts. The recorder itself
// (`recording.ts`) only sees `RecordingPort`.
import {
  EndBehaviorType,
  VoiceConnectionStatus,
  entersState,
  joinVoiceChannel,
} from "@discordjs/voice";
import {
  AttachmentBuilder,
  PermissionFlagsBits,
  type Client,
  type GuildBasedChannel,
} from "discord.js";
import { sleep } from "./io";
import type { RecordingEvents, RecordingPort, VoiceHandle } from "./recording";
import type { Runtime } from "./runtime";
import {
  UtteranceAssembler,
  recordingQuery,
  streamSpeech,
  type SpeechStream,
} from "./stt";

/** Speakers transcribed at once in one recording, as in the voice
 *  conversation: a bound on the xAI connections a meeting opens. */
const MAX_SPEAKERS = 8;
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
    // Discord receive stream, not the xAI stream: once the receive stream
    // ends at a pause, the utterance is still being finished (up to five
    // seconds), and the speaker may already be talking again.
    const speakers = new Map<string, { stream?: SpeechStream }>();
    /** Every utterance still being received or finished. */
    const tasks = new Set<Promise<void>>();
    // Other bots (a music bot) are not part of the meeting.
    const bots = new Set<string>();
    const listen = (userId: string) => {
      if (
        abort.signal.aborted ||
        bots.has(userId) ||
        speakers.has(userId) ||
        speakers.size >= MAX_SPEAKERS
      )
        return;
      const entry: { stream?: SpeechStream } = {};
      speakers.set(userId, entry);
      const release = (again: boolean) => {
        if (speakers.get(userId) !== entry) return;
        speakers.delete(userId);
        // Still talking when the receive stream closed (it reached its
        // limit): carry on in a new one. Deferred, so the receiver has let
        // go of the stream that closed before a new one is asked for.
        if (
          again &&
          !abort.signal.aborted &&
          connection.receiver.speaking.users.has(userId)
        )
          setTimeout(() => listen(userId), 0);
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
        opus.once("close", () => release(true));
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
        entry.stream = stream({
          opus,
          query: recordingQuery(this.runtime.guild(guildId).filler_removal),
          key: this.runtime.config.xaiKey,
          sockets,
          maxMs: STREAM_MAX_MS,
          report: this.report,
          onMessage: (data) => emit(assembler.push(data)),
        });
        await entry.stream.done;
        emit(assembler.flush());
      })()
        .catch(this.report)
        // Never listens again from here: a lookup that keeps failing would
        // loop.
        .finally(() => {
          release(false);
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
          for (const s of speakers.values()) s.stream?.end();
          await Promise.race([Promise.allSettled([...tasks]), sleep(FLUSH_MS)]);
        }
        for (const ws of sockets) ws.close();
        if (connection.state.status !== VoiceConnectionStatus.Destroyed)
          connection.destroy();
      },
    };
  }
}

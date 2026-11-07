import {
  AttachmentBuilder,
  PermissionFlagsBits,
  type Client,
} from "discord.js";
import type { ScheduleTarget } from "./schedules";

/** Where the bot can be in voice in a server: a `/join` conversation or a
 *  recording. A server has one voice connection, so at most one answers. */
type VoicePlayer = {
  play(guildId: string, path: string, maxMs: number): Promise<boolean>;
};

/** Scheduled actions on Discord. Nobody asked for them in the moment, so the
 *  checks are the bot's own: the channel must be in the server, and the bot
 *  must be able to see it, send there and attach files. */
export class DiscordScheduleTarget implements ScheduleTarget {
  constructor(
    private client: Client,
    private voices: VoicePlayer[],
  ) {}

  async post(
    guildId: string,
    channelId: string,
    message: { text: string; file?: { name: string; data: Buffer } },
  ) {
    const channel = await this.client.channels
      .fetch(channelId)
      .catch(() => null);
    if (!channel || !("guildId" in channel) || channel.guildId !== guildId)
      throw new Error(
        `Scheduled post: channel ${channelId} is not in server ${guildId}`,
      );
    if (!channel.isTextBased() || !("send" in channel))
      throw new Error(`Scheduled post: channel ${channelId} takes no messages`);
    const me =
      channel.guild.members.me ?? (await channel.guild.members.fetchMe());
    const needed = [
      PermissionFlagsBits.ViewChannel,
      channel.isThread()
        ? PermissionFlagsBits.SendMessagesInThreads
        : PermissionFlagsBits.SendMessages,
      ...(message.file ? [PermissionFlagsBits.AttachFiles] : []),
    ];
    if (!channel.permissionsFor(me)?.has(needed))
      throw new Error(
        `Scheduled post: the bot may not post${message.file ? " files" : ""} in channel ${channelId}`,
      );
    await channel.send({
      content: message.text.trim() || undefined,
      files: message.file
        ? [
            new AttachmentBuilder(message.file.data, {
              name: message.file.name,
            }),
          ]
        : undefined,
      allowedMentions: { parse: [] },
    });
  }

  async play(guildId: string, path: string, maxMs: number) {
    for (const voice of this.voices)
      if (await voice.play(guildId, path, maxMs)) return "played" as const;
    return "absent" as const;
  }
}

import { Client, PermissionFlagsBits as P, MessageFlags } from "discord.js";
import { readFile, lstat } from "node:fs/promises";
import { basename } from "node:path";
import type { Context, Json } from "../types";
import type { Runtime } from "../runtime";
import type { Sandbox } from "./sandbox";
import { downloadPublic } from "../network";
export const ADMIN_TOOLS = new Set([
  "edit_guild",
  "create_emoji",
  "delete_emoji",
  "create_sticker",
  "delete_sticker",
  "edit_channel",
  "create_channel",
  "delete_channel",
  "create_role",
  "edit_role",
  "delete_role",
  "add_role",
  "remove_role",
  "set_nickname",
  "timeout_member",
  "remove_timeout",
  "kick_member",
  "ban_member",
  "unban_member",
  "create_invite",
  "delete_invite",
  "bulk_delete_messages",
  "pin_message",
  "unpin_message",
  "list_bans",
  "get_ban",
  "list_invites",
  "list_channel_invites",
  "list_webhooks",
  "list_guild_webhooks",
  "get_audit_log",
]);
const permission: Record<string, bigint> = {
  edit_guild: P.ManageGuild,
  create_emoji: P.ManageGuildExpressions,
  delete_emoji: P.ManageGuildExpressions,
  create_sticker: P.ManageGuildExpressions,
  delete_sticker: P.ManageGuildExpressions,
  edit_channel: P.ManageChannels,
  create_channel: P.ManageChannels,
  delete_channel: P.ManageChannels,
  create_role: P.ManageRoles,
  edit_role: P.ManageRoles,
  delete_role: P.ManageRoles,
  add_role: P.ManageRoles,
  remove_role: P.ManageRoles,
  set_nickname: P.ManageNicknames,
  timeout_member: P.ModerateMembers,
  remove_timeout: P.ModerateMembers,
  kick_member: P.KickMembers,
  ban_member: P.BanMembers,
  unban_member: P.BanMembers,
  create_invite: P.CreateInstantInvite,
  delete_invite: P.ManageGuild,
  bulk_delete_messages: P.ManageMessages,
  pin_message: P.ManageMessages,
  unpin_message: P.ManageMessages,
  list_bans: P.BanMembers,
  get_ban: P.BanMembers,
  list_invites: P.ManageGuild,
  list_channel_invites: P.ManageChannels,
  list_webhooks: P.ManageWebhooks,
  list_guild_webhooks: P.ManageWebhooks,
  get_audit_log: P.ViewAuditLog,
};
export const id = (value: unknown): string => {
  if (typeof value !== "string" || !/^\d{1,25}$/.test(value))
    throw new Error("Expected a Discord snowflake string");
  return value;
};
const pick = (a: Json, keys: string[]) =>
  Object.fromEntries(
    keys.filter((k) => a[k] !== undefined).map((k) => [k, a[k]]),
  );
export class DiscordTools {
  constructor(
    readonly client: Client,
    private runtime: Runtime,
    private sandbox: Sandbox,
  ) {}
  async authorizeChannel(ctx: Context, channelId: string) {
    const channel = await this.client.channels.fetch(id(channelId));
    if (!channel) throw new Error("Channel not found");
    if ("guildId" in channel) {
      if (channel.guildId !== ctx.guildId)
        throw new Error("Cross-guild access denied");
      const member = await channel.guild.members.fetch(ctx.userId);
      if (
        !channel
          .permissionsFor(member)
          ?.has([P.ViewChannel, P.ReadMessageHistory])
      )
        throw new Error("You cannot read this channel");
    } else if (channel.id !== ctx.channelId || ctx.guildId)
      throw new Error("Cross-DM access denied");
    return channel;
  }
  async image(ctx: Context, path: unknown, url: unknown): Promise<Buffer> {
    if (typeof path === "string") {
      const p = await this.sandbox.path(ctx, path);
      if ((await lstat(p)).size > 8 * 1024 * 1024)
        throw new Error("Image too large");
      return readFile(p);
    }
    if (typeof url === "string")
      return Buffer.from(
        await (
          await downloadPublic(url, ctx.signal, 8 * 1024 * 1024)
        ).arrayBuffer(),
      );
    throw new Error("Image path or URL is required");
  }
  async execute(name: string, a: Json, ctx: Context): Promise<unknown> {
    const guildId = a.guild_id === undefined ? ctx.guildId : id(a.guild_id);
    if (guildId !== ctx.guildId) throw new Error("Cross-guild access denied");
    const channelId =
      typeof a.channel_id === "string" ? id(a.channel_id) : ctx.channelId;
    const channel = await this.authorizeChannel(ctx, channelId);
    if (ADMIN_TOOLS.has(name)) {
      if (!guildId || !this.runtime.guild(guildId).server_tools)
        throw new Error("Server tools are disabled");
      const member = await this.client.guilds
        .fetch(guildId)
        .then((g) => g.members.fetch(ctx.userId));
      const perms =
        "permissionsFor" in channel
          ? channel.permissionsFor(member)
          : member.permissions;
      if (permission[name] && !perms?.has(permission[name]!))
        throw new Error("You do not have permission for this operation");
    }
    if (name === "set_bot_username" || name === "set_bot_avatar")
      if (this.runtime.role(ctx.userId) !== "administrator")
        throw new Error(
          "Administrator role required for global bot profile changes",
        );
    const rest = this.client.rest;
    const request = async (
      method: "get" | "post" | "put" | "patch" | "delete",
      path: string,
      body?: Json,
      query?: URLSearchParams,
      files?: { data: Buffer; name: string }[],
    ) => {
      const result = await rest[method](path as `/${string}`, {
        body,
        query,
        files,
        reason: typeof a.reason === "string" ? a.reason : undefined,
      });
      // Never expose webhook tokens through an LLM context.
      return JSON.parse(
        JSON.stringify(result ?? { ok: true }, (key, value) =>
          ["token", "access_token"].includes(key) ? undefined : value,
        ),
      );
    };
    const c = `/channels/${channelId}`,
      g = `/guilds/${guildId}`,
      msg = () => `${c}/messages/${id(a.message_id ?? ctx.messageId)}`,
      uid = () => id(a.user_id),
      rid = () => id(a.role_id);
    const guild = () => {
      if (!guildId) throw new Error("This tool requires a guild");
      return g;
    };
    const query = (keys: string[], defaults: Json = {}) =>
      new URLSearchParams(
        Object.entries({ ...defaults, ...pick(a, keys) }).map(([k, v]) => [
          k,
          String(v),
        ]),
      );
    switch (name) {
      case "get_bot_profile":
        return request("get", "/users/@me");
      case "set_bot_username":
        return request("patch", "/users/@me", { username: a.username });
      case "set_bot_avatar":
        return request("patch", "/users/@me", {
          avatar: a.clear
            ? null
            : `data:image/png;base64,${(await this.image(ctx, a.path, a.image_url)).toString("base64")}`,
        });
      case "read_messages":
        return request(
          "get",
          `${c}/messages`,
          undefined,
          query(["before", "after"], {
            limit: Math.min(100, Math.max(1, Number(a.limit ?? 20))),
          }),
        );
      case "get_message":
        return request("get", msg());
      case "search_messages": {
        const q = query([
          "query",
          "limit",
          "offset",
          "sort_by",
          "sort_order",
          "min_id",
          "max_id",
        ]);
        if (q.has("query")) {
          q.set("content", q.get("query")!);
          q.delete("query");
        }
        const channels = Array.isArray(a.channel_id)
          ? a.channel_id
          : typeof a.channel_id === "string"
            ? [a.channel_id]
            : a.all_channels
              ? []
              : [ctx.channelId];
        for (const cid of channels) {
          await this.authorizeChannel(ctx, id(cid));
          q.append("channel_id", String(cid));
        }
        if (a.all_channels && !channels.length) {
          if (!guildId) throw new Error("Guild required");
          const all = await this.client.guilds
            .fetch(guildId)
            .then((g) => g.channels.fetch());
          for (const candidate of all.values()) {
            if (!candidate) continue;
            try {
              await this.authorizeChannel(ctx, candidate.id);
              q.append("channel_id", candidate.id);
            } catch {}
          }
          if (!q.has("channel_id")) throw new Error("No readable channels");
        }
        for (const field of [
          "author_id",
          "mentions",
          "has",
          "author_type",
          "pinned",
        ])
          for (const v of Array.isArray(a[field])
            ? (a[field] as unknown[])
            : a[field] === undefined
              ? []
              : [a[field]])
            q.append(field, String(v));
        return request("get", `${guild()}/messages/search`, undefined, q);
      }
      case "list_pins":
        return request("get", `${c}/pins`);
      case "list_channels": {
        const channels = (await request(
          "get",
          `${guild()}/channels`,
        )) as Json[];
        const visible: Json[] = [];
        for (const row of channels) {
          try {
            await this.authorizeChannel(ctx, String(row.id));
            visible.push(row);
          } catch {}
        }
        return visible;
      }
      case "get_channel":
        return request("get", c);
      case "get_guild":
        return request("get", guild());
      case "get_guild_preview":
        return request("get", `${guild()}/preview`);
      case "list_members":
        return request(
          "get",
          `${guild()}/members`,
          undefined,
          query(["after"], { limit: Math.min(1000, Number(a.limit ?? 50)) }),
        );
      case "search_members":
        return request(
          "get",
          `${guild()}/members/search`,
          undefined,
          query(["query"], { limit: Math.min(1000, Number(a.limit ?? 25)) }),
        );
      case "get_user":
        return request("get", `/users/${uid()}`);
      case "get_member":
        return request("get", `${guild()}/members/${uid()}`);
      case "get_bot_member":
        return request("get", `${guild()}/members/${ctx.botId}`);
      case "list_roles":
        return request("get", `${guild()}/roles`);
      case "get_role":
        return (
          ((await request("get", `${guild()}/roles`)) as Json[]).find(
            (r) => r.id === rid(),
          ) ?? null
        );
      case "list_emojis":
        return request("get", `${guild()}/emojis`);
      case "list_stickers":
        return request("get", `${guild()}/stickers`);
      case "list_bans":
        return request(
          "get",
          `${guild()}/bans`,
          undefined,
          query([], { limit: Math.min(1000, Number(a.limit ?? 50)) }),
        );
      case "get_ban":
        return request("get", `${guild()}/bans/${uid()}`);
      case "list_invites":
        return request("get", `${guild()}/invites`);
      case "list_channel_invites":
        return request("get", `${c}/invites`);
      case "list_active_threads":
        return request("get", `${guild()}/threads/active`);
      case "list_public_archived_threads":
        return request(
          "get",
          `${c}/threads/archived/public`,
          undefined,
          query(["limit"]),
        );
      case "list_voice_regions":
        return request("get", `${guild()}/regions`);
      case "list_webhooks":
        return request("get", `${c}/webhooks`);
      case "list_guild_webhooks":
        return request("get", `${guild()}/webhooks`);
      case "get_audit_log":
        return request(
          "get",
          `${guild()}/audit-logs`,
          undefined,
          query(["limit", "user_id", "action_type"]),
        );
      case "add_reaction":
      case "remove_reaction":
        return request(
          name === "add_reaction" ? "put" : "delete",
          `${msg()}/reactions/${encodeURIComponent(String(a.emoji).replace(/^<a?:|>$/g, ""))}/@me`,
        );
      case "send_message":
        return request("post", `${c}/messages`, {
          content: a.content,
          allowed_mentions: { parse: [] },
          flags: this.runtime.resolve(ctx.guildId, ctx.userId).suppress_embeds
            ? MessageFlags.SuppressEmbeds
            : 0,
          ...(a.reply_to_message_id
            ? { message_reference: { message_id: id(a.reply_to_message_id) } }
            : {}),
        });
      case "edit_message":
        return request("patch", msg(), {
          content: a.content,
          allowed_mentions: { parse: [] },
        });
      case "delete_message": {
        const message = (await request("get", msg())) as {
          author: { id: string };
        };
        if (message.author.id !== ctx.botId) {
          if (
            !("permissionsFor" in channel) ||
            !channel.permissionsFor(ctx.userId)?.has(P.ManageMessages)
          )
            throw new Error("Manage Messages permission required");
        }
        return request("delete", msg());
      }
      case "bulk_delete_messages":
        return request("post", `${c}/messages/bulk-delete`, {
          messages: (a.message_ids as unknown[]).map(id),
        });
      case "pin_message":
      case "unpin_message":
        return request(
          name === "pin_message" ? "put" : "delete",
          `${c}/pins/${id(a.message_id)}`,
        );
      case "create_thread":
      case "create_thread_without_message":
        return request(
          "post",
          name === "create_thread" ? `${msg()}/threads` : `${c}/threads`,
          {
            name: a.name,
            auto_archive_duration: a.auto_archive_minutes ?? 1440,
            ...(name === "create_thread_without_message"
              ? { type: 11, invitable: a.invitable }
              : {}),
          },
        );
      case "edit_guild": {
        const body = pick(a, ["name", "description"]);
        if (a.clear_icon) body.icon = null;
        else if (a.icon_path || a.icon_url)
          body.icon = `data:image/png;base64,${(await this.image(ctx, a.icon_path, a.icon_url)).toString("base64")}`;
        return request("patch", guild(), body);
      }
      case "create_emoji":
        return request("post", `${guild()}/emojis`, {
          name: a.name,
          image: `data:image/png;base64,${(await this.image(ctx, a.path, a.image_url)).toString("base64")}`,
        });
      case "delete_emoji":
        return request("delete", `${guild()}/emojis/${id(a.emoji_id)}`);
      case "create_sticker":
        return request(
          "post",
          `${guild()}/stickers`,
          pick(a, ["name", "description", "tags"]),
          undefined,
          [
            {
              name: basename(String(a.path ?? "sticker.png")),
              data: await this.image(ctx, a.path, a.image_url),
            },
          ],
        );
      case "delete_sticker":
        return request("delete", `${guild()}/stickers/${id(a.sticker_id)}`);
      case "edit_channel":
        return request("patch", c, {
          ...pick(a, [
            "name",
            "topic",
            "nsfw",
            "rate_limit_per_user",
            "position",
          ]),
          ...(a.parent_id === undefined
            ? {}
            : { parent_id: a.parent_id === "" ? null : id(a.parent_id) }),
        });
      case "create_channel":
        return request("post", `${guild()}/channels`, {
          ...pick(a, [
            "name",
            "topic",
            "parent_id",
            "nsfw",
            "rate_limit_per_user",
          ]),
          type:
            (
              {
                text: 0,
                voice: 2,
                category: 4,
                announcement: 5,
                stage: 13,
                forum: 15,
              } as Record<string, number>
            )[String(a.kind ?? "text")] ?? 0,
        });
      case "delete_channel":
        return request("delete", c);
      case "create_role":
        return request(
          "post",
          `${guild()}/roles`,
          pick(a, ["name", "hoist", "mentionable", "color"]),
        );
      case "edit_role":
      case "delete_role":
      case "add_role":
      case "remove_role": {
        const server = await this.client.guilds.fetch(guildId!);
        const actor = await server.members.fetch(ctx.userId);
        const role = await server.roles.fetch(rid());
        if (
          !role ||
          role.managed ||
          role.id === guildId ||
          (actor.id !== server.ownerId &&
            actor.roles.highest.comparePositionTo(role) <= 0)
        )
          throw new Error("Role hierarchy denies this change");
        if (name === "edit_role")
          return request(
            "patch",
            `${guild()}/roles/${rid()}`,
            pick(a, ["name", "hoist", "mentionable", "color"]),
          );
        if (name === "delete_role")
          return request("delete", `${guild()}/roles/${rid()}`);
        return request(
          name === "add_role" ? "put" : "delete",
          `${guild()}/members/${uid()}/roles/${rid()}`,
        );
      }
      case "set_nickname":
      case "timeout_member":
      case "remove_timeout":
      case "kick_member":
      case "ban_member": {
        const server = await this.client.guilds.fetch(guildId!);
        const actor = await server.members.fetch(ctx.userId);
        const target = await server.members.fetch(uid()).catch(() => null);
        if (
          target &&
          (target.id === server.ownerId ||
            (actor.id !== server.ownerId &&
              actor.roles.highest.comparePositionTo(target.roles.highest) <= 0))
        )
          throw new Error("Member hierarchy denies this change");
        if (name === "set_nickname")
          return request("patch", `${guild()}/members/${uid()}`, {
            nick: a.nickname,
          });
        if (name === "kick_member")
          return request("delete", `${guild()}/members/${uid()}`);
        if (name === "ban_member")
          return request("put", `${guild()}/bans/${uid()}`, {
            delete_message_seconds:
              Math.min(7, Math.max(0, Number(a.delete_message_days ?? 0))) *
              86400,
          });
        return request("patch", `${guild()}/members/${uid()}`, {
          communication_disabled_until:
            name === "remove_timeout"
              ? null
              : new Date(
                  Date.now() +
                    Math.min(
                      28 * 86400,
                      Math.max(1, Number(a.duration_seconds)),
                    ) *
                      1000,
                ).toISOString(),
        });
      }
      case "unban_member":
        return request("delete", `${guild()}/bans/${uid()}`);
      case "create_invite":
        return request("post", `${c}/invites`, {
          max_age: 86400,
          ...pick(a, ["max_age", "max_uses", "temporary", "unique"]),
        });
      case "delete_invite": {
        const code = String(a.code);
        if (!/^[\w-]+$/.test(code)) throw new Error("Invalid invite code");
        const invite = (await request("get", `/invites/${code}`)) as {
          guild?: { id: string };
        };
        if (invite.guild?.id !== guildId)
          throw new Error("Cross-guild invite denied");
        return request("delete", `/invites/${code}`);
      }
      default:
        throw new Error(`Unknown Discord tool: ${name}`);
    }
  }
  async sendFile(ctx: Context, a: Json, replyTo?: string) {
    const channelId = a.channel_id ? id(a.channel_id) : ctx.channelId;
    await this.authorizeChannel(ctx, channelId);
    const path = await this.sandbox.path(ctx, String(a.path));
    const stat = await lstat(path);
    if (!stat.isFile() || stat.size > 25 * 1024 * 1024)
      throw new Error("Attachment must be a regular file under 25 MiB");
    const result = await this.client.rest.post(
      `/channels/${channelId}/messages`,
      {
        body: {
          content: a.content || undefined,
          allowed_mentions: { parse: [] },
          // The direct `/image` shortcut replies to the request. Tool calls
          // omit replyTo, so model-sent files stay unthreaded.
          ...(replyTo
            ? {
                message_reference: {
                  message_id: id(replyTo),
                  fail_if_not_exists: false,
                },
              }
            : {}),
        },
        files: [
          {
            data: await readFile(path),
            name: basename(String(a.filename ?? path)),
          },
        ],
      },
    );
    ctx.delivered = true;
    return result;
  }
}

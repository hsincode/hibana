import { type ChatInputCommandInteraction, MessageFlags } from "discord.js";
import {
  REASONING_EFFORTS,
} from "@hibana/shared/catalog";
import type { Runtime } from "./runtime";
import type { ToolRegistry } from "./tools";
import type { History } from "./history";
import type { Voice } from "./voice";
import type { Context, Json } from "./types";
const string = (
  name: string,
  description: string,
  choices?: readonly string[],
  required = false,
) => ({
  type: 3,
  name,
  description,
  required,
  ...(choices
    ? { choices: choices.map((value) => ({ name: value, value })) }
    : {}),
});
const command = (
  name: string,
  description: string,
  options: unknown[] = [],
) => ({ name, description, options });
export function commands(runtime: Runtime) {
  const flags = [
    ["server-tools", "サーバー操作ツール"],
    ["thread-only", "スレッド限定"],
    ["suppress-embeds", "リンクプレビュー抑制"],
  ] as const;
  return [
    command("info", "Hibanaの現在の設定"),
    command("clear", "このチャンネルの会話履歴を消去"),
    command("context", "会話履歴とトークン使用量"),
    command("retry", "失敗した作業を再開"),
    command("switch", "このサーバーのモデルを切り替え", [
      { ...string("preset", "モデルのプリセット"), autocomplete: true },
      string("effort", "推論の深さ", [...REASONING_EFFORTS, "default"]),
      string("ultra", "Ultracode（xhigh・ワークフローを常時編成）", ["on", "off"]),
      string("multi", "Multi-Agent（役割分担・並列）", ["on", "off"]),
    ]),
    ...flags.map(([name, desc]) =>
      command(name, desc, [
        string("mode", "on / off", ["on", "off"], true),
      ]),
    ),
    command("temperature", "生成温度を変更", [
      {
        type: 10,
        name: "value",
        description: "0〜2。省略でデフォルト値を設定",
        min_value: 0,
        max_value: 2,
      },
    ]),
    command("exa", "検索方式を変更", [
      string("mode", "検索方式", ["on", "off", "auto", "reset"], true),
    ]),
    command("thread-history", "スレッド履歴の保持期間", [
      {
        type: 4,
        name: "seconds",
        description: "0で期限なし。省略でデフォルト値を設定",
        min_value: 0,
      },
    ]),
    ...["server-context", "user-context"].map((name) =>
      command(name, "人格や継続的な指示を設定", [
        string("text", "継続的な指示"),
        {
          type: 5,
          name: "persona_override",
          description: "既定の人格を置き換える",
        },
        { type: 5, name: "clear", description: "設定を消去" },
      ]),
    ),
    ...(runtime.config.voiceEnabled
      ? [
          command("join", "ボイスチャンネルに参加", [
            {
              type: 7,
              name: "channel",
              description: "参加するチャンネル",
              required: true,
              channel_types: [2, 13],
            },
          ]),
          command("leave", "ボイスチャンネルから退出"),
          command("voice-mode", "通話モード", [
            string("mode", "通話モード", ["stt", "s2s"], true),
          ]),
          command("filler-words", "通話のフィラー処理", [
            string("mode", "フィラー", ["remove", "keep"], true),
          ]),
        ]
      : []),
    ...["login", "status", "logout"].map((action) =>
      command(`${action}-github`, "GitHub認証を管理"),
    ),
    ...(runtime.config.vpnEnabled
      ? [
          "connect",
          "disconnect",
          "reconnect",
          "status",
          ...(runtime.config.vpnProvider === "surfshark" ? ["login"] : []),
        ].map((action) =>
          command(
            `${action}-vpn`,
            "VPNを管理",
            action === "connect" || action === "reconnect"
              ? [
                  string(
                    "server",
                    runtime.config.vpnProvider === "vpngate"
                      ? "国コード (jp, us, auto)"
                      : "Surfsharkロケーション",
                  ),
                ]
              : [],
          ),
        )
      : []),
  ];
}
export async function handleCommand(
  i: ChatInputCommandInteraction,
  runtime: Runtime,
  tools: ToolRegistry,
  history: History,
  voice: Voice,
  retry: (ctx: Context) => Promise<void>,
) {
  if (runtime.snapshot.blocked_users.includes(i.user.id)) {
    await i.reply({
      content: "利用が無効になっています。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const ctx: Context = {
    guildId: i.guildId ?? undefined,
    channelId: i.channelId,
    userId: i.user.id,
    botId: i.client.user.id,
    thread: i.channel?.isThread() ?? false,
    depth: 0,
    delivered: false,
    progress: async (text) => {
      await i.editReply(text.slice(0, 1900));
    },
  };
  const s = (name: string) => i.options.getString(name),
    b = (name: string) => i.options.getBoolean(name);
  try {
    let result: unknown;
    let patch: Json = {};
    const guild = () => {
      if (!i.guildId) throw new Error("サーバー内で使用してください。");
      return i.guildId;
    };
    switch (i.commandName) {
      case "info":
        result = runtime.resolve(ctx.guildId, ctx.userId);
        break;
      case "context":
        result = history.info(ctx.channelId);
        break;
      case "clear":
        history.clear(ctx.channelId);
        result = { ok: true };
        break;
      case "retry":
        await i.editReply("作業を再開します。");
        await retry(ctx);
        return;
      case "switch":
        patch = {
          ...(s("preset") ? { preset: s("preset") } : {}),
          ...(s("ultra") ? { ultra_mode: s("ultra") === "on" } : {}),
          // multi:off returns to Ultra; ultra:off alone also leaves Multi-Agent.
          ...(s("multi") ? { multi_agent: s("multi") === "on" } : {}),
          ...(s("effort")
            ? { effort: s("effort") === "default" ? null : s("effort") }
            : {}),
        };
        if (!Object.keys(patch).length)
          result = runtime.resolve(ctx.guildId, ctx.userId).selection;
        break;
      case "temperature":
        patch = { temperature: i.options.getNumber("value") };
        break;
      case "exa":
        patch = { exa_mode: s("mode") === "reset" ? null : s("mode") };
        break;
      case "thread-history":
        patch = {
          thread_history_max_age_secs: i.options.getInteger("seconds"),
        };
        break;
      case "server-context":
      case "user-context":
        if (i.commandName === "server-context") guild();
        if (
          s("text") === null &&
          b("clear") === null &&
          b("persona_override") === null
        )
          result = runtime.resolve(ctx.guildId, ctx.userId).context;
        else {
          await runtime.setContext(ctx.guildId, ctx.userId, {
            text: s("text") ?? undefined,
            persona_override: b("persona_override") ?? undefined,
            clear: b("clear") ?? undefined,
          });
          result = { ok: true };
        }
        break;
      case "join":
        result = await voice.join(
          guild(),
          i.options.getChannel("channel", true).id,
          i.user.id,
        );
        break;
      case "leave":
        voice.leave(guild());
        result = { ok: true };
        break;
      case "voice-mode":
        patch = { voice_mode: s("mode") };
        break;
      case "filler-words":
        patch = { filler_removal: s("mode") === "remove" };
        break;
      case "login-github":
      case "status-github":
      case "logout-github":
        result = await tools.execute(
          `gh_${i.commandName.split("-")[0]}`,
          {},
          ctx,
        );
        break;
      case "connect-vpn":
      case "disconnect-vpn":
      case "reconnect-vpn":
      case "status-vpn":
      case "login-vpn": {
        const action = i.commandName.split("-")[0];
        result = await tools.execute(
          action === "login"
            ? "vpn_login_code"
            : action === "reconnect"
              ? "vpn_connect"
              : `vpn_${action}`,
          {
            ...(s("server") ? { server: s("server") } : {}),
            ...(action === "reconnect" ? { reconnect: true } : {}),
          },
          ctx,
        );
        break;
      }
      default: {
        const key = (
          {
            "server-tools": "server_tools",
            "thread-only": "thread_only",
            "suppress-embeds": "suppress_embeds",
          } as Record<string, string>
        )[i.commandName];
        if (key) {
          const value = s("mode");
          patch = {
            [key]: value === "on",
          };
          break;
        }
        throw new Error("不明なコマンドです。");
      }
    }
    if (Object.keys(patch).length)
      result = await runtime.patch(guild(), patch, i.user.id);
    await i.editReply(
      "```json\n" +
        JSON.stringify(result ?? { ok: true }, null, 2).slice(0, 1850) +
        "\n```",
    );
  } catch (error) {
    await i.editReply(
      `エラー: ${error instanceof Error ? error.message : String(error)}`.slice(
        0,
        1900,
      ),
    );
  }
}

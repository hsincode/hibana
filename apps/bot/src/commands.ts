import { type ChatInputCommandInteraction, MessageFlags } from "discord.js";
import {
  REASONING_EFFORTS,
  SELECTABLE_PRESETS,
  ultraSupported,
  WORKSPACE_PROVIDER,
} from "@hibana/shared/catalog";
import { TEXT_MODEL_EFFORTS, isTextModelPreset } from "@hibana/shared/settings";
import type { Runtime } from "./runtime";
import type { ToolRegistry } from "./tools";
import type { History } from "./history";
import type { Voice } from "./voice";
import type { Recorder } from "./recording";
import type { UsageLedger } from "./usage-ledger";
import type { Workspace } from "./workspace";
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
    command("usage", "Anthropic API の利用額（推計と Workspace の公開単価）"),
    command("switch", "このサーバーのモデルを切り替え", [
      { ...string("preset", "モデルのプリセット"), autocomplete: true },
      string("effort", "推論の深さ", [...REASONING_EFFORTS, "default"]),
      string(
        "ultra",
        "Ultracode（xhigh・ワークフロー）。Workspace は Haiku 5.5 だけ Ultra",
        ["on", "off"],
      ),
      string("multi", "Multi-Agent（役割分担・並列）", ["on", "off"]),
    ]),
    ...flags.map(([name, desc]) =>
      command(name, desc, [string("mode", "on / off", ["on", "off"], true)]),
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
          // Meeting recording (#118): the voice channel is the one the
          // member is in, and the summary goes to this channel.
          command("recording", "会議の録音と文字起こし", [
            {
              type: 1,
              name: "start",
              description: "いるボイスチャンネルの録音を始める",
            },
            {
              type: 1,
              name: "stop",
              description: "録音を止めて、要約と全文をこのチャンネルに送る",
            },
          ]),
          command(
            "text-model",
            "録音の要約に使うモデル（Text Generation Model）",
            [
              {
                ...string("preset", "Anthropic API のモデル"),
                // Fixed when the commands are registered, at start.
                choices: SELECTABLE_PRESETS.filter(
                  (p) =>
                    isTextModelPreset(p.id) &&
                    !runtime.snapshot.unpublished_presets.includes(p.id),
                ).map((p) => ({ name: p.label, value: p.id })),
              },
              string("effort", "推論の深さ", TEXT_MODEL_EFFORTS),
            ],
          ),
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
  usage: UsageLedger,
  /** Anthropic Workspace sessions (#76). */
  workspace?: Workspace,
  /** Meeting recordings (#118). */
  recorder?: Recorder,
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
    // Shown above the JSON, which is cut to what the message has room for.
    let note: string | undefined;
    const guild = () => {
      if (!i.guildId) throw new Error("サーバー内で使用してください。");
      return i.guildId;
    };
    switch (i.commandName) {
      case "info": {
        const settings = runtime.resolve(ctx.guildId, ctx.userId);
        result = settings;
        if (settings.selection.provider === WORKSPACE_PROVIDER)
          note =
            "Anthropic Workspace: 会話と作業領域は Anthropic のクラウドにあります（チャンネルごと）。";
        break;
      }
      case "context": {
        // `turns` and `estimated_tokens` are the local record of the
        // conversation, also for a Workspace channel, whose conversation
        // itself is in the cloud session named here.
        const cloud = workspace?.info(ctx.channelId);
        result = cloud
          ? { ...history.info(ctx.channelId), workspace: cloud }
          : history.info(ctx.channelId);
        break;
      }
      case "usage":
        // Spend covers every server the bot is in. It was the owner's alone
        // (#44); since #85 anyone may read it. Blocked users are refused above.
        result = usage.summary();
        // Workspace sessions report their own cost; it is not in the estimate.
        note = workspace?.usageLine();
        break;
      case "clear": {
        // Asked first: the clear is what ends the channel's session.
        const cloud = workspace?.info(ctx.channelId);
        history.clear(ctx.channelId);
        result = cloud
          ? {
              ok: true,
              workspace: "クラウドのセッションと作業ファイルの削除を始めました",
            }
          : { ok: true };
        break;
      }
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
        if (recorder?.active(guild()))
          note =
            "録音は続いています。止めるには `/recording stop` を使ってください。";
        break;
      case "recording": {
        if (!recorder) throw new Error("録音は使えません。");
        if (i.options.getSubcommand() === "stop") {
          result = await recorder.stop(guild(), i.user.id);
          note = "録音を止めました。要約を作って、このチャンネルに送ります。";
        } else {
          result = await recorder.start(guild(), i.channelId, i.user.id);
          note = "録音を始めました。";
        }
        break;
      }
      case "text-model": {
        const current = runtime.guild(guild()).text_model;
        if (s("preset") === null && s("effort") === null) result = current;
        else
          patch = {
            text_model: {
              preset: s("preset") ?? current.preset,
              effort: s("effort") ?? current.effort,
            },
          };
        break;
      }
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
    if (Object.keys(patch).length) {
      result = await runtime.patch(guild(), patch, i.user.id);
      if (i.commandName === "text-model")
        result = runtime.guild(guild()).text_model;
      // The switch is stored either way; on Anthropic Workspace it only
      // takes effect as Haiku Ultra (#76), and the person is told when the
      // turns they will get are not that.
      if (
        i.commandName === "switch" &&
        (patch.ultra_mode === true || patch.multi_agent === true)
      ) {
        const settings = runtime.resolve(ctx.guildId, ctx.userId);
        if (
          settings.selection.provider === WORKSPACE_PROVIDER &&
          !settings.workspace_ultra
        )
          note = ultraSupported(settings.selection)
            ? "Anthropic Workspace の Ultra は、いまの設定では働きません（Multi-Agent が on か、ワークフローが無効です）。設定は保存しました。"
            : "Anthropic Workspace の Ultra は Haiku 5.5 だけで働きます。設定は保存しました。";
      }
    }
    // A Discord message holds 2000 characters. A short note leaves the JSON
    // the 1850 it always had; a longer one takes its room from the JSON.
    const room = Math.min(1850, 1987 - (note?.length ?? 0));
    await i.editReply(
      (note ? `${note}\n` : "") +
        "```json\n" +
        JSON.stringify(result ?? { ok: true }, null, 2).slice(0, room) +
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

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message as DiscordMessage } from "discord.js";
import pino from "pino";
import { Hibana } from "../bot";
import { loadConfig } from "../config";
import type { Context, Json } from "../types";

const usage = {
  prompt_tokens: 1,
  completion_tokens: 1,
  total_tokens: 2,
  cached_tokens: 0,
};
const dm: Context = {
  channelId: "10000",
  userId: "20000",
  botId: "30000",
  thread: false,
  depth: 0,
  delivered: false,
};

function incoming(
  content: string,
  options: { dm?: boolean; mention?: boolean } = {},
): DiscordMessage {
  const isDm = options.dm ?? true;
  return {
    id: "50000",
    channelId: "10000",
    guildId: isDm ? null : "11111",
    content,
    author: { id: "20000", bot: false, displayName: "user" },
    member: isDm ? null : { displayName: "member" },
    mentions: {
      users: {
        has: (id: string) => options.mention === true && id === "30000",
      },
    },
    pinned: false,
    system: false,
    attachments: new Map(),
    channel: { isThread: () => false, name: "general" },
  } as unknown as DiscordMessage;
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "hibana-image-shortcut-"));
  const bot = new Hibana(
    loadConfig({
      HIBANA_DATA_DIR: dir,
      PROVIDER: "custom",
      LLM_BASE_URL: "https://example.com/v1",
      LLM_API_KEY: "key",
      LLM_MODEL: "test",
      SANDBOX_ENABLED: "false",
      SKILLS_ENABLED: "false",
      SUBAGENT_ENABLED: "false",
      LOG_DIR: "",
      IMAGE_WORKER_URL: "http://127.0.0.1:18190",
      IMAGE_WORKER_TOKEN: "test-secret-".repeat(4),
    }),
    pino({ enabled: false }),
  );
  (bot.client as { user: { id: string } | null }).user = { id: "30000" };
  bot.tools.sandbox.available = true;
  const sent: { content?: string; reply?: { messageReference?: string } }[] = [];
  let guild = false;
  bot.client.channels.fetch = (async (id: string) => {
    const channel = {
      id,
      isSendable: () => true,
      sendTyping: async () => {},
      send: async (value: { content?: string; reply?: { messageReference?: string } }) => {
        sent.push(value);
        return { id: "sent", edit: async () => {} };
      },
    };
    if (!guild) return channel;
    return {
      ...channel,
      guildId: "11111",
      guild: { members: { fetch: async () => ({ id: "20000" }) } },
      permissionsFor: () => ({ has: () => true }),
    };
  }) as never;
  const generated: { prompt: string; replyTo?: string; path?: string }[] = [];
  bot.tools.image.generate = (async (args: Json) => {
    generated.push({ prompt: String(args.prompt) });
    return {
      ok: true,
      path: "generated/qwen-test.png",
      bytes: 12,
      model: "Qwen-Image-2.1",
      next: "",
    };
  }) as typeof bot.tools.image.generate;
  bot.tools.discord.sendFile = (async (_ctx, args, replyTo) => {
    const row = generated.at(-1);
    if (row) {
      row.replyTo = replyTo;
      row.path = String(args.path);
    }
    return { id: "file" };
  }) as typeof bot.tools.discord.sendFile;
  let rounds = 0;
  bot.llm.complete = async () => {
    rounds++;
    return {
      message: { role: "assistant" as const, content: "agent" },
      usage,
      incomplete: false,
    };
  };
  const handle = (message: DiscordMessage) =>
    (
      bot as unknown as { onMessage(message: DiscordMessage): Promise<void> }
    ).onMessage(message);
  return {
    bot,
    dir,
    sent,
    generated,
    rounds: () => rounds,
    setGuild: (value: boolean) => {
      guild = value;
    },
    handle,
    cleanup: async () => {
      await bot.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

describe("direct /image prefix", () => {
  test("a triggering /image message generates and replies without the model", async () => {
    const f = await fixture();
    try {
      await f.handle(incoming("/image a red panda"));
      expect(f.rounds()).toBe(0);
      expect(f.sent).toEqual([]);
      expect(f.generated).toEqual([
        {
          prompt: "a red panda",
          replyTo: "50000",
          path: "generated/qwen-test.png",
        },
      ]);
      const settings = f.bot.runtime.resolve(undefined, "20000");
      expect(
        f.bot.history
          .get(
            "10000",
            undefined,
            JSON.stringify(settings.selection),
            false,
            settings.thread_history_max_age_secs ?? f.bot.config.threadHistoryAge,
          )
          .map((message) => message.content),
      ).toEqual([
        "/image a red panda",
        "画像を送信しました: generated/qwen-test.png",
      ]);
      f.setGuild(true);
      f.generated.length = 0;
      await f.handle(
        incoming("<@30000> /image shrine at dusk", { dm: false, mention: true }),
      );
      expect(f.rounds()).toBe(0);
      expect(f.generated.map((row) => row.prompt)).toEqual(["shrine at dusk"]);
    } finally {
      await f.cleanup();
    }
  });

  test("non-triggers and non-prefixes stay off the image worker", async () => {
    const f = await fixture();
    try {
      f.setGuild(true);
      await f.handle(incoming("/image a cat", { dm: false }));
      expect(f.generated).toEqual([]);
      expect(f.rounds()).toBe(0);
      await f.handle(incoming("hibana /image a cat", { dm: false }));
      expect(f.generated).toEqual([]);
      expect(f.rounds()).toBe(1);
      expect(f.sent.at(-1)?.content).toBe("agent");
    } finally {
      await f.cleanup();
    }
  });

  test("empty, oversized and unavailable prompts do not call the worker", async () => {
    const f = await fixture();
    try {
      await f.handle(incoming("/image"));
      await f.handle(incoming(`/image ${"a".repeat(8001)}`));
      f.bot.runtime.config.imageWorkerUrl = "";
      await f.handle(incoming("/image a cat"));
      expect(f.generated).toEqual([]);
      expect(f.sent.map((message) => message.content)).toEqual([
        "画像の説明を `/image ` のあとに書いてください。",
        "プロンプトは8000文字までです。",
        "画像生成はいま使えません。",
      ]);
      expect(f.sent.every((message) => message.reply?.messageReference === "50000")).toBe(true);
    } finally {
      await f.cleanup();
    }
  });

  test("worker and delivery failures are told to the channel", async () => {
    const f = await fixture();
    try {
      f.bot.tools.image.generate = (async () => {
        throw new Error("Image PC is busy; try again later");
      }) as typeof f.bot.tools.image.generate;
      await f.handle(incoming("/image a cat"));
      f.bot.tools.image.generate = (async () => ({
        ok: true,
        path: "generated/qwen-test.png",
        bytes: 4,
        model: "Qwen-Image-2.1",
        next: "",
      })) as typeof f.bot.tools.image.generate;
      f.bot.tools.discord.sendFile = (async () => {
        throw new Error("discord down");
      }) as typeof f.bot.tools.discord.sendFile;
      await f.handle(incoming("/image another"));
      expect(f.sent.map((message) => message.content)).toEqual([
        "画像生成PCが使用中です。しばらくしてからもう一度送ってください。",
        "画像は作れましたが、送信できませんでした。",
      ]);
    } finally {
      await f.cleanup();
    }
  });

  test("an in-progress turn is not steered into the image prompt", async () => {
    const f = await fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const startedP = new Promise<void>((resolve) => {
      started = resolve;
    });
    let rounds = 0;
    f.bot.llm.complete = async () => {
      rounds++;
      started();
      await gate;
      return {
        message: { role: "assistant" as const, content: "done" },
        usage,
        incomplete: false,
      };
    };
    try {
      const turn = f.bot.respond("hello", dm);
      await startedP;
      const image = f.handle(incoming("/image a panda"));
      expect(f.generated).toEqual([]);
      release();
      expect(await turn).toBe("done");
      await image;
      expect(rounds).toBe(1);
      expect(f.generated.map((row) => row.prompt)).toEqual(["a panda"]);
    } finally {
      await f.cleanup();
    }
  });
});

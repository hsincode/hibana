import type { JevClient } from "../jev";
import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { loadConfig } from "../config";
import { Hibana } from "../bot";
import { Runtime } from "../runtime";
import { createApp } from "../../../api/src/create-app";
import { loadTestEnv } from "../../../api/src/env";
import { MemoryStore } from "../../../api/src/store";
import { ProviderError } from "../llm-errors";
import type { Completion } from "../llm";
import type { Context, Json, Message } from "../types";
const context: Context = {
  channelId: "10000",
  userId: "20000",
  botId: "30000",
  thread: false,
  depth: 0,
  delivered: false,
};
test("Jev start notice survives progress edits and the parent delivers the final reply", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hibana-jev-e2e-"));
  const bot = new Hibana(
    loadConfig({
      HIBANA_DATA_DIR: dir,
      JEV_API_KEY: "jev-fixture",
      SANDBOX_ENABLED: "false",
      SKILLS_ENABLED: "false",
      LOG_DIR: "",
    }),
    pino({ enabled: false }),
  );
  const sent: { content: string; allowedMentions: unknown }[] = [];
  const questions = {
    relevant: { type: "noul", instructions: "Is this about a refund?" },
  };
  let round = 0;
  bot.llm.complete = async (_selection, messages, tools) => {
    expect(tools.some((t) => t.function.name === "mcp__agent__run_jev")).toBe(
      true,
    );
    round++;
    const call =
      round === 1
        ? {
            name: "mcp__agent__run_jev",
            arguments: JSON.stringify({
              state: "Please refund my order",
              questions,
            }),
          }
        : { name: "mcp__settings__get_bot_settings", arguments: "{}" };
    if (round === 2) {
      const tool = messages.find((m) => m.tool_call_id === "call-1");
      expect(JSON.parse(tool!.content!).answers.relevant.noul).toBe(0.98);
    }
    return {
      message: {
        role: "assistant",
        content:
          round === 1
            ? "内容を確認します。"
            : round === 2
              ? "結果をまとめています。"
              : "返金に関する問い合わせです。",
        tool_calls:
          round < 3
            ? [{ id: `call-${round}`, type: "function", function: call }]
            : [],
      },
      usage: {
        prompt_tokens: 1,
        completion_tokens: 1,
        total_tokens: 2,
        cached_tokens: 0,
      },
      incomplete: false,
    };
  };
  bot.tools.jev.decide = async (
    input,
  ): Promise<Awaited<ReturnType<JevClient["decide"]>>> => {
    if ("completion" in input.questions)
      return {
        model: "~typesafe/jev-latest",
        answers: { completion: { type: "choice", choice: "complete" } },
        usage: {
          prompt_tokens: 1,
          completion_tokens: 0,
          total_tokens: 1,
          cached_tokens: 0,
        },
        cost: 0,
      };
    expect(sent.at(-1)?.content).toStartWith("サブ: Jev を呼び出します");
    return {
      model: "~typesafe/jev-latest",
      answers: { relevant: { type: "noul", noul: 0.98 } },
      usage: {
        prompt_tokens: 1,
        completion_tokens: 0,
        total_tokens: 1,
        cached_tokens: 0,
      },
      cost: 0,
    };
  };
  bot.client.channels.fetch = (async () => ({
    id: context.channelId,
    isSendable: () => true,
    send: async (value: { content: string; allowedMentions: unknown }) => {
      const message = { ...value };
      sent.push(message);
      return {
        id: String(sent.length),
        edit: async (next: { content: string }) => {
          message.content = next.content;
        },
      };
    },
    sendTyping: async () => {},
  })) as never;
  try {
    const reply = await bot.respond("この問い合わせを分類して", { ...context });
    // Progress stacks: the second round's text is added under the first.
    expect(sent.map((m) => m.content)).toEqual([
      "内容を確認します。\n結果をまとめています。",
      "サブ: Jev を呼び出します(1回目)",
      reply,
    ]);
    expect(reply).toBe("返金に関する問い合わせです。");
    expect(sent[1]?.allowedMentions).toEqual({ parse: [] });
  } finally {
    await bot.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("progress stacks in one message and goes on in the next when it would not fit (#134)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hibana-progress-stack-"));
  const bot = new Hibana(
    loadConfig({
      HIBANA_DATA_DIR: dir,
      SANDBOX_ENABLED: "false",
      SKILLS_ENABLED: "false",
      LOG_DIR: "",
    }),
    pino({ enabled: false }),
  );
  const sent: { content: string }[] = [];
  const edits: string[] = [];
  const step = (n: number) => `${n}`.repeat(800);
  let round = 0;
  bot.llm.complete = async () => {
    round++;
    return {
      message: {
        role: "assistant",
        content: round < 4 ? `\n${step(round)}\n` : "終わりました。",
        tool_calls:
          round < 4
            ? [
                {
                  id: `call-${round}`,
                  type: "function",
                  function: {
                    name: "mcp__settings__get_bot_settings",
                    arguments: "{}",
                  },
                },
              ]
            : [],
      },
      usage: {
        prompt_tokens: 1,
        completion_tokens: 1,
        total_tokens: 2,
        cached_tokens: 0,
      },
      incomplete: false,
    };
  };
  bot.client.channels.fetch = (async () => ({
    id: context.channelId,
    isSendable: () => true,
    send: async (value: { content: string }) => {
      const message = { ...value };
      sent.push(message);
      return {
        id: String(sent.length),
        edit: async (next: { content: string }) => {
          edits.push(next.content);
          message.content = next.content;
        },
      };
    },
    sendTyping: async () => {},
  })) as never;
  try {
    const reply = await bot.respond("設定を見て", { ...context });
    expect(reply).toBe("終わりました。");
    // 800 + 1 + 800 fits in 1,900 characters; the third step does not, so
    // it starts the next message and the first keeps both earlier steps.
    expect(sent.map((m) => m.content)).toEqual([
      `${step(1)}\n${step(2)}`,
      step(3),
      reply,
    ]);
    expect(edits).toEqual([`${step(1)}\n${step(2)}`]);
  } finally {
    await bot.close();
    await rm(dir, { recursive: true, force: true });
  }
});
// #140: the reconnect line of a request goes once the request is over.
const reconnecting = (attempt: number) =>
  `応答を再接続しています（${attempt}/5・送信時・HTTP 529）。進捗は保持しています。`;
/** A turn whose model requests are `rounds`, in order: each may reconnect
 *  a number of times first, then answers, or fails. What the channel shows
 *  at the end and everything done to it are kept. */
async function reconnectTurn(
  rounds: {
    reconnects?: number;
    content?: string;
    tool?: boolean;
    fail?: boolean;
  }[],
) {
  const dir = await mkdtemp(join(tmpdir(), "hibana-reconnect-"));
  const bot = new Hibana(
    loadConfig({
      HIBANA_DATA_DIR: dir,
      SANDBOX_ENABLED: "false",
      SKILLS_ENABLED: "false",
      LOG_DIR: "",
    }),
    pino({ enabled: false }),
  );
  let round = 0;
  bot.llm.complete = async (_selection, _messages, _tools, options) => {
    const step = rounds[round++]!;
    for (let attempt = 1; attempt <= (step.reconnects ?? 0); attempt++)
      await options?.onRetry?.({
        phase: "request",
        attempt,
        maxRetries: 5,
        delayMs: 0,
        status: 529,
        diagnostics: { phase: "request" },
      });
    if (step.fail) {
      const error = new ProviderError("transient", true, 529);
      error.diagnostics = { phase: "request", retries: step.reconnects };
      throw error;
    }
    const message: Message = {
      role: "assistant",
      content: step.content ?? "",
      tool_calls: step.tool
        ? [
            {
              id: `call-${round}`,
              type: "function",
              function: {
                name: "mcp__settings__get_bot_settings",
                arguments: "{}",
              },
            },
          ]
        : [],
    };
    return {
      message,
      usage: {
        prompt_tokens: 1,
        completion_tokens: 1,
        total_tokens: 2,
        cached_tokens: 0,
      },
      incomplete: false,
    } satisfies Completion;
  };
  const shown = new Map<string, string>();
  const log: string[] = [];
  bot.client.channels.fetch = (async () => ({
    id: context.channelId,
    isSendable: () => true,
    send: async (value: { content: string }) => {
      const id = String(log.filter((l) => l.startsWith("send")).length + 1);
      shown.set(id, value.content);
      log.push(`send ${id}: ${value.content}`);
      return {
        id,
        edit: async (next: { content: string }) => {
          shown.set(id, next.content);
          log.push(`edit ${id}: ${next.content}`);
        },
        delete: async () => {
          shown.delete(id);
          log.push(`delete ${id}`);
        },
      };
    },
    sendTyping: async () => {},
  })) as never;
  try {
    const reply = await bot.respond("設定を見て", { ...context });
    return { reply, shown: [...shown.values()], log };
  } finally {
    await bot.close();
    await rm(dir, { recursive: true, force: true });
  }
}
test("a reconnect notice goes once the response arrives (#140)", async () => {
  const { reply, shown, log } = await reconnectTurn([
    { reconnects: 2, content: "内容を確認します。", tool: true },
    { content: "終わりました。" },
  ]);
  expect(reply).toBe("終わりました。");
  // The lines stack while it reconnects. Nothing else was in the message,
  // so it is deleted, and the model's text starts a message of its own.
  expect(log).toEqual([
    `send 1: ${reconnecting(1)}`,
    `edit 1: ${reconnecting(1)}\n${reconnecting(2)}`,
    "delete 1",
    "send 2: 内容を確認します。",
    "send 3: 終わりました。",
  ]);
  expect(shown).toEqual(["内容を確認します。", "終わりました。"]);
});
test("a reconnect notice between steps is cut out of the stacked progress (#140)", async () => {
  const { shown, log } = await reconnectTurn([
    { content: "計画します。", tool: true },
    { reconnects: 1, content: "続けます。", tool: true },
    { content: "終わりました。" },
  ]);
  expect(log).toEqual([
    "send 1: 計画します。",
    `edit 1: 計画します。\n${reconnecting(1)}`,
    "edit 1: 計画します。",
    "edit 1: 計画します。\n続けます。",
    "send 2: 終わりました。",
  ]);
  expect(shown).toEqual(["計画します。\n続けます。", "終わりました。"]);
});
test("a request that fails after reconnecting takes its notice back before the failure notice (#140)", async () => {
  const { reply, shown, log } = await reconnectTurn([
    { content: "計画します。", tool: true },
    { reconnects: 2, fail: true },
  ]);
  expect(reply).toBe("");
  const failure =
    "プロバイダとの通信を再試行しましたが、応答を完了できませんでした。（送信時・HTTP 529・再試行 2 回） 進捗を保存しました。`/retry` または次のメッセージで再開できます。";
  expect(log).toEqual([
    "send 1: 計画します。",
    `edit 1: 計画します。\n${reconnecting(1)}`,
    `edit 1: 計画します。\n${reconnecting(1)}\n${reconnecting(2)}`,
    "edit 1: 計画します。",
    `send 2: ${failure}`,
  ]);
  expect(shown).toEqual(["計画します。", failure]);
});
test("Jev task status edits one Discord message across plans", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hibana-jev-task-e2e-"));
  const bot = new Hibana(
    loadConfig({
      HIBANA_DATA_DIR: dir,
      JEV_API_KEY: "jev-fixture",
      JEV_TASK_ENABLED: "true",
      JEV_ENABLED: "false",
      SANDBOX_ENABLED: "false",
      SKILLS_ENABLED: "false",
      LOG_DIR: "",
    }),
    pino({ enabled: false }),
  );
  bot.tools.sandbox.available = true;
  const sent: { content: string }[] = [];
  let round = 0;
  const plan = {
    objective: "List workspace files",
    state: "workspace",
    actions: [
      {
        id: "list",
        description: "List files",
        tool: "list_files",
        arguments: {},
      },
    ],
  };
  bot.llm.complete = async (_selection, _messages, tools) => {
    expect(
      tools.some((t) => t.function.name === "mcp__agent__run_jev_task"),
    ).toBe(true);
    round++;
    return {
      message:
        round < 3
          ? {
              role: "assistant" as const,
              content: round === 1 ? "計画します。" : "続きを進めます。",
              tool_calls: [
                {
                  id: `plan${round}`,
                  type: "function" as const,
                  function: {
                    name: "mcp__agent__run_jev_task",
                    arguments: JSON.stringify(plan),
                  },
                },
              ],
            }
          : { role: "assistant" as const, content: "一覧を確認しました。" },
      usage: {
        prompt_tokens: 1,
        completion_tokens: 1,
        total_tokens: 2,
        cached_tokens: 0,
      },
      incomplete: false,
    };
  };
  bot.tools.jev.decide = async () => ({
    model: "~typesafe/jev-latest",
    answers: {
      action: { type: "choice" as const, choice: "a0", confidence: 0.9 },
    },
    usage: {
      prompt_tokens: 1,
      completion_tokens: 0,
      total_tokens: 1,
      cached_tokens: 0,
    },
    cost: 0,
  });
  bot.client.channels.fetch = (async () => ({
    id: context.channelId,
    isSendable: () => true,
    send: async (value: { content: string }) => {
      const message = { ...value };
      sent.push(message);
      return {
        id: String(sent.length),
        edit: async (next: { content: string }) => {
          message.content = next.content;
        },
      };
    },
    sendTyping: async () => {},
  })) as never;
  try {
    const reply = await bot.respond("ファイルを確認して", { ...context });
    const jev = sent.filter((m) =>
      m.content.startsWith("サブ: Jev でタスクを進めます。"),
    );
    expect(jev).toHaveLength(1);
    expect(jev[0]!.content.split("\n")[0]).toBe(
      "サブ: Jev でタスクを進めます。(6回目)",
    );
    expect(jev[0]!.content.split("\n").length).toBeLessThanOrEqual(3);
    expect(jev[0]!.content).toContain("候補の実行が終わりました。");
    // The parent's progress stacks (#134) and stays apart from Jev's status.
    expect(
      sent.some((m) => m.content === "計画します。\n続きを進めます。"),
    ).toBe(true);
    expect(reply).toBe("一覧を確認しました。");
    round = 0;
    sent.length = 0;
    await bot.respond("もう一度確認して", { ...context });
    expect(
      sent
        .find((m) => m.content.startsWith("サブ: Jev"))
        ?.content.split("\n")[0],
    ).toBe("サブ: Jev でタスクを進めます。(6回目)");
  } finally {
    await bot.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("bot turn calls the local provider, executes a settings tool, replies, persists usage and clears its checkpoint", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hibana-e2e-"));
  const sent: string[] = [];
  const requests: Json[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      expect(new URL(request.url).pathname).toBe("/v1/chat/completions");
      expect(request.headers.get("authorization")).toBe("Bearer fixture-key");
      const body = (await request.json()) as Json;
      requests.push(body);
      return Response.json({
        choices: [
          {
            message:
              requests.length === 1
                ? {
                    role: "assistant",
                    content: "ツールを確認します。",
                    tool_calls: [
                      {
                        id: "settings-call",
                        type: "function",
                        function: {
                          name: "mcp__settings__get_bot_settings",
                          arguments: "{}",
                        },
                      },
                    ],
                  }
                : { role: "assistant", content: "Hibanaで応答しています。" },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
    },
  });
  try {
    const bot = new Hibana(
      loadConfig({
        HIBANA_DATA_DIR: dir,
        PROVIDER: "custom",
        LLM_BASE_URL: `http://127.0.0.1:${server.port}/v1`,
        LLM_API_KEY: "fixture-key",
        LLM_MODEL: "fixture",
        SANDBOX_ENABLED: "false",
        SKILLS_ENABLED: "false",
        LOG_DIR: "",
      }),
      pino({ enabled: false }),
    );
    bot.client.channels.fetch = (async () => ({
      id: context.channelId,
      isSendable: () => true,
      send: async (value: { content: string }) => {
        sent.push(value.content);
        const index = sent.length - 1;
        return {
          id: "40000",
          edit: async (next: { content: string }) => {
            sent[index] = next.content;
          },
        };
      },
      sendTyping: async () => {},
    })) as never;
    const text = await bot.respond("現在の設定を教えて", context);
    expect(text).toBe("Hibanaで応答しています。");
    expect(sent).toEqual(["ツールを確認します。", text]);
    expect(requests).toHaveLength(2);
    const tool = (requests[1]!.messages as Json[]).find(
      (m) => m.role === "tool",
    );
    expect(tool?.tool_call_id).toBe("settings-call");
    expect(JSON.parse(String(tool?.content)).selection.model).toBe("fixture");
    expect(bot.history.info(context.channelId).usage?.total_tokens).toBe(30);
    expect(await Bun.file(join(dir, "retry_checkpoints.json")).json()).toEqual(
      {},
    );
    expect(
      (requests[0]!.tools as { function: { name: string } }[]).some((t) =>
        /advisor|set_router/.test(t.function.name),
      ),
    ).toBe(false);
    await bot.close();
  } finally {
    server.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
});
test("bot patches the actual API contract and retired database fields never leak into snapshots", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hibana-api-e2e-"));
  const store = new MemoryStore();
  await store.migrate();
  const app = createApp(loadTestEnv(), store);
  const server = Bun.serve({ port: 0, fetch: (r) => app.handle(r) });
  try {
    const runtime = new Runtime(
      loadConfig({
        HIBANA_DATA_DIR: dir,
        WEB_API_URL: `http://127.0.0.1:${server.port}`,
        WEB_INTERNAL_TOKEN: "test-internal",
        CODEX_PLUS_API_KEY: "fixture",
      }),
    );
    await runtime.patch("10000", { preset: "sol", effort: "high" }, "20000");
    expect((await store.getGuild("10000")).selection?.model).toBe(
      "gpt-6.1-sol",
    );
    await runtime.setContext(undefined, "20000", {
      text: "personal",
      persona_override: true,
    });
    expect(runtime.resolve(undefined, "20000").context).toEqual({
      text: "personal",
      persona_override: true,
    });
    const removed = await fetch(
      `http://127.0.0.1:${server.port}/internal/guilds/10000`,
      {
        method: "PATCH",
        headers: {
          Authorization: "Bearer test-internal",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ advisor: "sol" }),
      },
    );
    expect(removed.status).toBe(400);
    await store.putGuild("legacy", {
      ...(await store.getGuild("10000")),
      advisor: "sol",
      router_enabled: true,
    } as never);
    const snapshot = (await runtime.remote("/internal/snapshot", "GET")) as {
      guilds: Record<string, Json>;
    };
    expect(snapshot.guilds.legacy?.advisor).toBeUndefined();
    expect(snapshot.guilds.legacy?.router_enabled).toBeUndefined();
  } finally {
    server.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
});

test("skill publication matches the API schema and inherits builtins without leaking host configuration", async () => {
  const { Skills } = await import("../tools/skills");
  const { skillRow, guildSkills } = await import("../../../api/src/skills");
  const { mkdir } = await import("node:fs/promises");
  const dir = await mkdtemp(join(tmpdir(), "hibana-skill-export-"));
  try {
    const builtin = join(dir, "builtin", "sample-skill");
    await mkdir(builtin, { recursive: true });
    await Bun.write(
      join(builtin, "SKILL.md"),
      "---\nname: sample-skill\ndescription: test skill\n---\nUse it.",
    );
    await Bun.write(join(builtin, "service.json"), "private host config");
    const skills = new Skills(
      loadConfig({ HIBANA_DATA_DIR: dir, SKILLS_DIR: join(dir, "builtin") }),
    );
    await skills.load();
    await skills.execute(
      "set_skill_enabled",
      { name: "sample-skill", enabled: false },
      { ...context, guildId: "10000" },
    );
    const rows = skillRow
      .array()
      .parse(await skills.export(["10000", "20000"]));
    expect(rows).toHaveLength(2);
    expect(guildSkills(rows, "10000")[0]?.enabled).toBe(false);
    expect(guildSkills(rows, "20000")[0]?.enabled).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("service.json");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

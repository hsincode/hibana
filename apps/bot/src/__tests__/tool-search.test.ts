import { expect, test } from "bun:test";
import { Client } from "discord.js";
import { Agent } from "../agent";
import { loadConfig } from "../config";
import { awaitsServerTool, LlmClient } from "../llm";
import { Runtime } from "../runtime";
import { LOADED_TOOLS, TOOL_SEARCH } from "../tool-search";
import { ToolRegistry } from "../tools";
import codex from "../tools/codex-definitions.json";
import definitions from "../tools/definitions.json";
import { requestUserInputTool } from "../tools/questions";
import type { Context, Json, Message, ToolDef } from "../types";
import { TASK_STOP_TOOL, WORKFLOW_TOOL } from "../workflow/prompts";

// Anthropic's tool search (#126): rarely used integration tools are sent with
// `defer_loading` and load when a search finds them.
const def = (name: string): ToolDef => ({
  type: "function",
  function: {
    name,
    description: `Tool ${name}`,
    parameters: { type: "object", properties: {} },
  },
});
const rare = Array.from({ length: 12 }, (_, i) =>
  def(`mcp__discord__rare_${i}`),
);
const surface = [
  def("shell_command"),
  def("tool_search"),
  def("mcp__workspace__send_file"),
  def("agents__spawn_agent"),
  ...rare,
];
const ctx: Context = {
  channelId: "1",
  userId: "2",
  botId: "3",
  thread: false,
  depth: 0,
  delivered: false,
};

function client(env: Record<string, string>, replies: Json[], bodies: Json[]) {
  return new LlmClient(loadConfig(env), async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({
      usage: { input_tokens: 1, output_tokens: 1 },
      ...(replies[bodies.length - 1] ?? {
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
      }),
    });
  });
}
const anthropic = { ANTHROPIC_API_KEY: "fixture" };
const hi: Message[] = [
  { role: "system", content: "Policy." },
  { role: "user", content: "Hi" },
];
const names = (body: Json) =>
  (body.tools as Json[]).map((t) => [t.name, t.defer_loading ?? false]);

test("Anthropic defers the rarely used integration tools and adds the search tool", async () => {
  const bodies: Json[] = [];
  await client(anthropic, [], bodies).complete(
    { provider: "anthropic", model: "claude-sonnet-5-5" },
    hi,
    surface,
  );
  expect(names(bodies[0]!)).toEqual([
    ["shell_command", false],
    ["mcp__workspace__send_file", false],
    ["agents__spawn_agent", false],
    ...rare.map((t) => [t.function.name, true]),
    [TOOL_SEARCH.name, false],
  ]);
  expect((bodies[0]!.tools as Json[]).at(-1)).toEqual(TOOL_SEARCH);
  // Hibana's own search only returned schemas already sent.
  expect(names(bodies[0]!).map(([n]) => n)).not.toContain("tool_search");
  // A deferred tool cannot carry a cache breakpoint (a 400).
  for (const t of bodies[0]!.tools as Json[])
    if (t.defer_loading) expect(t.cache_control).toBeUndefined();
  const system = (bodies[0]!.system as Json[])[0]!;
  expect(system.text).toStartWith("Policy.\n\n");
  expect(system.text).toContain(TOOL_SEARCH.name);
  expect(system.text).toContain("Discord");
  expect(system.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
});

test("tool search leaves every other request as it was", async () => {
  const plain = surface.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));
  for (const [env, selection] of [
    // Claude Max's gateway is not verified to pass server tools.
    [
      { CLAUDE_MAX_API_KEY: "fixture" },
      { provider: "claude_max", model: "claude-opus-5-5" },
    ],
    // Not in the documentation's model table.
    [anthropic, { provider: "anthropic", model: "claude-opus-5-6" }],
    [anthropic, { provider: "anthropic", model: "claude-opus-4-1" }],
  ] as const) {
    const bodies: Json[] = [];
    await client(env, [], bodies).complete(selection, hi, surface);
    expect(bodies[0]!.tools).toEqual(plain);
    expect((bodies[0]!.system as Json[])[0]!.text).toBe("Policy.");
  }
  // Fewer than ten tools to defer: a search would cost more than it saves.
  const bodies: Json[] = [];
  const few = surface.slice(0, 8);
  await client(anthropic, [], bodies).complete(
    { provider: "anthropic", model: "claude-haiku-5-5" },
    hi,
    few,
  );
  expect(names(bodies[0]!)).toEqual(few.map((t) => [t.function.name, false]));
  // Chat Completions providers get the plain list.
  const chat: Json[] = [];
  await new LlmClient(
    loadConfig({ REFUSELESS_API_KEY: "fixture" }),
    async (_url, init) => {
      chat.push(JSON.parse(String(init?.body)));
      return Response.json({
        choices: [{ message: { role: "assistant", content: "ok" } }],
      });
    },
  ).complete(
    { provider: "refuseless", model: "glm-5.3-abliterated" },
    hi,
    surface,
  );
  expect(chat[0]!.tools).toEqual(surface);
});

test("the search blocks go back unchanged and only the client call gets a result", async () => {
  const searched = [
    {
      type: "server_tool_use",
      id: "srvtoolu_1",
      name: TOOL_SEARCH.name,
      input: { query: "discord rare" },
    },
    {
      type: "tool_search_tool_result",
      tool_use_id: "srvtoolu_1",
      content: {
        type: "tool_search_tool_search_result",
        tool_references: [
          { type: "tool_reference", tool_name: "mcp__discord__rare_3" },
        ],
      },
    },
    {
      type: "tool_use",
      id: "toolu_1",
      name: "mcp__discord__rare_3",
      input: {},
    },
  ];
  const bodies: Json[] = [];
  const executed: string[] = [];
  const result = await new Agent(
    client(
      anthropic,
      [
        { content: searched, stop_reason: "tool_use" },
        {
          content: [{ type: "text", text: "Done." }],
          stop_reason: "end_turn",
        },
      ],
      bodies,
    ),
  ).run({
    selection: { provider: "anthropic", model: "claude-opus-5-5" },
    messages: hi,
    tools: surface,
    context: { ...ctx },
    maxRounds: 4,
    temperature: 0,
    nativeSearch: false,
    execute: async (name) => {
      executed.push(name);
      return { ok: true };
    },
  });
  expect(result.text).toBe("Done.");
  expect(executed).toEqual(["mcp__discord__rare_3"]);
  const turns = bodies[1]!.messages as Json[];
  expect(turns.at(-2)).toEqual({ role: "assistant", content: searched });
  const results = (turns.at(-1)!.content as Json[]).map((b) => [
    b.type,
    b.tool_use_id,
  ]);
  expect(results).toEqual([["tool_result", "toolu_1"]]);
  // The same tools on every request of the turn: the prefix stays cached.
  expect(bodies[1]!.tools).toEqual(bodies[0]!.tools);
  expect(bodies[1]!.system).toEqual(bodies[0]!.system);
  // The search ran in the same response, so nothing waits for it.
  expect(
    awaitsServerTool({
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "toolu_1",
          type: "function",
          function: { name: "mcp__discord__rare_3", arguments: "{}" },
        },
      ],
      providerBlocks: searched,
    }),
  ).toBe(false);
});

test("the tools kept loaded exist under these names", () => {
  const known = new Set([
    ...[...definitions, ...codex].map((t) => t.function.name),
    requestUserInputTool.function.name,
    "run_jev_task",
    WORKFLOW_TOOL,
    TASK_STOP_TOOL,
  ]);
  for (const name of LOADED_TOOLS) expect(known).toContain(name);
});

test("the bot's own surface on Anthropic defers most integration tools", () => {
  const runtime = new Runtime(
    loadConfig({
      RUNTIME_STATE_PATH: "",
      SANDBOX_ENABLED: "false",
      SKILLS_ENABLED: "true",
      PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "fixture",
      LLM_MODEL: "claude-sonnet-5-5",
    }),
  );
  const registry = new ToolRegistry(
    runtime,
    new Client({ intents: [] }),
    new Agent(new LlmClient(runtime.config)),
  );
  const tools = registry.tools({ ...ctx, guildId: "9" });
  const bare = tools.map((t) => t.function.name.replace(/^mcp__[^_]+__/, ""));
  expect(bare).toContain("read_messages");
  expect(bare).toContain("use_skill");
  const deferrable = tools.filter(
    (t) =>
      t.function.name.startsWith("mcp__") &&
      !LOADED_TOOLS.has(t.function.name.replace(/^mcp__[^_]+__/, "")),
  );
  expect(deferrable.length).toBeGreaterThan(tools.length / 2);
});

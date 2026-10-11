import { expect, test } from "bun:test";
import { Client } from "discord.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { MODEL_PRESETS } from "@hibana/shared/catalog";
import { emptyUserOverride, SUBAGENT_MODES, subagentModePatch } from "@hibana/shared/settings";
import { Agent } from "../agent";
import { loadConfig, type Selection } from "../config";
import { assemblePrompt } from "../harness";
import { LlmClient } from "../llm";
import { Runtime } from "../runtime";
import { ToolRegistry } from "../tools";
import type { Context, Json, Message, ToolDef } from "../types";

// The providers other than `anthropic` are deprecated and stay on the current
// harness unchanged (#67). These tests fix what "unchanged" means: the files
// the harness is built from, the prompt and tool surface it assembles, and the
// request each provider receives. A failure here is not a bug by itself. It
// says a change reached the frozen side; update the expected value in the same
// pull request only when #67 allows that change, and say so in the PR.

const sha256 = (value: string | Uint8Array) => new Bun.CryptoHasher("sha256").update(value).digest("hex");
const root = join(import.meta.dir, "../..");

const FROZEN_FILES: Record<string, string> = {
  "prompts/harness/codex.md": "9eaa7c2b38e14122d56cb65e0c2c7b1e5c74ddf41cd0658985de1b6fb2cb384f",
  "prompt.md": "aa0352a1a2240d44cca492277f2a746e89a3c4ad46ff98457a0fd6f43aa07449",
  "src/tools/definitions.json": "978fe1d3ed3a197e8083257e9fcf495da9ced4357dbf0a59e143e69362ab63de",
  "src/tools/codex-definitions.json": "018ab798d227e535c692105f9aa7327fa50ca9bb5e54b902cf21028f892aef40",
};

test("the files the frozen harness is built from are unchanged", async () => {
  const actual: Record<string, string> = {};
  for (const path of Object.keys(FROZEN_FILES)) actual[path] = sha256(await readFile(join(root, path)));
  expect(actual).toEqual(FROZEN_FILES);
});

const config = (env: NodeJS.ProcessEnv = {}) =>
  loadConfig({
    PROVIDER: "codex_plus",
    LLM_MODEL: "gpt-6-luna",
    CODEX_PLUS_API_KEY: "fixture",
    ANTHROPIC_API_KEY: "fixture",
    // `anthropic` runs on the Claude harness by default (#66). This is the
    // setting that puts it back on the frozen one.
    ANTHROPIC_HARNESS: "codex",
    JEV_API_KEY: "fixture",
    SANDBOX_ENABLED: "false",
    SKILLS_ENABLED: "false",
    RUNTIME_STATE_PATH: "",
    // The defaults resolve against the working directory, which differs
    // between `make test` and a run inside apps/bot.
    PROMPT_FILE: join(root, "prompt.md"),
    PERSONA_FILE: join(root, "persona.does-not-exist.md"),
    // The default comes from the CPU count of the machine running the test.
    WORKFLOW_MAX_CONCURRENT_AGENTS: "8",
    ...env,
  });
const context = (): Context => ({
  guildId: "g1", channelId: "c1", userId: "u1", botId: "bot", thread: false, depth: 0, delivered: false,
});

/** Stores a value once and returns a short reference to it. Most surfaces and
 *  requests share the same tool list or rendered conversation; writing each
 *  one out in full made the snapshot 200 kB of repeats. */
function references() {
  const parts: Record<string, unknown> = {};
  return {
    parts,
    ref: (value: unknown) => {
      const id = `#${sha256(JSON.stringify(value)).slice(0, 12)}`;
      parts[id] = value;
      return id;
    },
  };
}
// Hashes keep the snapshot small: the system prompt and the tool definitions
// together are about 100 kB. The frozen files above show what changed.
const promptShape = (messages: Message[]) =>
  messages.map((m) => ({ role: m.role, bytes: Buffer.byteLength(m.content ?? ""), sha256: sha256(m.content ?? "") }));

test("the harness assembles the same prompt and tool surface for every subagent mode", async () => {
  const runtime = new Runtime(config());
  const client = new Client({ intents: [] });
  const registry = new ToolRegistry(runtime, client, new Agent(new LlmClient(runtime.config)));
  registry.sandbox.available = true;
  const ctx = { ...context(), team: {} as Context["team"] };
  runtime.snapshot.user_roles[ctx.userId] = "administrator";
  try {
    const surfaces: Record<string, unknown> = {};
    const { parts, ref } = references();
    // Anthropic is listed too: with ANTHROPIC_HARNESS=codex its turns go back
    // to this harness, without subagents (#35), and must find it unchanged.
    for (const selection of [
      { provider: "codex_plus", model: "gpt-6-luna" },
      { provider: "claude_max", model: "claude-opus-5-5" },
      { provider: "anthropic", model: "claude-opus-5-5" },
    ])
      for (const mode of SUBAGENT_MODES) {
        runtime.snapshot.user_overrides[ctx.userId] = {
          ...emptyUserOverride(),
          selection: { ...selection, effort: "high" },
          effort: "high",
          ...subagentModePatch(mode),
        };
        const tools = registry.tools(ctx);
        surfaces[`${selection.provider} ${mode}`] = {
          prompt: ref(promptShape(await assemblePrompt(runtime, ctx, "- example-skill: An example."))),
          tool_names: ref(tools.map((t) => t.function.name)),
          tools_sha256: sha256(JSON.stringify(tools)),
        };
      }
    expect({ surfaces, parts }).toMatchSnapshot();
  } finally { await registry.close(); client.destroy(); }
});

const tool: ToolDef = {
  type: "function",
  function: {
    name: "lookup",
    description: "Find a record",
    parameters: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
  },
};
// One conversation with every kind of message the loop produces: the prompt
// prefix, a user turn with an image, a tool round, a late developer note and
// an internal continuation.
const conversation: Message[] = [
  { role: "system", content: "System text." },
  { role: "developer", content: "<multi_agent_mode>Policy.</multi_agent_mode>" },
  { role: "user", content: "# AGENTS.md instructions\n<INSTRUCTIONS>\nRules.\n</INSTRUCTIONS>" },
  { role: "user", content: "質問です", turnStart: true, images: ["https://example.com/a.png"] },
  {
    role: "assistant", content: "調べます", reasoning_content: "Thinking.",
    tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: '{"key":"x"}' } }],
  },
  { role: "tool", tool_call_id: "call_1", content: '{"ok":true}' },
  { role: "developer", content: "Late note.", sticky: true },
  { role: "user", content: "Continue.", internal: true },
];

type Sent = { url: string; headers: Record<string, string>; body: Json };

/** Sends the conversation and returns the model request as it left the client.
 *  The fake provider answers 400, which is not retried, so one call is one request. */
async function requestFor(selection: Selection, options: Parameters<LlmClient["complete"]>[3] = {}): Promise<Sent> {
  const sent: Sent[] = [];
  const env: NodeJS.ProcessEnv = {
    PROVIDER: "custom", LLM_BASE_URL: "https://custom.example/v1", LLM_API_KEY: "fixture", LLM_MODEL: "test-model",
    WEB_API_URL: "https://api.example", WEB_INTERNAL_TOKEN: "fixture",
  };
  for (const provider of new Set(["openai", "xai", "openrouter", "orca_router", ...MODEL_PRESETS.map((p) => p.provider)]))
    env[`${provider.toUpperCase()}_API_KEY`] = "fixture";
  const client = new LlmClient(loadConfig(env), async (url, init) => {
    if (url.endsWith("/internal/chatgpt/credential"))
      return Response.json({ access_token: "fixture", account_id: "account" });
    const headers = Object.fromEntries(Object.entries(init?.headers as Record<string, string>)
      // Keys are fixtures, but a snapshot should not look like it holds one.
      .map(([name, value]) => [name, /^(authorization|x-api-key)$/i.test(name) ? value.replace(/fixture/g, "<key>") : value]));
    sent.push({ url, headers, body: JSON.parse(String(init?.body)) });
    return new Response("{}", { status: 400 });
  });
  await client.complete(selection, structuredClone(conversation), [tool], {
    temperature: 0.7, trace: { channel: "c1", agent: "root", round: 0 }, ...options,
  }).catch(() => {});
  if (sent.length !== 1) throw new Error(`Expected one request for ${selection.provider}, saw ${sent.length}`);
  return sent[0]!;
}

test("every deprecated provider receives the same request as before", async () => {
  const selections: Selection[] = [
    ...MODEL_PRESETS.filter((p) => p.provider !== "anthropic").map((p) => ({ provider: p.provider, model: p.model })),
    // Providers that are configured by environment only and have no preset.
    { provider: "openai", model: "gpt-4o-mini" },
    { provider: "openai", model: "gpt-6-luna" },
    { provider: "xai", model: "grok-3-mini" },
    { provider: "openrouter", model: "vendor/model" },
    { provider: "orca_router", model: "obsidian/Qwen3.8-27B" },
    { provider: "custom", model: "test-model" },
  ];
  const { parts, ref } = references();
  // The rendered conversation and tool list are the long parts of a body and
  // only differ by wire protocol, so each distinct rendering is stored once.
  const compact = ({ url, headers, body }: Sent) => ({
    url, headers,
    body: Object.fromEntries(Object.entries(body).map(([key, value]) =>
      [key, ["messages", "input", "instructions", "system", "tools"].includes(key) ? ref(value) : value])),
  });
  const requests: Record<string, unknown> = {};
  for (const selection of selections)
    for (const effort of ["none", "high"])
      requests[`${selection.provider} ${selection.model} ${effort}`] = compact(await requestFor({ ...selection, effort }));
  // Request fields that only some providers get.
  requests["deepseek deepseek-flash native search"] =
    compact(await requestFor({ provider: "deepseek", model: "deepseek-flash", effort: "high" }, { nativeSearch: true }));
  for (const provider of ["codex_plus", "chatgpt", "claude_max", "deepseek"]) {
    const model = MODEL_PRESETS.find((p) => p.provider === provider)!.model;
    requests[`${provider} ${model} priority tier`] =
      compact(await requestFor({ provider, model, effort: "high" }, { serviceTier: "priority" }));
  }
  expect({ requests, parts }).toMatchSnapshot();
});

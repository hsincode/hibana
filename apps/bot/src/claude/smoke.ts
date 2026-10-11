// Manual check of the Claude harness against the real Anthropic API (#66):
//   cd apps/bot && bun run claude-smoke            Haiku 5.5
//   cd apps/bot && bun run claude-smoke --opus     also Opus 5.5 (thinking notes)
// It needs ANTHROPIC_API_KEY and sends about a dozen small requests, which are
// billed, so it is not part of `make ci`. It prints what each step observed and
// the tokens it used; message text is not printed. Tools are not executed:
// their results are supplied here, so no sandbox or Discord access is needed.
import { anthropicCost } from "@hibana/shared/catalog";
import { Agent, type AgentOptions } from "../agent";
import { loadConfig, type Selection } from "../config";
import { LlmClient, type RequestRecord } from "../llm";
import { Runtime } from "../runtime";
import definitions from "../tools/definitions.json";
import { ToolOutput, type Context, type Message, type ToolDef } from "../types";
import { claudeSystem, contextBlock, contextMessage } from "./prompt";
import { claudeSurface } from "./tools";

const MAX_REQUESTS = 40;
const config = loadConfig({ ...process.env, RUNTIME_STATE_PATH: "", LOG_DIR: "" });
if (!config.endpoints.anthropic?.apiKey) throw new Error("ANTHROPIC_API_KEY is required");
const runtime = new Runtime(config);
const records: RequestRecord[] = [];
const dropped: string[] = [];
const client = new LlmClient(config, fetch, {
  // The budget is checked before each turn below; a hook must not throw.
  onCompletion: (record) => { records.push(record); },
  onFeatureDisabled: (feature) => dropped.push(feature),
});
// The surface a server administrator's turn gets, with the sandbox present.
const tools: ToolDef[] = claudeSurface(definitions as ToolDef[], { sandbox: true, root: true, agents: true });
const ctx: Context = { channelId: "1", userId: "2", botId: "3", thread: false, depth: 0, delivered: false, harness: "claude" };
const system = await claudeSystem(runtime);
const block = contextMessage(await contextBlock(runtime, ctx, ""), [])!;

type Step = { name: string; ok: boolean; detail: string };
const steps: Step[] = [];
const step = (name: string, ok: boolean, detail: string) => {
  steps.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${detail}`);
};
const user = (content: string): Message => ({ role: "user", content: `${content}\n[date: ${new Date().toISOString().slice(0, 10)}]`, turnStart: true });

async function turn(selection: Selection, messages: Message[], execute: AgentOptions["execute"]) {
  if (records.length >= MAX_REQUESTS) throw new Error("request budget exceeded");
  const called: string[] = [];
  const result = await new Agent(client).run({
    selection, messages, tools, context: { ...ctx }, maxRounds: 8, temperature: 1, nativeSearch: false,
    execute: (name, args, c) => { called.push(name); return execute(name, args, c); },
  });
  return { ...result, called };
}

async function check(selection: Selection) {
  const label = selection.model.replace("claude-", "");
  const from = records.length;
  // 1. A reply, and the second request reading the first one's prefix from cache.
  const first = await turn(selection, [system, block, user("Reply with the single word: ready")], async () => null);
  step(`${label} reply`, first.text.length > 0, `${first.text.length} characters`);
  const second = await turn(selection, [...first.messages, user("Reply with the single word: again")], async () => null);
  const cached = records.at(-1)!.usage.cached_tokens;
  step(`${label} prompt cache`, cached > 0, `${cached} of ${records.at(-1)!.usage.prompt_tokens} input tokens read from cache`);

  // 2. A tool round: the call, a plain-text result, and the replay of both.
  const read = await turn(selection, [...second.messages, user("Read the file notes.txt in the workspace and tell me the number it contains.")],
    async (name) => (name === "Read" ? new ToolOutput("     1\tThe number is 42.") : new ToolOutput("unexpected tool", { isError: true })));
  step(`${label} tool round`, read.called.includes("Read") && read.text.includes("42"), `called ${read.called.join(", ") || "nothing"}`);

  // 3. A failed result is accepted and acted on.
  const failed = await turn(selection, [...read.messages, user("Now read missing.txt and tell me what happened.")],
    async () => { throw new Error("No such file: missing.txt"); });
  step(`${label} failed tool result`, failed.text.length > 0 && failed.called.length > 0, `called ${failed.called.join(", ") || "nothing"}, then replied`);

  // 4. Tool search: a tool that is not loaded up front is found and called.
  const pin = await turn(selection, [...failed.messages, user("Pin the message with id 123 in channel 456 of this server. Find the tool for it.")],
    async (name) => (name.includes("pin_message") ? { ok: true } : new ToolOutput("not the tool that pins a message", { isError: true })));
  const searched = JSON.stringify(pin.messages).includes("tool_search_tool_result");
  step(`${label} tool search`, pin.called.some((n) => n.includes("pin_message")),
    `${searched ? "searched" : "did not search"}, called ${pin.called.join(", ") || "nothing"}${dropped.includes("tool_search") ? " (tool search was rejected and is off)" : ""}`);

  // 5. The API's summary, and the conversation continuing from it.
  const history = pin.messages.filter((m) => m.role !== "system");
  const summary = await client.complete(selection, [system, ...history], tools, { claude: true, compaction: true, trace: { channel: "1", agent: "compaction", round: 0 } });
  step(`${label} summary`, summary.compacted === true, summary.compacted ? `${summary.usage.completion_tokens} output tokens` : "the API returned no summary block");
  if (summary.compacted) {
    const after = await turn(selection,
      [system, { role: "assistant", content: "", providerBlocks: summary.message.providerBlocks }, block, user("Which number did the file notes.txt contain? Answer with the number only.")],
      async () => new ToolOutput("     1\tThe number is 42."));
    step(`${label} continue from summary`, after.text.includes("42"), after.called.length ? `re-read the file (${after.called.join(", ")})` : "answered from the summary");
  }
  const mine = records.slice(from);
  const sum = (pick: (r: RequestRecord) => number) => mine.reduce((total, r) => total + pick(r), 0);
  const cost = mine.reduce((total, r) => total + (anthropicCost(r.model, {
    prompt: r.usage.prompt_tokens, cache_read: r.usage.cached_tokens, cache_write: r.usage.cache_write_tokens ?? 0, output: r.usage.completion_tokens,
  }) ?? 0), 0);
  console.log(`      ${label}: ${mine.length} requests, ${sum((r) => r.usage.prompt_tokens)} input tokens (${sum((r) => r.usage.cached_tokens)} from cache), ${sum((r) => r.usage.completion_tokens)} output tokens, about $${cost.toFixed(4)}`);
}

try {
  await check({ provider: "anthropic", model: "claude-haiku-5-5", effort: "medium" });
  if (process.argv.includes("--opus")) {
    await check({ provider: "anthropic", model: "claude-opus-5-5", effort: "medium" });
    step("opus-5-5 thinking notes", !dropped.includes("thinking_updates"), dropped.includes("thinking_updates") ? "display: updates was rejected and is off" : "display: updates was accepted");
  }
} catch (error) {
  step("run", false, error instanceof Error ? error.message : String(error));
}
if (dropped.length) console.log(`Features Anthropic rejected: ${[...new Set(dropped)].join(", ")}`);
const failures = steps.filter((s) => !s.ok).length;
console.log(`${steps.length - failures}/${steps.length} steps passed`);
process.exit(failures ? 1 : 0);

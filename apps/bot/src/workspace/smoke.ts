// Manual check of the Anthropic Workspace path against the real Managed Agents
// API (#76):
//   cd apps/bot && bun run workspace-smoke               Haiku 5.5, a plain session
//   cd apps/bot && bun run workspace-smoke --ultra       also a Haiku Ultra session (workflow runs)
//   cd apps/bot && bun run workspace-smoke --bot         also turns of the bot itself, with its tools run by its registry
//   cd apps/bot && bun run workspace-smoke --bot-only    those turns alone (with --ultra: and one of them on Haiku Ultra)
//   cd apps/bot && bun run workspace-smoke --budget 0.5  each session's budget in US dollars (default 1)
//   cd apps/bot && bun run workspace-smoke --keep        leave what it created (sessions are still brought to rest)
//   cd apps/bot && bun run workspace-smoke --cleanup     only remove what earlier runs left behind
// It needs ANTHROPIC_WORKSPACE_API_KEY and is billed: model tokens, the time
// the sessions run, and web searches. So it is not part of `make ci`, and
// running it needs the owner's approval first (#76). A session is created
// with the budget given, and before every turn the script reads from the
// session what it has used, so a turn is allowed at most what is left of that
// budget. The bot's own turns are held to the same amount by the bot's own
// limits: `--budget` is what its turns may add in a day. So a run can spend
// up to `--budget` once for every part it runs. The whole run stops after 15
// minutes.
//
// It prints what each step observed and what the sessions used. Message text
// is not printed, and of an error only its status, its codes and the field
// names its message mentions. In the first two parts custom tools are not
// executed: their results are supplied here.
//
// The part of `--bot` is a turn as the bot runs it (`Hibana.respond`): its
// session table, its limits, its prompt and its tool list, on Haiku 5.5 at
// effort medium, and every custom tool call run by the bot's registry with
// its checks. Discord is answered from memory there: the bot's Discord client
// is never logged in, its REST calls are kept in a list instead of being
// sent, and while that part runs anything else that asks for the network is
// refused. Of a tool call the registry refused, its reason is printed. With
// `--ultra` that part ends with a turn on Haiku Ultra: Ultra is stored the way
// the dashboard stores it, and the agents of the workflow run call the bot's
// tools, which the registry runs for them as workers.
//
// Nothing of the bot's is touched. The data directory is a temporary one. The
// environment, the agents and the sessions are created by the bot's own
// `WorkspaceResources`, so its lookup by name, its create requests and its
// check of a new session all meet the real API here, but under names that
// start with `hibana-smoke` and with `metadata.app = "hibana-smoke"`: the
// bot's own are never adopted, and nothing without that label is removed.
// What a run that died left behind is found by the label with `--cleanup`.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { deflateSync } from "node:zlib";
import { APIError } from "@anthropic-ai/sdk";
import type { BetaFileMetadata } from "@anthropic-ai/sdk/resources/beta/files";
import type { BetaManagedAgentsSession } from "@anthropic-ai/sdk/resources/beta/sessions/sessions";
import { WORKSPACE_PROVIDER, WORKSPACE_ULTRA_MODEL } from "@hibana/shared/catalog";
import pino from "pino";
import { Hibana } from "../bot";
import { loadConfig, type Selection } from "../config";
import { sleep } from "../io";
import { httpFailure, ProviderError } from "../llm-errors";
import { Runtime } from "../runtime";
import definitions from "../tools/definitions.json";
import { ToolOutput, type Context, type Json, type ToolDef } from "../types";
import { apiErrorInfo, createWorkspaceClient, workspaceBaseUrl } from "./client";
import { openRunsNote, userContent, workspaceContextBlock, workspaceSystem } from "./prompt";
import { budgetLimit, cents, multiagentMismatch, ULTRA_MULTIAGENT, WorkspaceResources } from "./resources";
import { budgetNotRaised, quiesce, runTurn, type TurnResult } from "./runner";
import type { WorkspaceVariant } from "./select";
import { outputFiles, pickOutput, WORKSPACE_OUTPUTS, workspaceSurface, workspaceToolParams } from "./tools";
import type { RawEvent, WorkspaceCall, WorkspaceResult } from "./types";
import { sessionTotals, totalsMax, type WorkspaceTotals } from "./usage";

const APP = "hibana-smoke";
// The default model here, and the only one Haiku Ultra runs on.
const MODEL = WORKSPACE_ULTRA_MODEL;
const RUN_LIMIT_MS = 15 * 60_000;
const TURN_MS = 3 * 60_000;
const WORKFLOW_TURN_MS = 6 * 60_000;
// What a turn that starts a workflow run may add to its session, in cents.
const WORKFLOW_TURN_CENTS = 40;
// What an ordinary step may add to its session, in cents. Every turn is also
// held to what is left of the session's budget.
const TURN_CENTS = 20;
// How long the interrupted command is left running first, to see what the
// stream carries while nothing happens.
const QUIET_MS = 20_000;

const argv = process.argv.slice(2);
function usage(problem: string): never {
  console.error(`${problem}\nusage: bun run workspace-smoke [--ultra] [--bot | --bot-only] [--budget <usd>] [--keep]\n       bun run workspace-smoke --cleanup`);
  process.exit(2);
}
// Checked strictly: a mistyped option must not start a billed run.
for (let i = 0; i < argv.length; i++) {
  if (!["--ultra", "--bot", "--bot-only", "--budget", "--keep", "--cleanup"].includes(argv[i]!)) usage(`unknown argument: ${argv[i]}`);
  if (argv[i] === "--budget") i++;
}
const option = (name: string) => argv.includes(name);
if (option("--cleanup") && argv.length > 1) usage("--cleanup takes no other option");
if (option("--bot-only") && option("--bot")) usage("--bot-only runs the bot's turns alone");
const budgetUsd = option("--budget") ? Number(argv[argv.indexOf("--budget") + 1]) : 1;
if (!(budgetUsd >= 0.2 && budgetUsd <= 10)) usage("--budget takes US dollars between 0.2 and 10");
const budgetCents = Math.round(budgetUsd * 100);
const keep = option("--keep");

// A data directory of its own: no path derived from it is the bot's.
const dataDir = await mkdtemp(join(tmpdir(), `${APP}-`));
const config = loadConfig({ ...process.env, HIBANA_DATA_DIR: dataDir, RUNTIME_STATE_PATH: "", CONVERSATION_DB_PATH: "", LOG_DIR: "" });
if (!config.endpoints[WORKSPACE_PROVIDER]?.apiKey) {
  await rm(dataDir, { recursive: true, force: true });
  usage("ANTHROPIC_WORKSPACE_API_KEY is required");
}
const runtime = new Runtime(config);
// The runner's warnings (a budget that could not be lowered, a result that
// was refused) belong next to the steps. They carry ids and statuses only.
const log = pino({ level: "warn" });
const deadline = Date.now() + RUN_LIMIT_MS;
// Ctrl-C ends the turn in progress the way a shutdown does; the cleanup
// below still runs.
const stop = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => stop.abort(new Error("Shutdown")));
const abortable = { signal: stop.signal };

const bump = (counts: Map<string, number>, key: string) => counts.set(key, (counts.get(key) ?? 0) + 1);
// What went over the wire: the requests, and for the event stream its frames
// by SSE event name, its comment lines and its longest silence. The real API
// names every frame `message` and has the event's type in the data alone, so
// the events are told apart by their data (`events`), never by the name.
// `echoes`: the `user.message` frames, by whether they carry a `processed_at`.
// The runner never passes a turn's own message on, so they are counted here.
// `tools`: the built-in tool calls of the primary thread, by name, and
// `results`: the custom tool results that were sent, with whether the API
// took them. The bot's own turns hand this script no event, so its part reads
// both from here.
const wire = {
  requests: 0, frames: new Map<string, number>(), comments: 0, last: Date.now(), silence: 0,
  echoes: { queued: 0, processed: 0 },
  events: new Map<string, number>(),
  tools: [] as string[], results: [] as { error: boolean; accepted: boolean }[],
  /** How often the event stream was opened. */
  streams: 0,
};
function watchStream(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  let rest = "";
  wire.last = Date.now();
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      wire.silence = Math.max(wire.silence, Date.now() - wire.last);
      wire.last = Date.now();
      const lines = (rest + decoder.decode(chunk, { stream: true })).split(/\r?\n/);
      rest = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith(":")) wire.comments++;
        else if (line.startsWith("event:")) bump(wire.frames, line.slice(6).trim().slice(0, 48));
        else if (line.startsWith("data:")) {
          let event: RawEvent | undefined;
          try {
            event = JSON.parse(line.slice(5)) as RawEvent;
          } catch {}
          if (typeof event?.type !== "string") continue;
          bump(wire.events, event.type.slice(0, 48));
          if (event.type === "user.message") wire.echoes[event.processed_at ? "processed" : "queued"]++;
          if (event.type === "agent.tool_use" && !event.session_thread_id && typeof event.name === "string") wire.tools.push(event.name);
        }
      }
      controller.enqueue(chunk);
    },
  }));
}
// The bot's own classes report an API error as a fixed classification, which
// has no place for the field names the error's message mentions. The last
// refusal is kept as it came over the wire, so `describe` can still name them.
let refused: { status: number; fields: string } | undefined;
// The network as the process found it. The bot's part swaps the global
// `fetch` for one that refuses (`bot`); the API client keeps this one.
const network = fetch;
const counted = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  wire.requests++;
  const response = await network(input, init);
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (init?.method === "POST" && typeof init.body === "string" && new URL(url).pathname.endsWith("/events")) {
    try {
      for (const event of (JSON.parse(init.body) as { events?: RawEvent[] }).events ?? [])
        if (event.type === "user.custom_tool_result") wire.results.push({ error: !!event.is_error, accepted: response.ok });
    } catch {}
  }
  if (!response.ok) {
    const body = await response.clone().json().catch(() => undefined) as { error?: { message?: unknown } } | undefined;
    refused = { status: response.status, fields: mentioned(typeof body?.error?.message === "string" ? body.error.message : "") };
  }
  if (!response.ok || !response.body || !new URL(url).pathname.endsWith("/events/stream")) return response;
  wire.streams++;
  return new Response(watchStream(response.body), { status: response.status, statusText: response.statusText, headers: response.headers });
}) as unknown as typeof fetch;
const client = createWorkspaceClient(config, { fetch: counted });
const files = outputFiles(client);

const selection: Selection = { provider: WORKSPACE_PROVIDER, model: MODEL, effort: "medium" };
const ctx: Context = { channelId: "1", userId: "2", botId: "3", thread: false, depth: 0, delivered: false, harness: "workspace" };
// The deployment's own switches, so the sessions are what the bot would create.
const web = config.webSearch && config.anthropicWorkspace.web;
const networking = config.anthropicWorkspace.networking === "limited"
  ? { type: "limited" as const, allowed_hosts: config.anthropicWorkspace.allowedHosts, allow_package_managers: true }
  : { type: "unrestricted" as const };
// The bot's tool list at its fullest, with every integration switched on.
// Creating a session with it shows whether the API takes all of it: three
// schemas nest `anyOf`, `oneOf` or `minProperties` (run_jev, set_bot_model,
// search_messages) and two names start with `mcp_`.
const tools = workspaceToolParams(workspaceSurface(definitions as ToolDef[]), { web });
const customTools = tools.filter((tool) => tool.type === "custom").length;

// Names this run's resources and files. The codes are what the steps look for
// in a reply or a file, so that nothing has to be printed to check it.
const RUN = Date.now().toString(36);
// The bot's own class under this run's names and the script's label. Its file
// is in the temporary data directory, so no id of the bot's is ever read.
const resourcesPath = join(dataDir, "anthropic_workspace_resources.json");
const newStore = () => new WorkspaceResources(client, {
  path: resourcesPath,
  baseUrl: workspaceBaseUrl(config.endpoints[WORKSPACE_PROVIDER]!.baseUrl),
  networking, log,
  identity: { prefix: `${APP}-${RUN}`, app: APP },
});
let store = newStore();
const code = () => crypto.randomUUID().slice(0, 8).toUpperCase();
const codes = { memory: code(), file: code(), late: code(), tool: code(), again: code(), echo: code(), reopened: code() };
const TOP = `smoke-${RUN}.txt`, SUB = `smoke-${RUN}/facts.txt`, LATE = `smoke-${RUN}-late.txt`;
const out = (rel: string) => `${WORKSPACE_OUTPUTS}${rel}`;

type Step = { name: string; ok: boolean; detail: string };
const steps: Step[] = [];
const step = (name: string, ok: boolean, detail: string) => {
  steps.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${detail}`);
};
// Something the documentation leaves open and no step depends on: reported,
// not judged.
const note = (name: string, detail: string) => console.log(`INFO  ${name}: ${detail}`);
const usd = (amount: number) => `$${(amount / 100).toFixed(2)}`;
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const printable = (value: unknown, max = 96) => String(value ?? "").replace(/[^\x20-\x7e]/g, "?").slice(0, max);
const word = (value: unknown) => (typeof value === "string" && /^[\w.:-]{1,96}$/.test(value) ? value : undefined);
const tally = (counts: Map<string, number>) => [...counts].map(([key, n]) => `${printable(key, 48)} x${n}`).join(", ") || "none";
/** The field names a provider's message mentions (`budget.max_list_cost`,
 *  `tools.3.input_schema`). They tell one rejection from another without the
 *  sentence itself, which is never printed (llm-errors.ts). */
const mentioned = (message: string) =>
  [...new Set(message.match(/[A-Za-z]\w*(?:[._]\w+)+/g) ?? [])].slice(0, 8).map((name) => name.slice(0, 64)).join(" ");
function describe(error: unknown): string {
  if (error instanceof ProviderError)
    return [
      `provider error: ${error.kind}`, error.status && `HTTP ${error.status}`, error.diagnostics.code, error.diagnostics.reason,
      error.status && refused?.status === error.status && refused.fields && `mentions ${refused.fields}`,
    ].filter(Boolean).join(", ");
  if (error instanceof APIError) {
    const info = apiErrorInfo(error), fields = mentioned(info.message);
    return [info.status ? `HTTP ${info.status}` : "no response", word(info.type), word(info.code), fields && `mentions ${fields}`]
      .filter(Boolean).join(", ");
  }
  return error instanceof Error ? error.message : String(error);
}
/** Runs one step's body. A failure is that step's and the next one still
 *  runs; a signal ends the run. */
async function attempt<T>(name: string, run: () => Promise<T>): Promise<T | undefined> {
  if (stop.signal.aborted) throw stop.signal.reason;
  if (Date.now() >= deadline) return void step(name, false, "not run: the 15 minute limit was reached");
  try {
    return await run();
  } catch (error) {
    if (stop.signal.aborted) throw stop.signal.reason;
    step(name, false, describe(error));
  }
}

// A solid-colour PNG, so that the image step has a known answer (as in
// claude/smoke.ts).
function png(r: number, g: number, b: number, size = 64): string {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const framed = Buffer.alloc(12 + data.length);
    framed.writeUInt32BE(data.length, 0);
    body.copy(framed, 4);
    framed.writeUInt32BE(Number(Bun.hash.crc32(body)) >>> 0, 8 + data.length);
    return framed;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3).map((_, i) => [r, g, b][i % 3]!)]);
  const file = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.concat(Array<Buffer>(size).fill(row)))), chunk("IEND", Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${file.toString("base64")}`;
}

// ── What the script creates ───────────────────────────────────────────────

// Recorded and printed as soon as the bot's class, or a create of this
// script's own, returns it. What was created without an answer reaching the
// script is found by its label with `--cleanup`.
const made = { environments: new Set<string>(), agents: new Set<string>(), sessions: new Map<string, string>() };

type Resources = Awaited<ReturnType<WorkspaceResources["ensure"]>>;
/** Notes what the bot's class used, so that it is removed afterwards. With
 *  this run's names, an id not seen before is one that was just created. */
function track(environmentId: string, agentId: string, variant: WorkspaceVariant) {
  if (!made.environments.has(environmentId)) console.log(`created environment ${environmentId} (${networking.type} networking)`);
  if (!made.agents.has(agentId)) console.log(`created agent ${agentId} (${variant})`);
  made.environments.add(environmentId);
  made.agents.add(agentId);
}

/** The environment and the variant's agent the way the bot gets them: looked
 *  up by name and definition first, created when there is none. */
async function ensured(variant: WorkspaceVariant): Promise<Resources> {
  const found = await store.ensure(variant, stop.signal);
  track(found.environmentId, found.agent.id, variant);
  return found;
}

/** A session the way the bot creates one: resources.ts lays the turn's model,
 *  effort, prompt and tools over the agent, sets the budget, and checks what
 *  came back. */
async function createSession(
  variant: WorkspaceVariant,
  spec: { effort?: "low" | "medium" | "high" | "xhigh" | "max"; cents?: number; label?: string } = {},
): Promise<BetaManagedAgentsSession> {
  const { session } = await store.createSession({
    variant, selection: { ...selection, ...(spec.effort && { effort: spec.effort }) },
    system: await workspaceSystem(variant), tools,
    budgetCents: spec.cents ?? budgetCents, channelId: ctx.channelId,
  }, stop.signal);
  made.sessions.set(session.id, spec.label ?? variant);
  console.log(`created session ${session.id} (${spec.label ?? variant})`);
  // An agent the class had to create again on the way is this run's too.
  track(session.environment_id, session.agent.id, variant);
  return session;
}

type Multiagent = Parameters<typeof multiagentMismatch>[0];
const multiagentText = (m: Multiagent) => !m ? "no multiagent block"
  : `${printable(m.type, 32)}: workflows ${m.workflows?.type ?? "?"}, subagents ${m.subagents?.type ?? "?"}, advisor ${m.advisor?.type ?? "?"}`;

/** What resources.ts checked before it returned the session (the model and
 *  that there is a budget), and what it only logs: whether the override kept
 *  the agent's multiagent block, by the bot's own test of it. */
function sessionStep(name: string, session: BetaManagedAgentsSession, variant: WorkspaceVariant) {
  const { model, multiagent } = session.agent;
  const kept = session.agent.tools.filter((tool) => tool.type === "custom").length;
  const budget = cents(session.budget?.max_list_cost);
  const mismatch = multiagentMismatch(multiagent, variant);
  step(name,
    (model.id === MODEL || model.id.startsWith(`${MODEL}-`)) && budget === budgetCents && kept === customTools && !mismatch,
    `${session.status}, model ${printable(model.id, 48)} at effort ${model.effort?.type ?? "unset"}, budget ${budget ?? "none"} cents, ` +
    `${kept} of ${customTools} custom tools, ${multiagentText(multiagent)}${mismatch ? ` (${mismatch})` : ""}, ` +
    `list cost ${session.usage.list_cost ? "reported" : "not reported yet"}`);
}

// ── One turn ──────────────────────────────────────────────────────────────

type Live = { id: string; totals?: WorkspaceTotals; openRuns: { id: string; name: string }[] };
type Seen = {
  /** Built-in tool calls of the primary thread, by name. */
  tools: string[];
  calls: { name: string; thread: boolean; run: boolean }[];
  /** The last `session.usage` event the stream carried. */
  usage?: ReturnType<typeof sessionTotals>;
  /** The turn's own `user.message`, and the idle event of a budget stop. */
  anchor?: string;
  budgetIdle?: string;
  /** Where that message stood among the session's messages, newest first, a
   *  moment after it was sent. `index` is -1 when it is not on the page. */
  sent?: { index: number; of: number; queued: boolean };
  /** How often the stream carried a `user.message` during the turn. */
  echoes: { queued: number; processed: number };
  runs: Map<string, { createdAt: number; phases: number; endedAt?: number; result?: string }>;
  threads: Set<string>;
  runErrors: string[];
};
type Turned = TurnResult & { seen: Seen };
type TurnOptions = {
  allowCents?: number; timeoutMs?: number; images?: string[]; context?: string; notes?: string[];
  steering?: AbortController;
  /** How long the stream may be silent before the runner opens it again. */
  idleMs?: number;
  /** Reads the session once more, right after the message was sent, and
   *  prints what it reports under this name (`atSendText`). */
  atSend?: string;
  /** The result a custom tool call gets, as a value to serialize. Nothing
   *  means the step did not expect that call. */
  answer?: (call: WorkspaceCall, ctx: Context) => unknown;
  observe?: (event: RawEvent) => void;
};
const UNEXPECTED: WorkspaceResult = { content: [{ type: "text", text: "This tool is not available in this test." }], is_error: true };

function record(seen: Seen, event: RawEvent) {
  const run = word(event.workflow_run_id), thread = word(event.session_thread_id);
  switch (event.type) {
    case "agent.tool_use":
      if (!thread && typeof event.name === "string") seen.tools.push(event.name);
      break;
    case "session.usage":
      seen.usage = sessionTotals(event.usage as Parameters<typeof sessionTotals>[0]);
      break;
    case "session.status_idle":
      if ((event.stop_reason as { type?: unknown } | undefined)?.type === "budget_reached") seen.budgetIdle = event.id;
      break;
    case "workflow_run.created":
      if (run) seen.runs.set(run, { createdAt: Date.now(), phases: Array.isArray(event.phases) ? event.phases.length : 0 });
      break;
    case "workflow_run.status_ended": {
      const known = run ? seen.runs.get(run) : undefined;
      if (known) Object.assign(known, { endedAt: Date.now(), result: word((event.result as { type?: unknown } | undefined)?.type) ?? "?" });
      break;
    }
    case "session.thread_created":
      if (run && thread) seen.threads.add(thread);
      break;
    case "workflow_run.error":
      seen.runErrors.push(word((event.error as { type?: unknown } | undefined)?.type) ?? "?");
  }
}

/** What a turn may add, at most what is left of `--budget`. The runner raises
 *  the session's budget to "used + allowance", and a step that failed after
 *  its message went out has used something this script was never told. So
 *  what is used is read from the session before every turn, not remembered. */
async function allowance(session: Live, wanted: number): Promise<number> {
  const used = sessionTotals((await client.beta.sessions.retrieve(session.id, {}, abortable)).usage).totals;
  session.totals = totalsMax(used, session.totals);
  return Math.min(wanted, budgetCents - session.totals.list_cost_cents);
}

/** Where a message that was just sent stands in the list of the session's
 *  messages, newest first. The runner looks there for a message whose send
 *  got no answer, and the bot before it picks a turn up again; both go by the
 *  first entry and by the id the send returned. */
async function sentMessage(sessionId: string, eventId: string): Promise<Seen["sent"]> {
  const page = await client.beta.sessions.events.list(sessionId, { types: ["user.message"], order: "desc" }, abortable);
  const index = page.data.findIndex((event) => event.id === eventId);
  return { index, of: page.data.length, queued: index >= 0 && !(page.data[index] as unknown as RawEvent).processed_at };
}
const sentText = (at: NonNullable<Seen["sent"]>) => at.index < 0
  ? `not among the ${at.of} message(s) listed, by the id the send returned`
  : `entry ${at.index + 1} of ${at.of} in the list of messages, ${at.queued ? "still queued" : "already processed"}`;

/** How a session reads right after a message was sent to it, before the
 *  stream is followed to where the message is taken up. The runner's ceiling
 *  for a session without a list cost rests on two things no document settles
 *  (`requireCost` in runner.ts): that a new session reports no use at all
 *  while its first message waits, and that a waiting message is listed
 *  without `processed_at`. The session is read before the list (`turn`), so
 *  with a message the list still has queued, the session was read before the
 *  message was taken up. Reported, not judged. */
function atSendText(session: BetaManagedAgentsSession | undefined, at: Seen["sent"], anchor?: string): string {
  const { totals: t, cost } = sessionTotals(session?.usage);
  return (!session ? "the session could not be read"
    : `${printable(session.status, 32)}, ` +
      `${!session.usage?.list_cost ? "no list cost" : cost ? `a list cost of ${t.list_cost_cents} cents` : "a list cost the bot cannot read"}, ` +
      `${t.active_seconds} active seconds, ${t.input_tokens} input tokens, ${t.cache_read_tokens} read from cache, ` +
      `${t.cache_write_5m_tokens + t.cache_write_1h_tokens} written to cache, ${t.output_tokens} output tokens`) + "; " +
    (!anchor ? "the send returned no id for the message" : !at ? "the list of messages could not be read"
      : `the message was then ${sentText(at)}` +
        (at.index >= 0 && !at.queued ? " (so the session may have been read after it was taken up)" : ""));
}

/** One turn through the runner, called the way workspace/index.ts calls it. */
async function turn(session: Live, text: string, options: TurnOptions = {}): Promise<Turned> {
  const allowCents = await allowance(session, options.allowCents ?? TURN_CENTS);
  if (allowCents < 1) throw new Error("the session's budget is used up");
  const seen: Seen = { tools: [], calls: [], runs: new Map(), threads: new Set(), runErrors: [], echoes: { queued: 0, processed: 0 } };
  const echoed = { ...wire.echoes };
  const timeoutMs = options.timeoutMs ?? TURN_MS;
  const result = await runTurn({
    client, sessionId: session.id, model: MODEL,
    content: await userContent({ text, images: options.images, context: options.context, notes: options.notes, signal: stop.signal }),
    ctx: { ...ctx },
    signal: stop.signal,
    steering: options.steering?.signal,
    budget: { allowCents },
    deadlineAt: Math.min(Date.now() + timeoutMs, deadline),
    executeTool: async (call, toolCtx) => {
      seen.calls.push({ name: call.name, thread: !!call.threadId, run: !!call.runId });
      try {
        const value = await options.answer?.(call, toolCtx);
        return value === undefined ? UNEXPECTED : { content: [{ type: "text", text: JSON.stringify(value) }], is_error: false };
      } catch {
        return UNEXPECTED;
      }
    },
    observe: (event) => {
      record(seen, event);
      options.observe?.(event);
    },
    // The runner adds the allowance to what it reads from the session itself,
    // a moment after `allowance` did. If the session spent in between, the
    // sum is over `--budget`, and the turn fails here, before any raise.
    onLease: (ceilingCents) => {
      if (ceilingCents > budgetCents) throw new Error(`not started: the session's budget would go to ${ceilingCents} cents, over --budget`);
    },
    onSent: async (mark) => {
      seen.anchor = mark.eventId || undefined;
      // Observations only: the turn goes on whether or not they can be made.
      // The session comes first, where a step asks for it (`atSendText`).
      const read = options.atSend
        ? await client.beta.sessions.retrieve(session.id, {}, abortable).catch(() => undefined) : undefined;
      if (mark.eventId) seen.sent = await sentMessage(session.id, mark.eventId).catch(() => undefined);
      // Printed here and not with the step, which a turn that fails later never reaches.
      if (options.atSend) note(options.atSend, atSendText(read, seen.sent, seen.anchor));
    },
    baseline: session.totals,
    knownRuns: session.openRuns,
    limits: { idleMs: options.idleMs ?? config.llmStreamIdleMs, reconnects: config.llmStreamRetries, timeoutMs },
    log,
  });
  if (result.cumulative) session.totals = totalsMax(result.cumulative, session.totals);
  session.openRuns = result.openRuns;
  seen.echoes = { queued: wire.echoes.queued - echoed.queued, processed: wire.echoes.processed - echoed.processed };
  return { ...result, seen };
}

// ── Reading the session back ──────────────────────────────────────────────

async function listed(sessionId: string): Promise<BetaFileMetadata[]> {
  const found: BetaFileMetadata[] = [];
  for await (const file of files.list(sessionId, stop.signal)) {
    found.push(file);
    if (found.length >= 500) break;
  }
  return found;
}
/** The listed file that is `rel` below the outputs directory, found by
 *  `send_file`'s own matching, and the form its `filename` is listed in. The
 *  form of a file in a subdirectory is not documented, and with the bare name
 *  alone two files of one name in two directories cannot be told apart. */
function entry(found: BetaFileMetadata[], rel: string): { file: BetaFileMetadata; form: string } | undefined {
  const file = pickOutput(found, rel);
  if (!file) return;
  if (file.filename === out(rel)) return { file, form: "its full path" };
  const bare = file.filename.replace(/^\/+/, "");
  const form = bare !== rel ? "its name without the directory"
    : rel.includes("/") ? "its path below the outputs directory" : "its name";
  return { file, form: bare === file.filename ? form : `${form}, after a leading slash` };
}
/** Why `rel` was not found: how the files that end in its name are listed.
 *  The names are this script's own, so they can be printed. */
function unmatched(found: BetaFileMetadata[], rel: string): string {
  const base = posix.basename(rel);
  const near = found.filter((file) => file.filename.endsWith(base)).map((file) => printable(file.filename, 96));
  return `not matched among ${found.length} file(s)` + (near.length ? `; listed with that name: ${[...new Set(near)].slice(0, 3).join(", ")}` : "");
}
/** What `send_file` requires of a listed file before it downloads it. */
const sendable = (file: BetaFileMetadata, sessionId: string) =>
  file.scope?.type === "session" && file.scope.id === sessionId && file.downloadable !== false;
const fileText = (file: BetaFileMetadata, sessionId: string) =>
  `scope ${!file.scope ? "absent" : file.scope.id === sessionId ? "this session" : "another id"}, ` +
  `downloadable ${file.downloadable ?? "absent"}, ${file.size_bytes} bytes, ${printable(file.mime_type, 48)}`;
async function download(file: BetaFileMetadata): Promise<string> {
  if (file.size_bytes > 100_000) throw new Error("the listed file is larger than anything this script wrote");
  return (await files.download(file.id, stop.signal)).text();
}
/** Lists the session's files until `rel` is among them, for as long as
 *  `send_file` itself waits for a file. */
async function awaited(sessionId: string, rel: string, signal?: AbortSignal) {
  const started = Date.now();
  for (let listings = 1; ; listings++) {
    const found = entry(await listed(sessionId), rel);
    if (found || Date.now() - started >= 30_000) return { found, listings, ms: Date.now() - started };
    await sleep(2_000, signal);
  }
}

/** The session's events processed after the event `from` and, when `until`
 *  is given, before that one. Neither is included. Read newest first. */
async function eventsBetween(sessionId: string, from: string, until?: string): Promise<RawEvent[] | undefined> {
  const between: RawEvent[] = [];
  let inside = !until, read = 0;
  for await (const item of client.beta.sessions.events.list(sessionId, { order: "desc" }, abortable)) {
    const event = item as unknown as RawEvent;
    if (event.id === from) return between;
    if (inside) between.push(event);
    else if (event.id === until) inside = true;
    if (++read >= 5_000) break;
  }
}
const typed = (events: RawEvent[], type: string) => events.filter((event) => event.type === type).length;
/** What a session did between its budget stop and the next turn's message,
 *  from its events in that stretch, newest first. The interrupt nearest the
 *  message is the one that was sent with it. */
function resumedText(between: RawEvent[]): string {
  const requests = typed(between, "span.model_request_start");
  const last = between.findIndex((event) => event.type === "user.interrupt");
  return `${typed(between, "user.interrupt")} interrupt(s) listed, ${requests} model request(s), ${typed(between, "agent.tool_use")} tool call(s): ` +
    `the paused turn ${requests ? "went on once the budget was raised" : "did not go on"}` +
    (last < 0 || !requests ? "" : `; ${typed(between.slice(0, last), "span.model_request_start")} of the model requests began after the last interrupt`);
}

/** The session's own usage next to the last `session.usage` event its stream
 *  carried in a turn. The runner gives a session no ceiling without a
 *  reported list cost, and takes whichever of the two is further along. */
async function usageStep(name: string, sessionId: string, seen?: Seen) {
  const own = sessionTotals((await client.beta.sessions.retrieve(sessionId, {}, abortable)).usage), streamed = seen?.usage;
  const t = own.totals;
  step(name, own.cost && !!streamed?.cost,
    `the session reports ${own.cost ? `a list cost of ${t.list_cost_cents} cents` : "no list cost"}, ${t.active_seconds} active seconds, ` +
    `${t.input_tokens + t.cache_read_tokens + t.cache_write_5m_tokens + t.cache_write_1h_tokens} input tokens (${t.cache_read_tokens} from cache), ` +
    `${t.output_tokens} output tokens, ${t.web_search_requests} web search(es); ` +
    (!streamed ? "the stream carried no session.usage"
      : `the stream's session.usage has ${JSON.stringify(streamed.totals) === JSON.stringify(t) ? "the same figures" : `other figures (${streamed.totals.list_cost_cents} cents)`}`));
}

// ── Questions that cost nothing ───────────────────────────────────────────
// No session in this part gets a message.

/** Whether agent names are unique. The bot's class does not rely on it: it
 *  looks an agent up before it creates one. */
async function sameNameAgent(resources: Resources) {
  const name = "a second agent with the same name";
  const first = await client.beta.agents.retrieve(resources.agent.id, {}, abortable);
  try {
    // Not through the bot's class, which would find the first one instead.
    const twin = await client.beta.agents.create({
      name: first.name, model: MODEL,
      description: "Created by Hibana's workspace smoke script. Safe to archive.",
      metadata: { app: APP, run: RUN },
    }, { maxRetries: 0, ...abortable });
    if (!made.agents.has(twin.id)) console.log(`created agent ${twin.id} (same name)`);
    made.agents.add(twin.id);
    note(name, twin.id === first.id ? "the first one came back" : "created: names are not unique");
  } catch (error) {
    if (!(error instanceof APIError) || !error.status) throw error;
    note(name, `refused (${describe(error)})`);
  }
}

/** What the bot does when its file is lost, or the answer to a create was:
 *  it looks the two up in the account's lists, by name, label and definition,
 *  instead of creating them again. The lists are the real ones here, with
 *  every field as the API resolves it. */
async function foundAgain(resources: Resources) {
  await rm(resourcesPath, { force: true });
  store = newStore();
  const again = await ensured("plain");
  const environment = again.environmentId === resources.environmentId, agent = again.agent.id === resources.agent.id;
  step("resources found again by name", environment && agent,
    `without its file, the environment was ${environment ? "found again" : "created a second time"} ` +
    `and the agent was ${agent ? "found again" : "created a second time"}`);
}

/** Whether the API takes an effort the bot can be set to on this model. */
async function effortProbe(effort: "xhigh" | "max") {
  try {
    const probe = await createSession("plain", { effort, cents: 1, label: `effort ${effort}` });
    note(`effort ${effort} on ${MODEL}`, `accepted (the session reports ${probe.agent.model.effort?.type ?? "none"})`);
    await client.beta.sessions.delete(probe.id, {}, abortable);
    made.sessions.delete(probe.id);
  } catch (error) {
    // resources.ts reports the API's refusal as its fixed classification.
    if (!(error instanceof ProviderError) || error.status !== 400) throw error;
    note(`effort ${effort} on ${MODEL}`, `refused (${describe(error)})`);
  }
}

/** What the bot's cleanup meets when it archives a session a second time, as
 *  after an answer that was lost. It takes the session as put away when the
 *  call succeeds, or when the session reads as archived afterwards. */
async function archivedTwice() {
  const spare = await createSession("plain", { cents: 1, label: "archived twice" });
  const first = await client.beta.sessions.archive(spare.id, {}, abortable);
  let second: string;
  try {
    const again = await client.beta.sessions.archive(spare.id, {}, abortable);
    second = `accepted, archived_at ${!again.archived_at ? "missing" : again.archived_at === first.archived_at ? "unchanged" : "changed"}`;
  } catch (error) {
    if (!(error instanceof APIError) || !error.status) throw error;
    second = `refused (${describe(error)})`;
  }
  const now = await client.beta.sessions.retrieve(spare.id, {}, abortable);
  step("archiving a session twice", !!first.archived_at && !!now.archived_at,
    `the first archive ${first.archived_at ? "set" : "did not set"} archived_at and left the session ${first.status}; ` +
    `the second was ${second}; the session then reads as ${now.archived_at ? "archived" : "not archived"}, ${now.status}`);
}

// ── The plain session ─────────────────────────────────────────────────────

async function plain() {
  // 0. The environment and the agent, then a session created from them, all
  // by the bot's own class. A schema or a name the API does not take fails
  // here, and the error names the field.
  const resources = await attempt("environment and agent", () => ensured("plain"));
  const created = resources && await attempt("session", () => createSession("plain"));
  if (!resources || !created) return;
  sessionStep("session", created, "plain");
  const session: Live = { id: created.id, openRuns: [] };

  // The second agent comes first, so that the lookup after it meets two
  // agents of one name, if the API allows that.
  await attempt("a second agent with the same name", () => sameNameAgent(resources));
  await attempt("resources found again by name", () => foundAgain(resources));
  for (const effort of ["xhigh", "max"] as const) await attempt(`effort ${effort}`, () => effortProbe(effort));
  await attempt("archiving a session twice", archivedTwice);

  // 1. A reply. The first message carries the context block, as the bot's does.
  // It is also the one message after which the session is read at once: a
  // new session that has been sent a message and may not have taken it up.
  const first = await attempt("reply", async () => {
    const result = await turn(session, `Remember this code for later: ${codes.memory}. For now, reply with the single word: ready`,
      { context: await workspaceContextBlock(runtime, ctx), atSend: "the session right after its first message was sent" });
    step("reply", result.stop === "end_turn" && result.text.length > 0,
      `${result.text.length} characters after ${result.rounds} model request(s), ended as ${result.stop}`);
    return result;
  });

  // The runner tells a turn's events from older ones by where its message
  // shows up as processed. That only works if the message is marked when its
  // processing starts, not when the turn is over.
  await attempt("when a message counts as processed", async () => {
    const name = "when a message counts as processed";
    if (!first?.seen.anchor) return step(name, false, "not run: the first turn's message has no id to look for");
    // Only the first turn is in the list so far.
    let message = NaN, began = Infinity, idle = -Infinity, read = 0;
    for await (const item of client.beta.sessions.events.list(session.id, {}, abortable)) {
      const event = item as unknown as RawEvent;
      const at = event.processed_at ? Date.parse(event.processed_at) : NaN;
      if (event.id === first.seen.anchor) message = at;
      else if (/^(agent|span)\./.test(event.type) && Number.isFinite(at)) began = Math.min(began, at);
      else if (event.type === "session.status_idle" && Number.isFinite(at)) idle = Math.max(idle, at);
      if (++read >= 2_000) break;
    }
    step(name, Number.isFinite(began) && message <= began,
      Number.isNaN(message) ? "the message has no processed_at after its turn"
        : !Number.isFinite(began) ? "the list has no event of the agent to compare with"
        : `marked ${Math.abs(began - message)} ms ${message <= began ? "before" : "after"} the agent's first event and ${idle - message} ms before the session went idle`);
  });

  // Two more things the bot goes by. Before it picks a turn up again it asks
  // which message the session was sent last, and continues only when that is
  // the id the send had returned. And on a session that was still busy, the
  // runner takes the stream to have reached the turn where the message comes
  // a second time, now processed (the list is asked when it never does).
  if (first) {
    const at = first.seen.sent, echoes = first.seen.echoes;
    step("a message just sent is the newest in the list", at?.index === 0,
      !first.seen.anchor ? "the send returned no id for the message" : !at ? "the list could not be read" : sentText(at));
    note("the turn's message on the stream", `carried ${echoes.queued} time(s) without processed_at and ${echoes.processed} time(s) with it`);
  }

  await attempt("usage after the first turn", () => usageStep("usage after the first turn", session.id, first?.seen));

  // 2. An image, as data in the message. The persona may answer in Japanese.
  await attempt("attached image", async () => {
    const result = await turn(session, "What is the main colour of the attached image? Answer with one word.", { images: [png(210, 30, 30)] });
    const named = /\bred\b|赤/i.test(result.text);
    step("attached image", named, `${named ? "named the colour" : "did not name the colour"}, ended as ${result.stop}`);
  });

  // 3. The container's own tools. The files are read back in step 5.
  await attempt("built-in tools", async () => {
    const result = await turn(session,
      "Run these three commands with the bash tool, in this order and exactly as written:\n" +
      `mkdir -p ${out(posix.dirname(SUB))}\n` +
      `printf '%s' '${codes.file}' > ${out(TOP)}\n` +
      `{ pwd; command -v ffprobe || echo none; } > ${out(SUB)}\n` +
      "Then reply with the single word: done");
    const used = new Map<string, number>();
    for (const name of result.seen.tools) bump(used, name);
    step("built-in tools", result.stop === "end_turn" && result.seen.tools.includes("bash"), `called ${tally(used)}, ended as ${result.stop}`);
  });

  // 4. A custom tool, called and answered within one turn. The file it names
  // was written a moment before, which is when `send_file` has to find it.
  await attempt("custom tool round trip", async () => {
    const held: { waited?: Awaited<ReturnType<typeof awaited>>; path?: unknown } = {};
    const result = await turn(session,
      `Do these three things in order. First, with the bash tool, run: printf '%s' '${codes.late}' > ${out(LATE)}\n` +
      `Second, call the send_file tool with path ${out(LATE)}\n` +
      "Third, reply with only the message_id from that tool's result.",
      {
        answer: async (call, toolCtx) => {
          if (call.name !== "send_file") return undefined;
          held.path = (call.input as { path?: unknown } | null)?.path;
          held.waited ??= await awaited(session.id, LATE, toolCtx.signal);
          return {
            ok: true, message_id: codes.tool, channel_id: ctx.channelId,
            attachments: [{ filename: LATE, url: `https://cdn.example.invalid/${LATE}`, size: codes.late.length }],
          };
        },
      });
    const call = result.seen.calls.find((c) => c.name === "send_file");
    step("custom tool round trip", !!call && !call.thread && result.text.includes(codes.tool),
      (call ? `send_file called from ${call.thread ? "a run's thread" : "the primary thread"} with the path ${held.path === out(LATE) ? "asked for" : "changed"}`
        : `send_file not called (${result.seen.calls.map((c) => printable(c.name, 40)).join(", ") || "no call"})`) +
      `; the reply ${result.text.includes(codes.tool) ? "uses" : "does not use"} the result`);
    const { waited } = held;
    step("a new output file is listed while the call waits", !!waited?.found,
      !waited ? "not looked for" : waited.found ? `after ${secs(waited.ms)} (listing ${waited.listings})` : `not within ${secs(waited.ms)} (${waited.listings} listings)`);
  });

  // 5. The output files through the Files API, once the session is idle.
  await attempt("output files", async () => {
    let found = await listed(session.id);
    for (let i = 0; i < 5 && !(entry(found, TOP) && entry(found, SUB)); i++) {
      await sleep(3_000, stop.signal);
      found = await listed(session.id);
    }
    const top = entry(found, TOP), sub = entry(found, SUB);
    // A refused download is a finding of its own, next to how the file is listed.
    const read = async (file?: BetaFileMetadata): Promise<{ text?: string; failed?: string }> => {
      try {
        return file ? { text: await download(file) } : {};
      } catch (error) {
        if (stop.signal.aborted) throw stop.signal.reason;
        return { failed: describe(error) };
      }
    };
    const got = await read(top?.file);
    step("an output file through the Files API", !!top && sendable(top.file, session.id) && got.text === codes.file,
      top ? `listed under ${top.form}, ${fileText(top.file, session.id)}; the download ` +
        (got.failed ? `failed (${got.failed})` : got.text === codes.file ? "is what was written" : "is not what was written")
        : unmatched(found, TOP));
    // The form decides whether send_file can tell `a/x` from `b/x`.
    step("an output file in a subdirectory", !!sub && sendable(sub.file, session.id),
      sub ? `listed under ${sub.form}, ${fileText(sub.file, session.id)}` : unmatched(found, SUB));
    // The two facts the prompt leaves open, as the container's shell gave them.
    const [directory, ffprobe] = ((await read(sub?.file)).text ?? "").split("\n");
    if (directory) note("the container", `commands start in ${printable(directory, 80)}; ffprobe: ${printable(ffprobe, 80) || "?"}`);
  });

  // 6. A later turn: the conversation and the container are still the same.
  await attempt("second turn", async () => {
    const result = await turn(session,
      "Run these two commands with the bash tool, in this order:\n" +
      `cat ${out(TOP)}\n` +
      `printf '%s' '${codes.again}' > ${out(TOP)}\n` +
      "Then reply with two things on one line: what cat printed, and the code I asked you to remember in my first message.");
    const file = result.text.includes(codes.file), memory = result.text.includes(codes.memory);
    step("a later turn in the same session", result.stop === "end_turn" && file && memory,
      `the file of an earlier turn was ${file ? "read back" : "not read back"}, the first message was ${memory ? "recalled" : "not recalled"}, ended as ${result.stop}`);
    await sleep(5_000, stop.signal);
    const versions = (await listed(session.id)).filter((f) => entry([f], TOP));
    const newest = entry(versions, TOP);
    const current = newest && await download(newest.file).catch(() => undefined);
    note("a file written again under the same name",
      `listed ${versions.length} time(s); the newest ${current === codes.again ? "has" : "does not have"} the new content`);
  });

  // A stream that is silent for too long is opened again, and what happened
  // in between is read from the list. The stream carries nothing while a
  // command runs, so a short limit forces that in the middle of a turn. What
  // the turn then makes of the list is what the reply shows: the command's
  // output, once.
  await attempt("a stream opened again in the middle of a turn", async () => {
    const opened = wire.streams;
    const result = await turn(session,
      `With the bash tool, run exactly this and wait for it to finish: sleep 20; echo ${codes.reopened}\n` +
      "Then reply with only what it printed.",
      { idleMs: 6_000 });
    const times = wire.streams - opened;
    step("a stream opened again in the middle of a turn", result.stop === "end_turn" && times > 1 && result.text.split(codes.reopened).length === 2,
      `the stream was opened ${times} time(s) in the turn, which ended as ${result.stop} after ${result.rounds} model request(s); ` +
      `the reply has the command's output ${result.text.split(codes.reopened).length - 1} time(s)`);
  });

  // The runner reads the list newest first, and only the first page when it
  // looks for a message it sent.
  await attempt("event list", async () => {
    const page = await client.beta.sessions.events.list(session.id, { order: "desc" }, abortable);
    const stamps = page.data.map((event) => (event as unknown as RawEvent).processed_at);
    const times = stamps.map((at) => (at ? Date.parse(at) : NaN));
    const dated = times.filter(Number.isFinite);
    // After a reconnect the runner tells what came before the turn's message
    // by these times alone, strictly: two events with one time are not told apart.
    const fine = stamps.filter((at) => at && /\.\d/.test(at)).length;
    const shared = dated.filter((at, i) => i > 0 && at === dated[i - 1]).length;
    step("the event list, newest first", dated.length > 1 && dated.every((at, i) => i === 0 || at <= dated[i - 1]!),
      `${page.data.length} events on a page without a limit, ${page.hasNextPage() ? "more pages follow" : "no further page"}, ${times.length - dated.length} without processed_at; ` +
      `${fine} of the ${dated.length} times have fractions of a second, and ${shared} neighbouring pair(s) share one time`);
  });

  // The runner sends an interrupt of its own before a turn whenever the
  // session may still be busy, which includes sessions that are in fact idle.
  await attempt("an interrupt sent to an idle session", async () => {
    const before = await client.beta.sessions.retrieve(session.id, {}, abortable);
    await client.beta.sessions.events.send(session.id, { events: [{ type: "user.interrupt" }] }, abortable);
    await sleep(3_000, stop.signal);
    const after = await client.beta.sessions.retrieve(session.id, {}, abortable);
    const page = await client.beta.sessions.events.list(session.id, { order: "desc" }, abortable);
    const index = page.data.findIndex((event) => event.type === "user.interrupt");
    const later = new Map<string, number>();
    for (const event of page.data.slice(0, Math.max(0, index))) bump(later, event.type);
    step("an interrupt sent to an idle session", before.status === "idle" && after.status === "idle",
      `accepted; the session was ${before.status} and is ${after.status}; ` +
      (index < 0 ? "the interrupt is not in the event list"
        : `listed ${(page.data[index] as unknown as RawEvent).processed_at ? "as processed" : "as still queued"}, followed by ${tally(later)}`));
  });

  // 7. An interrupt in the middle of a turn, as when the person writes again.
  await attempt("interrupt", async () => {
    const steering = new AbortController();
    const quiet: { at?: number; silence?: number; pings?: number; comments?: number } = {};
    const timers: ReturnType<typeof setTimeout>[] = [];
    const steer = () => {
      quiet.at ??= Date.now();
      steering.abort(new Error("User steering"));
    };
    // Steered even when the command never starts, so that the step ends.
    timers.push(setTimeout(steer, 60_000));
    try {
      // An interrupt can wait for a running tool call. The command ends
      // within the time the runner waits for the session to go idle.
      const result = await turn(session,
        "With the bash tool, run exactly this and wait for it to finish: sleep 45; echo finished\nThen reply with the single word: finished",
        {
          steering,
          observe: (event) => {
            if (timers.length > 1 || event.type !== "agent.tool_use" || event.name !== "bash") return;
            const pings = wire.frames.get("ping") ?? 0, comments = wire.comments;
            wire.silence = 0;
            wire.last = Date.now();
            timers.push(setTimeout(() => {
              quiet.silence = Math.max(wire.silence, Date.now() - wire.last);
              quiet.pings = (wire.frames.get("ping") ?? 0) - pings;
              quiet.comments = wire.comments - comments;
              steer();
            }, QUIET_MS));
          },
        });
      step("interrupt", result.stop === "interrupted" && result.released,
        `ended as ${result.stop}${quiet.at ? ` ${secs(Date.now() - quiet.at)} after the interrupt` : ""}; the turn's allowance was ${result.released ? "" : "not "}taken back`);
      if (quiet.silence !== undefined)
        note("the stream while a command ran", `over ${secs(QUIET_MS)}: longest silence ${secs(quiet.silence)}, ${quiet.pings} ping frame(s), ${quiet.comments} comment line(s)`);
    } finally {
      for (const timer of timers) clearTimeout(timer);
    }
  });

  // 8. A turn that is allowed one cent. A web search costs that much at list
  // price, so the session reaches its budget after the first few.
  const stopped = await attempt("a turn stops at its budget", async () => {
    const name = "a turn stops at its budget";
    if (!web) return void step(name, false, "not run: this step spends through web searches, which are switched off here");
    const result = await turn(session,
      "Look these up on the web with the web search tool, one search at a time and in this order, waiting for each result before the next search: " +
      "the height of Mount Fuji; the length of the Shinano River; the area of Lake Biwa; the population of Sapporo; the depth of Lake Tazawa; the height of Tokyo Skytree. " +
      "Then reply with the single word: searched",
      { allowCents: 1 });
    const now = await client.beta.sessions.retrieve(session.id, {}, abortable);
    step(name, result.stop === "budget" && result.released && !!result.notice,
      `ended as ${result.stop} after ${result.seen.tools.filter((tool) => tool === "web_search").length} web search(es) and ${result.rounds} model request(s); ` +
      `the session is ${now.status} with a budget of ${cents(now.budget?.max_list_cost) ?? "none"} cents and a list cost of ${sessionTotals(now.usage).totals.list_cost_cents} cents`);
    return result;
  });
  if (stopped) await attempt("usage at the budget stop", () => usageStep("usage at the budget stop", session.id, stopped.seen));

  // 9. What the API says to a budget at or below what the session has used.
  // The runner retries on this one refusal only and has to recognize it.
  await attempt("a budget below the list cost is refused", async () => {
    const name = "a budget below the list cost is refused";
    const used = sessionTotals((await client.beta.sessions.retrieve(session.id, {}, abortable)).usage).totals.list_cost_cents;
    if (used < 1) return step(name, false, "not run: the session reports no list cost yet, so no budget is below it");
    const asked = Math.max(1, used - 1);
    try {
      await client.beta.sessions.update(session.id, { budget: budgetLimit(asked) }, { maxRetries: 0, ...abortable });
      step(name, false, `accepted: a budget of ${asked} cents with ${used} cents used`);
    } catch (error) {
      if (!(error instanceof APIError) || !error.status) throw error;
      const info = apiErrorInfo(error);
      const inner = (error.error as { error?: { details?: unknown } } | undefined)?.error;
      const keys = (value: unknown) => (value && typeof value === "object" ? Object.keys(value).map((key) => printable(key, 32)).join(", ") : "none");
      // The runner's own test of this refusal: by its code, or else by the
      // sentence the documentation gives.
      const recognized = budgetNotRaised(info);
      step(name, info.status === 400 && recognized,
        `HTTP ${info.status} ${word(info.type) ?? "?"}; fields of the error: ${keys(inner)}; fields of its details: ${keys(inner?.details)}; ` +
        `details.error_code: ${word(info.code) ?? "none"}; message of ${info.message.length} characters, mentions ${mentioned(info.message) || "no field"}; ` +
        (!recognized ? "the runner does not recognize it" : `the runner recognizes it by its ${info.code === "budget_not_raised" ? "code" : "message"}`));
    }
  });

  // 10. The message a person sends after being told the budget was reached.
  // The runner sends an interrupt (at its budget a session takes one and, by
  // the documentation, stops nothing for it), raises the budget (which sets
  // the paused work going again), and then sends the message behind a second
  // interrupt, both in one request. The turn starts where its message shows
  // up as processed; what the paused work did before that is not the turn's.
  await attempt("a turn after a budget stop", async () => {
    const name = "a turn after a budget stop";
    if (stopped?.stop !== "budget") return step(name, false, "not run: the step before did not leave the session at its budget");
    const result = await turn(session, "Stop the web lookups from before and do not search again. Reply with the single word: back");
    step(name, result.stop === "end_turn" && result.text.length > 0,
      `${result.text.length} characters after ${result.rounds} model request(s), ended as ${result.stop}`);
    // Sent while the session may still have been busy with the older work.
    if (result.seen.sent) note("the message sent after the budget stop", `a moment after the send: ${sentText(result.seen.sent)}; ` +
      `the stream carried it ${result.seen.echoes.queued} time(s) without processed_at and ${result.seen.echoes.processed} time(s) with it`);
    // Whether the paused work went on, and how far, before the new message
    // was taken up, is in the list.
    const between = stopped.seen.budgetIdle && result.seen.anchor
      ? await eventsBetween(session.id, stopped.seen.budgetIdle, result.seen.anchor) : undefined;
    if (between) note("between the budget stop and the new message", resumedText(between));
  });
}

// ── The Haiku Ultra session ───────────────────────────────────────────────

async function ultra() {
  // Whether the API takes dynamic workflows on this model is in no document.
  // The agent is the one resources.ts defines, read back as the API has it.
  const resources = await attempt(`an agent with workflows on ${MODEL}`, async () => {
    const found = await ensured("ultra");
    const agent = await client.beta.agents.retrieve(found.agent.id, {}, abortable);
    const mismatch = multiagentMismatch(agent.multiagent, "ultra");
    step(`an agent with workflows on ${MODEL}`, !mismatch,
      `asked for ${multiagentText(ULTRA_MULTIAGENT)}; the agent has ${multiagentText(agent.multiagent)}${mismatch ? ` (${mismatch})` : ""}`);
    return found;
  });
  const created = resources && await attempt("Haiku Ultra session", () => createSession("ultra"));
  if (!created) return;
  sessionStep("Haiku Ultra session", created, "ultra");
  const session: Live = { id: created.id, openRuns: [] };

  // A run from its creation to its end, with one custom tool call made by an
  // agent of the run.
  await attempt("workflow run", async () => {
    const result = await turn(session,
      "This is a connection test of workflow runs, so start one although the work is small. " +
      "Start one workflow run with two agents that work at the same time. The first agent calls the list_sites tool once and returns how many sites it lists. " +
      `The second agent runs this with the bash tool and returns what it printed: echo ${codes.echo}\n` +
      "When the run has ended, reply with both results.",
      { timeoutMs: WORKFLOW_TURN_MS, allowCents: WORKFLOW_TURN_CENTS, answer: (call) => (call.name === "list_sites" ? { sites: [] } : undefined) });
    const runs = [...result.seen.runs.values()];
    step("a workflow run from created to ended",
      runs.length > 0 && runs.every((run) => run.result === "completed") && result.stop === "end_turn" && !result.openRuns.length,
      `${runs.length} run(s): ${runs.map((run) => (run.endedAt ? `${run.result} after ${secs(run.endedAt - run.createdAt)}` : "not ended")).join(", ") || "none started"}; ` +
      `${result.seen.threads.size} thread(s), ${runs.reduce((sum, run) => sum + run.phases, 0)} phase(s), ${result.seen.runErrors.length ? `run errors: ${result.seen.runErrors.join(", ")}; ` : ""}` +
      `the turn ended as ${result.stop} with ${result.openRuns.length} run(s) open; the reply ${result.text.includes(codes.echo) ? "has" : "does not have"} the second agent's output`);
    // The bot refuses a thread's call unless it knows which run the thread
    // belongs to, so both have to be there when the call arrives.
    const calls = result.seen.calls.filter((call) => call.thread);
    step("a custom tool call from a run's thread", calls.some((call) => call.run),
      calls.length ? calls.map((call) => `${printable(call.name, 40)} with session_thread_id, its run ${call.run ? "known" : "not known"}`).join("; ")
        : `none arrived from a thread (${result.seen.calls.length} call(s) from the primary thread)`);
  });

  // A run paused at the budget, then an interrupt, then a higher budget: the
  // documentation says such a run "can" stay paused, and the runner's order
  // of interrupt before raise relies on it.
  await attempt("a run interrupted at the budget stays paused", async () => {
    const name = "a run interrupted at the budget stays paused";
    if (!web) return step(name, false, "not run: this step spends through web searches, which are switched off here");
    const paused = await turn(session,
      "This is a test of a paused workflow run, so start one although the work is small. " +
      "Start one workflow run with three agents that work at the same time. Each agent looks up five different facts about Japanese geography on the web, " +
      "one web search per fact and one after another, and returns one line per fact. When the run has ended, reply with the single word: finished",
      { timeoutMs: WORKFLOW_TURN_MS, allowCents: 1 });
    const pausedAt = paused.seen.budgetIdle;
    if (paused.stop !== "budget" || !paused.openRuns.length || !pausedAt)
      return step(name, false, `not reached: the turn ended as ${paused.stop} with ${paused.openRuns.length} run(s) open`);
    await client.beta.sessions.events.send(session.id, { events: [{ type: "user.interrupt" }] }, abortable);
    // Read after the pause: each thread still finished the request it was in.
    const used = sessionTotals((await client.beta.sessions.retrieve(session.id, {}, abortable)).usage).totals.list_cost_cents;
    if (used + 2 > budgetCents) return step(name, false, `not run: ${used} of the session's ${budgetCents} cents are used, so its budget cannot go up`);
    await client.beta.sessions.update(session.id, { budget: budgetLimit(Math.min(budgetCents, used + 5)) }, abortable);
    await sleep(15_000, stop.signal);
    const since = await eventsBetween(session.id, pausedAt) ?? [];
    const runs = typed(since, "workflow_run.status_running");
    const threads = since.filter((event) => event.type === "session.thread_status_running" && paused.seen.threads.has(String(event.session_thread_id))).length;
    // Whatever went on, nothing may go on spending while the next step waits.
    const rest = await quiesce(client, session.id, { interrupt: true, log });
    if (rest.totals) session.totals = totalsMax(rest.totals, session.totals);
    step(name, runs + threads === 0,
      `15 s after the budget went up: ${runs} run(s) and ${threads} of the run's ${paused.seen.threads.size} thread(s) reported running, ` +
      `${typed(since, "span.model_request_start")} model request(s) in the session's own list, list cost ${used} -> ${rest.totals?.list_cost_cents ?? "?"} cents`);
  });

  // What a person's "stop" does to a run that was left open, which is also
  // what lets the session be deleted afterwards.
  if (session.openRuns.length) await attempt("open runs are stopped on request", async () => {
    const open = session.openRuns.length;
    const result = await turn(session,
      "Stop every workflow run that is still open and start no new one. Then reply with the single word: stopped",
      { timeoutMs: WORKFLOW_TURN_MS, notes: [openRunsNote(session.openRuns.map((run) => run.name))] });
    step("open runs are stopped on request", result.stop === "end_turn" && !result.openRuns.length,
      `${open} run(s) were open, ${result.openRuns.length} still are; the turn ended as ${result.stop}`);
  });
}

// ── The bot's own turns ───────────────────────────────────────────────────

// The Discord ids of this part. Nothing goes to Discord, so they only have to
// read as ids. `hidden` is a channel of the same server the person cannot read.
const DISCORD = {
  guild: "900000000000000001", channel: "900000000000000002", hidden: "900000000000000003",
  user: "900000000000000004", bot: "900000000000000005", newest: "900000000000000013", posted: "900000000000000020",
};
type RestCall = { method: string; path: string; query: string; body?: Json; files: { name: string; data: Buffer }[] };
// What the bot answers instead of running a turn (workspace/index.ts).
const limited = (reply: string) => /利用額の上限|利用額の記録/.test(reply);

/** What this part's bot is started with. Not the deployment's settings: only
 *  what decides how a session is created is taken from there. No other
 *  integration (Jev, published sites, skills, the sandbox) is switched on, so
 *  the session is not offered a tool that would reach anything but Discord. */
function botConfig(dir: string) {
  const kept = [
    "ANTHROPIC_WORKSPACE_API_KEY", "ANTHROPIC_WORKSPACE_BASE_URL", "ANTHROPIC_WORKSPACE_NETWORKING",
    "ANTHROPIC_WORKSPACE_ALLOWED_HOSTS", "ANTHROPIC_WORKSPACE_WEB_ENABLED", "WEB_SEARCH_ENABLED", "PERSONA_FILE",
  ];
  return loadConfig({
    ...Object.fromEntries(kept.flatMap((name) => (process.env[name] === undefined ? [] : [[name, process.env[name]]]))),
    PROVIDER: WORKSPACE_PROVIDER, LLM_MODEL: MODEL, LLM_EFFORT: "medium",
    HIBANA_DATA_DIR: dir, RUNTIME_STATE_PATH: "", LOG_DIR: "", SANDBOX_ENABLED: "false", SKILLS_ENABLED: "false",
    // The bot's own limits hold this part to `--budget`.
    ANTHROPIC_WORKSPACE_TURN_BUDGET_USD: String(Math.min(TURN_CENTS, budgetCents) / 100),
    ANTHROPIC_WORKSPACE_ULTRA_TURN_BUDGET_USD: String(Math.min(WORKFLOW_TURN_CENTS, budgetCents) / 100),
    ANTHROPIC_WORKSPACE_DAILY_BUDGET_USD: String(budgetUsd),
    ANTHROPIC_WORKSPACE_MONTHLY_BUDGET_USD: String(budgetUsd),
    ANTHROPIC_WORKSPACE_TURN_TIMEOUT_MS: String(TURN_MS),
    ANTHROPIC_WORKSPACE_ULTRA_TURN_TIMEOUT_MS: String(WORKFLOW_TURN_MS),
  });
}

/** Discord, answered from memory: the two channels of one server, the
 *  messages `read_messages` returns, and a list of every REST call the bot's
 *  tools made instead of sending it. */
function fakeDiscord(hibana: Hibana, messages: Json[]) {
  const rest: RestCall[] = [], shown: string[] = [];
  const member = (userId: string) => ({ id: userId, permissions: { has: () => true } });
  (hibana.client as { user: { id: string } | null }).user = { id: DISCORD.bot };
  hibana.client.channels.fetch = (async (id: string) => {
    if (id !== DISCORD.channel && id !== DISCORD.hidden) return null;
    return {
      id, guildId: DISCORD.guild, name: "smoke", isSendable: () => true, isThread: () => false, sendTyping: async () => {},
      guild: { id: DISCORD.guild, members: { fetch: async (userId: string) => member(userId) } },
      // Asked with a list for "may read this channel", with one flag otherwise.
      permissionsFor: () => ({ has: (flags: unknown) => !Array.isArray(flags) || id !== DISCORD.hidden }),
      send: async (value: { content: string }) => {
        shown.push(value.content);
        return { id: DISCORD.posted, edit: async (next: { content: string }) => { shown.push(next.content); } };
      },
    };
  }) as never;
  hibana.client.guilds.fetch = (async () => ({
    id: DISCORD.guild, ownerId: DISCORD.user, members: { fetch: async (userId: string) => member(userId) },
  })) as never;
  const answer = (method: string) =>
    async (path: string, options: { body?: Json; query?: URLSearchParams; files?: RestCall["files"] } = {}) => {
      const files = options.files ?? [];
      rest.push({ method, path, query: options.query?.toString() ?? "", body: options.body, files });
      const channel = /^\/channels\/(\d+)\/messages$/.exec(path)?.[1];
      if (channel && method === "get") return messages.slice(0, Number(options.query?.get("limit") ?? messages.length));
      if (channel && method === "post")
        return {
          id: DISCORD.posted, channel_id: channel, content: options.body?.content ?? "",
          attachments: files.map((file, i) => ({
            id: String(i), filename: file.name, size: file.data.length, url: `https://cdn.example.invalid/${file.name}`,
          })),
        };
      return method === "get" ? [] : undefined;
    };
  // Every way a request could leave through this client.
  const client = hibana.client.rest as unknown as Record<string, unknown>;
  for (const method of ["get", "post", "put", "patch", "delete"]) client[method] = answer(method);
  for (const method of ["request", "queueRequest", "raw"])
    client[method] = async () => { throw new Error("The smoke script's bot sends nothing to Discord."); };
  return { rest, shown };
}

/** Turns as the bot runs them, with the session's custom tool calls run by
 *  the bot's own registry. What the tools did is read from the fake Discord. */
async function bot() {
  const dir = join(dataDir, "bot");
  const codes = { read: code(), sent: code(), file: code(), written: code(), worker: code() };
  const FILE = `smoke-${RUN}-bot.txt`, WRITTEN = `smoke-${RUN}-bot-written.txt`;
  const at = (n: number) => new Date(Date.now() - n * 60_000).toISOString();
  const author = { id: DISCORD.user, username: "smoke", bot: false };
  const messages: Json[] = [
    { id: DISCORD.newest, channel_id: DISCORD.channel, content: codes.read, author, timestamp: at(1), attachments: [], embeds: [] },
    { id: "900000000000000012", channel_id: DISCORD.channel, content: "second", author, timestamp: at(2), attachments: [], embeds: [] },
    { id: "900000000000000011", channel_id: DISCORD.channel, content: "first", author, timestamp: at(3), attachments: [], embeds: [] },
  ];

  // While this part runs, the global `fetch` reaches nothing. The bot's API
  // client was handed `counted`; whatever else asks for the network (a tool
  // that downloads a URL, an integration that was not switched off) is
  // refused here and counted by host.
  const blocked = new Map<string, number>();
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    bump(blocked, URL.canParse(url) ? new URL(url).host : "?");
    throw new TypeError("The smoke script's bot reaches no host but the API.");
  }) as unknown as typeof fetch;

  const hibana = new Hibana(botConfig(dir), log, {
    workspace: { fetch: counted, identity: { prefix: `${APP}-${RUN}`, app: APP } },
  });
  const discord = fakeDiscord(hibana, messages);
  // The Workspace presets are Premium ones.
  hibana.runtime.snapshot.user_roles[DISCORD.user] = "premium";
  // A Workspace turn asks the session, never the Messages API.
  let modelRequests = 0;
  hibana.llm.complete = (async () => {
    modelRequests++;
    throw new Error("a Workspace turn must not use the LLM client");
  }) as typeof hibana.llm.complete;
  hibana.tools.web.remote = (async () => ({ tools: [] })) as never;
  // Every custom tool call the registry was asked to run, and how it went.
  // `role`: set on a call the registry ran for an agent of a workflow run.
  const ran: { name: string; ok: boolean; error?: string; role?: string }[] = [];
  const execute = hibana.tools.execute.bind(hibana.tools);
  hibana.tools.execute = (async (name: string, args: Json, toolCtx: Context) => {
    try {
      const result = await execute(name, args, toolCtx);
      ran.push({ name, ok: !(result instanceof ToolOutput && result.options.isError), role: toolCtx.agentRole });
      return result;
    } catch (error) {
      ran.push({ name, ok: false, error: error instanceof Error ? error.message : String(error), role: toolCtx.agentRole });
      throw error;
    }
  }) as typeof hibana.tools.execute;

  let turns = 0;
  /** One message of the person in the channel, through `Hibana.respond`. */
  const say = async (text: string) => {
    const from = { ran: ran.length, rest: discord.rest.length, tools: wire.tools.length, results: wire.results.length };
    const messageId = String(BigInt(DISCORD.newest) + BigInt(100 + ++turns));
    const reply = await hibana.respond(
      `${text}\n\n[author: smoke; user_id: ${DISCORD.user}; channel_id: ${DISCORD.channel}; message_id: ${messageId}]`,
      { guildId: DISCORD.guild, channelId: DISCORD.channel, userId: DISCORD.user, botId: DISCORD.bot, messageId, thread: false, depth: 0, delivered: false },
    );
    return {
      reply, ran: ran.slice(from.ran), rest: discord.rest.slice(from.rest),
      builtins: wire.tools.slice(from.tools), results: wire.results.slice(from.results),
    };
  };
  type Said = Awaited<ReturnType<typeof say>>;
  const ranText = (turn: Said) => turn.ran.map((call) =>
    `${printable(call.name, 40)}${call.role ? ` as a ${printable(call.role, 16)}` : ""} ${call.ok ? "ran" : `failed (${printable(call.error, 120)})`}`).join(", ") || "no custom tool call";
  const ok = (turn: Said, ...names: string[]) => names.every((name) => turn.ran.some((call) => call.name === name && call.ok));
  const ended = (turn: Said) => (limited(turn.reply) ? "the bot refused the turn at its own limit" : `a reply of ${turn.reply.length} characters`);

  try {
    hibana.conversations.open();
    await hibana.workspace.load();

    // 1. A reply, and the session the bot created for it.
    await attempt("the bot's turn", async () => {
      const turn = await say("Reply with the single word: ready");
      step("the bot's turn", turn.reply.length > 0 && !limited(turn.reply), `${ended(turn)}, ${discord.shown.length} message text(s) shown in the channel`);
    });
    const row = hibana.workspace.sessions.get(DISCORD.channel);
    if (!row) return step("the bot's session", false, "the bot has no session for the channel");
    made.sessions.set(row.sessionId, "the bot's");
    console.log(`created session ${row.sessionId} (the bot's)`);
    await attempt("the bot's session", async () => {
      const session = await client.beta.sessions.retrieve(row.sessionId, {}, abortable);
      track(session.environment_id, session.agent.id, "plain");
      const { model } = session.agent;
      const offered = hibana.tools.workspaceTools({ ...ctx, guildId: DISCORD.guild, channelId: DISCORD.channel }).length;
      const kept = session.agent.tools.filter((tool) => tool.type === "custom").length;
      step("the bot's session",
        (model.id === MODEL || model.id.startsWith(`${MODEL}-`)) && model.effort?.type === "medium" && kept === offered && session.metadata?.app === APP,
        `model ${printable(model.id, 48)} at effort ${model.effort?.type ?? "unset"}, ${kept} of ${offered} custom tools, ` +
        `a budget of ${cents(session.budget?.max_list_cost) ?? "none"} cents after the turn, labelled ${printable(session.metadata?.app, 32) || "nothing"}`);
    });

    // 2. Two tools that only read, asked for together.
    await attempt("reading Discord and the settings", async () => {
      const turn = await say(
        "Call the read_messages tool with limit 3 for this channel, and the get_bot_settings tool. " +
        "Then reply with only the content of the newest message that read_messages returned.");
      const read = turn.rest.find((call) => call.method === "get" && call.path === `/channels/${DISCORD.channel}/messages`);
      step("reading Discord and the settings", ok(turn, "read_messages", "get_bot_settings") && read?.query === "limit=3" && turn.reply.includes(codes.read),
        `${ranText(turn)}; read_messages asked Discord for ${read ? printable(read.query, 40) || "no limit" : "nothing"}; ` +
        `the reply ${turn.reply.includes(codes.read) ? "has" : "does not have"} the newest message's content`);
    });

    // 3. Two tools that change something, one after the other.
    await attempt("posting and reacting", async () => {
      const turn = await say(
        `Call the send_message tool with the content ${codes.sent} for this channel. When it has returned, call the add_reaction tool ` +
        `for this channel with message_id ${DISCORD.newest} and the emoji 👍. Then reply with the single word: posted`);
      const post = turn.rest.findIndex((call) => call.method === "post" && call.path === `/channels/${DISCORD.channel}/messages` && !call.files.length);
      const react = turn.rest.findIndex((call) => call.method === "put" && call.path.startsWith(`/channels/${DISCORD.channel}/messages/${DISCORD.newest}/reactions/`));
      const body = turn.rest[post]?.body;
      const quiet = JSON.stringify(body?.allowed_mentions) === '{"parse":[]}';
      const emoji = decodeURIComponent(turn.rest[react]?.path.split("/").at(-2) ?? "");
      step("posting and reacting",
        ok(turn, "send_message", "add_reaction") && body?.content === codes.sent && quiet && post >= 0 && post < react && emoji === "👍",
        `${ranText(turn)}; send_message ${post < 0 ? "posted nothing"
          : `posted ${body?.content === codes.sent ? "the content asked for" : "another content"}, with mentions ${quiet ? "switched off" : "left on"}`}; ` +
        `add_reaction ${react < 0 ? "sent nothing" : `put ${emoji === "👍" ? "the emoji asked for" : "another emoji"} ${post < react ? "after" : "before"} the post`}`);
    });

    // 4. A file from the container to the channel: the session's shell, then
    // the bot's own send_file, which finds the file through the Files API.
    await attempt("send_file from the container", async () => {
      const turn = await say(
        `Do these three things in order. First, with the bash tool, run: printf '%s' '${codes.file}' > ${out(FILE)}\n` +
        `Second, call the send_file tool with path ${out(FILE)}\n` +
        "Third, reply with only the message_id from that tool's result.");
      const posted = turn.rest.find((call) => call.method === "post" && call.files.length);
      const file = posted?.files[0];
      step("send_file from the container",
        ok(turn, "send_file") && turn.builtins.includes("bash") && file?.name === FILE && file.data.toString() === codes.file && turn.reply.includes(DISCORD.posted),
        `${ranText(turn)}; built-in calls: ${turn.builtins.map((name) => printable(name, 24)).join(", ") || "none"}; ` +
        (file ? `posted ${printable(file.name, 64)} with ${file.data.toString() === codes.file ? "the bytes that were written" : "other bytes"}` : "no file was posted") +
        `; the reply ${turn.reply.includes(DISCORD.posted) ? "uses" : "does not use"} the result`);
    });

    // 5. A call the person may not make. The registry refuses it, nothing is
    // asked of Discord, and the session is told so as a failed result.
    await attempt("a channel the person cannot read", async () => {
      const turn = await say(
        `Call the read_messages tool with channel_id ${DISCORD.hidden} and limit 1. ` +
        "If the tool returns an error, reply with the single word REFUSED. If it returns messages, reply with the single word READ.");
      const call = turn.ran.find((c) => c.name === "read_messages");
      const asked = turn.rest.some((c) => c.path.startsWith(`/channels/${DISCORD.hidden}`));
      const told = turn.results.some((result) => result.error && result.accepted);
      step("a channel the person cannot read", !!call && !call.ok && !asked && told && /REFUSED/.test(turn.reply),
        `${ranText(turn)}; Discord was ${asked ? "" : "not "}asked about the channel; a failed result was ${told ? "sent and accepted" : "not sent"}; ` +
        `the reply ${/REFUSED/.test(turn.reply) ? "says it was refused" : "does not say it was refused"}`);
    });

    // 6. The container's other tools, which never come to the bot.
    await attempt("the container's file and web tools", async () => {
      const page = "https://example.com/";
      const turn = await say(
        `Use the write tool to create the file ${out(WRITTEN)} with exactly this content: ${codes.written}\n` +
        "Then use the read tool to read that file back." +
        (web ? ` Then use the web_fetch tool on ${page}\nReply with two things on one line: what the read tool returned, and the title of that page.`
          : "\nReply with only what the read tool returned."));
      const used = new Map<string, number>();
      for (const name of turn.builtins) bump(used, name);
      const fetched = !web || (turn.builtins.includes("web_fetch") && /example domain/i.test(turn.reply));
      step("the container's file and web tools",
        turn.builtins.includes("write") && turn.builtins.includes("read") && turn.reply.includes(codes.written) && fetched && !turn.ran.length,
        `called ${tally(used)}; ${turn.ran.length} call(s) came to the bot; the reply ${turn.reply.includes(codes.written) ? "has" : "does not have"} the file's content` +
        (web ? ` and ${/example domain/i.test(turn.reply) ? "has" : "does not have"} the page's title` : "; web tools are switched off here"));
    });

    // What the bot's ledger holds against its limits, next to what the
    // session itself reports. The ledger may count more, never less.
    await attempt("the bot's ledger", async () => {
      const own = sessionTotals((await client.beta.sessions.retrieve(row.sessionId, {}, abortable)).usage);
      const day = hibana.workspace.usage.limitCents("day");
      const line = hibana.workspace.usageLine();
      step("the bot's ledger", own.cost && day >= own.totals.list_cost_cents && !!line,
        `the session reports ${own.cost ? `a list cost of ${own.totals.list_cost_cents} cents` : "no list cost"} after ${turns} turn(s); ` +
        `the bot holds ${day} cents against the day's limit of ${budgetCents}; /usage ${line ? "has a line for the Workspace" : "has no line"}`);
    });
    step("the bot's Messages API client", modelRequests === 0, `${modelRequests} request(s) were tried through it`);

    // 7. `/clear`: the conversation ends, and the bot removes its session.
    await attempt("the bot removes a cleared conversation's session", async () => {
      hibana.history.clear(DISCORD.channel);
      await hibana.workspace.sweep();
      let status: number | undefined, archived = false;
      try {
        archived = !!(await client.beta.sessions.retrieve(row.sessionId, {}, abortable)).archived_at;
      } catch (error) {
        if (!(error instanceof APIError) || !error.status) throw error;
        status = error.status;
      }
      if (status === 404) made.sessions.delete(row.sessionId);
      step("the bot removes a cleared conversation's session", status === 404 && !hibana.workspace.sessions.get(DISCORD.channel),
        status === 404 ? "deleted: the session is gone from the API and from the bot's table"
          : status ? `the session could not be read (HTTP ${status})` : `the session is still there${archived ? ", archived" : ""}`);
    });

    // 8. Haiku Ultra as the bot runs it. Ultra is stored the way the
    // dashboard stores it, so the next message is a new conversation with a
    // session of the other variant. The agents of a workflow run work for the
    // run: the registry runs their calls as workers, who may read Discord and
    // may not post to it.
    if (option("--ultra")) await attempt("the bot's Haiku Ultra turn", async () => {
      await hibana.runtime.patch(DISCORD.guild, { ultra_mode: true }, DISCORD.user);
      const count = (type: string) => wire.events.get(type) ?? 0;
      const before = {
        day: hibana.workspace.usage.limitCents("day"),
        created: count("workflow_run.created"), ended: count("workflow_run.status_ended"),
      };
      const turn = await say(
        "This is a connection test of workflow runs, so start one although the work is small. " +
        "Start one workflow run with two agents that work at the same time. The first agent calls the read_messages tool with limit 1 for this channel and returns the content of the message it got. " +
        `The second agent calls the send_message tool once with the content ${codes.worker} for this channel, and returns the single word POSTED if the tool worked or REFUSED if it returned an error. ` +
        "Do not call send_message yourself. When the run has ended, reply on one line with what the two agents returned.");
      const second = hibana.workspace.sessions.get(DISCORD.channel);
      if (!second || second.sessionId === row.sessionId)
        return step("the bot's Haiku Ultra turn", false, `${ended(turn)}; the bot has no new session for the channel`);
      made.sessions.set(second.sessionId, "the bot's, Ultra");
      console.log(`created session ${second.sessionId} (the bot's, Ultra)`);
      const session = await client.beta.sessions.retrieve(second.sessionId, {}, abortable);
      track(session.environment_id, session.agent.id, "ultra");
      const mismatch = multiagentMismatch(session.agent.multiagent, "ultra");
      const runs = { created: count("workflow_run.created") - before.created, ended: count("workflow_run.status_ended") - before.ended };
      const open = second.state?.openRuns?.length ?? 0;
      const read = turn.ran.find((call) => call.name === "read_messages"), post = turn.ran.find((call) => call.name === "send_message");
      const asked = turn.rest.find((call) => call.method === "get" && call.path === `/channels/${DISCORD.channel}/messages`);
      const posted = turn.rest.some((call) => call.method === "post");
      const own = sessionTotals(session.usage);
      const day = hibana.workspace.usage.limitCents("day") - before.day;
      step("the bot's Haiku Ultra turn",
        second.variant === "ultra" && !mismatch && runs.created > 0 && runs.ended > 0 && !open &&
        !!read?.ok && read.role === "worker" && asked?.query === "limit=1" && turn.reply.includes(codes.read) &&
        !!post && !post.ok && post.role === "worker" && !posted && /REFUSED/.test(turn.reply) &&
        !limited(turn.reply) && own.cost && day >= own.totals.list_cost_cents,
        `${ended(turn)} from a session of the ${printable(second.variant, 16)} variant, ${multiagentText(session.agent.multiagent)}${mismatch ? ` (${mismatch})` : ""}; ` +
        `${runs.created} workflow run(s) created and ${runs.ended} ended on the stream, ${open} left open; ${ranText(turn)}; ` +
        `read_messages asked Discord for ${asked ? printable(asked.query, 40) || "no limit" : "nothing"} and the reply ${turn.reply.includes(codes.read) ? "has" : "does not have"} the message's content; ` +
        `${posted ? "something was posted to Discord" : "nothing was posted to Discord"} and the reply ${/REFUSED/.test(turn.reply) ? "says the post was refused" : "does not say the post was refused"}; ` +
        `the session reports ${own.cost ? `a list cost of ${own.totals.list_cost_cents} cents` : "no list cost"}, and the bot holds ${day} more cents against the day's limit`);
    });
  } finally {
    await hibana.close().catch(() => {});
    globalThis.fetch = network;
    // Replies and status lines alike: what a person would have seen.
    note("what the bot showed in the channel", `${discord.shown.length} message text(s) over ${turns} turn(s), ${discord.shown.filter((text) => !text.trim()).length} of them empty`);
    if (blocked.size) note("requests the bot's part refused", tally(blocked));
  }
}

// ── Putting everything away ───────────────────────────────────────────────

/** `--cleanup`: what earlier runs left behind, found by its metadata.
 *  Sessions are reached through the agents they were created from, so the
 *  bot's own sessions are not even listed. */
async function leftovers() {
  let scanned = 0;
  for await (const agent of client.beta.agents.list({ include_archived: true }, abortable)) {
    if (agent.metadata?.app === APP) {
      for await (const session of client.beta.sessions.list({ agent_id: agent.id, include_archived: true }, abortable))
        if (session.metadata?.app === APP) made.sessions.set(session.id, "left behind");
      if (agent.archived_at === null) made.agents.add(agent.id);
    }
    if (++scanned >= 5_000) break;
  }
  for await (const environment of client.beta.environments.list({}, abortable))
    if (environment.metadata?.app === APP) made.environments.add(environment.id);
  console.log(`found ${made.sessions.size} session(s), ${made.environments.size} environment(s) and ${made.agents.size} agent(s) with metadata.app = ${APP}`);
}

/** A session that has ended for good (archived, or terminated), as it reads
 *  now. Nothing when it has not ended, or cannot be read. */
const ended = (id: string) => client.beta.sessions.retrieve(id).then(
  (session) => (session.archived_at || session.status === "terminated" ? session : undefined), () => undefined);
/** Whether a request that failed was refused: answered, with a status that
 *  asking again does not change (by the bot's own reading of a status). A
 *  5xx, a 429 or a lost connection may go differently the next time. */
const refusal = (error: unknown) => {
  const { status } = apiErrorInfo(error);
  return status !== undefined && !httpFailure(status).retryable;
};

/** Brings a session to rest and deletes it. The budget is lowered first and
 *  also with `--keep`: a session that is left must not be able to spend.
 *  `left` is the environment of a session that had ended and whose delete
 *  was refused: the session stays, and nothing can be done about it. */
async function removeSession(id: string, label: string): Promise<{ ok: boolean; left?: string }> {
  const rest = await quiesce(client, id, { interrupt: true, log });
  const t = rest.totals;
  if (t && (t.list_cost_cents || t.active_seconds || t.output_tokens))
    console.log(`      ${label}: list cost ${usd(t.list_cost_cents)}${rest.costReported ? "" : " (not reported)"}, ${t.active_seconds} active seconds, ` +
      `${t.input_tokens} input tokens, ${t.cache_read_tokens} read from cache, ${t.cache_write_5m_tokens + t.cache_write_1h_tokens} written to cache, ` +
      `${t.output_tokens} output tokens, ${t.web_search_requests} web search(es)`);
  const capped = rest.lowered ? "it cannot spend more" : "its budget was NOT lowered";
  let outcome = rest.status === "deleted" ? "already gone" : keep ? `kept, ${capped}` : "";
  let left: string | undefined;
  // A session that is still stopping, or has a workflow run open, refuses.
  for (let tries = 1; !outcome; tries++) {
    try {
      await client.beta.sessions.delete(id);
      outcome = "deleted";
    } catch (error) {
      if (apiErrorInfo(error).status === 404) outcome = "already gone";
      else {
        // An archived session has ended and nothing starts it again. Whether
        // one can be deleted is in no document, so a refusal is reported and
        // not tried again: `--cleanup` could do no more about it. A delete
        // that failed in another way is tried again like any other.
        const over = refusal(error) ? await ended(id) : undefined;
        if (over) {
          left = over.environment_id;
          outcome = `left archived or terminated (its delete was refused: ${describe(error)})`;
        }
        else if (tries >= 6) outcome = `NOT deleted (${describe(error)}); ${capped}`;
        else await sleep(5_000);
      }
    }
  }
  console.log(`cleanup: session ${id} (${label}) ${outcome}`);
  return { ok: !outcome.includes("NOT"), left };
}

async function cleanup() {
  // `again`: whether something is left that another run could still remove.
  let clean = true, again = false;
  const failed = (retry: boolean) => {
    clean = false;
    again ||= retry;
  };
  // The sessions that stay for good, counted by the environment each one is
  // in. An environment is deleted "only if no sessions reference it" (public
  // documentation), so such an environment may have to stay with them.
  const held = new Map<string, number>();
  for (const [id, label] of made.sessions) {
    const { ok, left } = await removeSession(id, label);
    if (!ok) failed(true);
    if (left !== undefined) held.set(left, (held.get(left) ?? 0) + 1);
  }
  let heldEnvironments = 0;
  type Labelled = { metadata?: Record<string, string> | null };
  const remove = async (kind: string, id: string, done: string, read: () => Promise<Labelled>, run: () => Promise<unknown>) => {
    if (keep) return console.log(`cleanup: ${kind} ${id} kept`);
    let labelled = false;
    try {
      // Read from the resource itself, however its id got here: nothing
      // without this script's label is removed, so never one of the bot's.
      if ((await read()).metadata?.app !== APP) {
        // Not a case for `--cleanup`, which would not remove it either.
        failed(false);
        return console.log(`cleanup: ${kind} ${id} NOT ${done}: it does not carry metadata.app = ${APP}`);
      }
      labelled = true;
      await run();
      console.log(`cleanup: ${kind} ${id} ${done}`);
    } catch (error) {
      if (apiErrorInfo(error).status === 404) return console.log(`cleanup: ${kind} ${id} already gone`);
      // Refused on behalf of a session that stays: the next run would be
      // refused the same way, so this is reported and is not a failure.
      if (kind === "environment" && labelled && held.has(id) && refusal(error)) {
        heldEnvironments++;
        return console.log(`cleanup: environment ${id} left: ${held.get(id)} session(s) that were left still refer to it (its delete was refused: ${describe(error)})`);
      }
      failed(true);
      console.log(`cleanup: ${kind} ${id} NOT ${done} (${describe(error)})`);
    }
  };
  for (const id of made.environments)
    await remove("environment", id, "deleted", () => client.beta.environments.retrieve(id), () => client.beta.environments.delete(id));
  // Agents have no delete.
  for (const id of made.agents)
    await remove("agent", id, "archived", () => client.beta.agents.retrieve(id), () => client.beta.agents.archive(id));
  const count = made.sessions.size + made.environments.size + made.agents.size;
  const leftSessions = [...held.values()].reduce((sum, n) => sum + n, 0);
  step("cleanup", clean, !clean ? `something is left: see the lines above${again ? ", and run again with --cleanup" : ""}`
    : !count ? "nothing to remove"
    : keep ? "everything kept on request; the sessions were brought to rest"
    : "sessions and environments deleted, agents archived" +
      (!leftSessions ? "" : `; ${leftSessions} session(s) that had ended could not be deleted and were left` +
        (!heldEnvironments ? "" : `, and with them ${heldEnvironments} environment(s) they still refer to; --cleanup would leave these again`)));
}

try {
  if (option("--cleanup")) await leftovers();
  else {
    if (!option("--bot-only")) {
      await plain();
      if (option("--ultra")) await ultra();
    }
    if (option("--bot") || option("--bot-only")) await bot();
  }
} catch (error) {
  step("run", false, stop.signal.aborted ? "stopped by a signal" : describe(error));
} finally {
  await cleanup().catch((error) => step("cleanup", false, describe(error)));
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
}
const frames = [...wire.frames.values()].reduce((sum, n) => sum + n, 0);
if (frames || wire.comments)
  note("the event stream", `${frames} frames with an SSE event name (${tally(wire.frames)}), ${wire.comments} comment line(s); events by their type: ${tally(wire.events)}`);
const failures = steps.filter((s) => !s.ok).length;
console.log(`${wire.requests} requests, ${steps.length - failures}/${steps.length} steps passed`);
process.exit(failures ? 1 : 0);

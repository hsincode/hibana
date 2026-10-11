// Manual check of the Anthropic Workspace path against the real Managed Agents
// API (#76):
//   cd apps/bot && bun run workspace-smoke               Haiku 5.5, a plain session
//   cd apps/bot && bun run workspace-smoke --ultra       also a Haiku Ultra session (workflow runs)
//   cd apps/bot && bun run workspace-smoke --budget 0.5  each session's budget in US dollars (default 1)
//   cd apps/bot && bun run workspace-smoke --keep        leave what it created (sessions are still brought to rest)
//   cd apps/bot && bun run workspace-smoke --cleanup     only remove what earlier runs left behind
// It needs ANTHROPIC_WORKSPACE_API_KEY and is billed: model tokens, the time
// the sessions run, and web searches. So it is not part of `make ci`, and
// running it needs the owner's approval first (#76). A session is created
// with the budget given, and before every turn the script reads from the
// session what it has used, so a turn is allowed at most what is left of that
// budget. The whole run stops after 15 minutes.
//
// It prints what each step observed and what the sessions used. Message text
// is not printed, and of an error only its status, its codes and the field
// names its message mentions. Custom tools are not executed: their results
// are supplied here, so no Discord access is needed.
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
import type { WorkspaceVariant } from "../claude/select";
import { loadConfig, type Selection } from "../config";
import { sleep } from "../io";
import { ProviderError } from "../llm-errors";
import { Runtime } from "../runtime";
import definitions from "../tools/definitions.json";
import type { Context, ToolDef } from "../types";
import { apiErrorInfo, createWorkspaceClient, workspaceBaseUrl } from "./client";
import { openRunsNote, userContent, workspaceContextBlock, workspaceSystem } from "./prompt";
import { budgetLimit, cents, multiagentMismatch, ULTRA_MULTIAGENT, WorkspaceResources } from "./resources";
import { budgetNotRaised, quiesce, runTurn, type TurnResult } from "./runner";
import { outputFiles, pickOutput, WORKSPACE_OUTPUTS, workspaceSurface, workspaceToolParams } from "./tools";
import type { RawEvent, WorkspaceCall, WorkspaceResult } from "./types";
import { sessionTotals, totalsMax, type WorkspaceTotals } from "./usage";

const APP = "hibana-smoke";
// The default model here, and the only one Haiku Ultra runs on.
const MODEL = WORKSPACE_ULTRA_MODEL;
const RUN_LIMIT_MS = 15 * 60_000;
const TURN_MS = 3 * 60_000;
const WORKFLOW_TURN_MS = 6 * 60_000;
// What an ordinary step may add to its session, in cents. Every turn is also
// held to what is left of the session's budget.
const TURN_CENTS = 20;
// How long the interrupted command is left running first, to see what the
// stream carries while nothing happens.
const QUIET_MS = 20_000;

const argv = process.argv.slice(2);
function usage(problem: string): never {
  console.error(`${problem}\nusage: bun run workspace-smoke [--ultra] [--budget <usd>] [--keep]\n       bun run workspace-smoke --cleanup`);
  process.exit(2);
}
// Checked strictly: a mistyped option must not start a billed run.
for (let i = 0; i < argv.length; i++) {
  if (!["--ultra", "--budget", "--keep", "--cleanup"].includes(argv[i]!)) usage(`unknown argument: ${argv[i]}`);
  if (argv[i] === "--budget") i++;
}
const option = (name: string) => argv.includes(name);
if (option("--cleanup") && argv.length > 1) usage("--cleanup takes no other option");
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
// by SSE event name, its comment lines and its longest silence.
// `echoes`: the `user.message` frames, by whether they carry a `processed_at`.
// The runner never passes a turn's own message on, so they are counted here.
const wire = {
  requests: 0, frames: new Map<string, number>(), comments: 0, last: Date.now(), silence: 0,
  echoes: { queued: 0, processed: 0 },
};
function watchStream(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  let rest = "", frame = "";
  wire.last = Date.now();
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      wire.silence = Math.max(wire.silence, Date.now() - wire.last);
      wire.last = Date.now();
      const lines = (rest + decoder.decode(chunk, { stream: true })).split(/\r?\n/);
      rest = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith(":")) wire.comments++;
        else if (line.startsWith("event:")) bump(wire.frames, (frame = line.slice(6).trim()).slice(0, 48));
        // Inside the message's own text the quotes would be escaped.
        else if (line.startsWith("data:") && frame === "user.message")
          wire.echoes[/"processed_at"\s*:\s*"/.test(line) ? "processed" : "queued"]++;
        else if (!line) frame = "";
      }
      controller.enqueue(chunk);
    },
  }));
}
// The bot's own classes report an API error as a fixed classification, which
// has no place for the field names the error's message mentions. The last
// refusal is kept as it came over the wire, so `describe` can still name them.
let refused: { status: number; fields: string } | undefined;
const counted = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  wire.requests++;
  const response = await fetch(input, init);
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!response.ok) {
    const body = await response.clone().json().catch(() => undefined) as { error?: { message?: unknown } } | undefined;
    refused = { status: response.status, fields: mentioned(typeof body?.error?.message === "string" ? body.error.message : "") };
  }
  if (!response.ok || !response.body || !new URL(url).pathname.endsWith("/events/stream")) return response;
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
const codes = { memory: code(), file: code(), late: code(), tool: code(), again: code(), echo: code() };
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
      // An observation only: the turn goes on whether or not it can be made.
      if (mark.eventId) seen.sent = await sentMessage(session.id, mark.eventId).catch(() => undefined);
    },
    baseline: session.totals,
    knownRuns: session.openRuns,
    limits: { idleMs: config.llmStreamIdleMs, reconnects: config.llmStreamRetries, timeoutMs },
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
  const first = await attempt("reply", async () => {
    const result = await turn(session, `Remember this code for later: ${codes.memory}. For now, reply with the single word: ready`,
      { context: await workspaceContextBlock(runtime, ctx) });
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
      { timeoutMs: WORKFLOW_TURN_MS, allowCents: 40, answer: (call) => (call.name === "list_sites" ? { sites: [] } : undefined) });
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

/** Whether a session has ended for good: archived, or terminated. */
const ended = (id: string) =>
  client.beta.sessions.retrieve(id).then((session) => !!session.archived_at || session.status === "terminated", () => false);
// Sessions that had ended and whose delete was refused.
let leftEnded = 0;

/** Brings a session to rest and deletes it. The budget is lowered first and
 *  also with `--keep`: a session that is left must not be able to spend. */
async function removeSession(id: string, label: string): Promise<boolean> {
  const rest = await quiesce(client, id, { interrupt: true, log });
  const t = rest.totals;
  if (t && (t.list_cost_cents || t.active_seconds || t.output_tokens))
    console.log(`      ${label}: list cost ${usd(t.list_cost_cents)}${rest.costReported ? "" : " (not reported)"}, ${t.active_seconds} active seconds, ` +
      `${t.input_tokens} input tokens, ${t.cache_read_tokens} read from cache, ${t.cache_write_5m_tokens + t.cache_write_1h_tokens} written to cache, ` +
      `${t.output_tokens} output tokens, ${t.web_search_requests} web search(es)`);
  const capped = rest.lowered ? "it cannot spend more" : "its budget was NOT lowered";
  let outcome = rest.status === "deleted" ? "already gone" : keep ? `kept, ${capped}` : "";
  // A session that is still stopping, or has a workflow run open, refuses.
  for (let tries = 1; !outcome; tries++) {
    try {
      await client.beta.sessions.delete(id);
      outcome = "deleted";
    } catch (error) {
      const info = apiErrorInfo(error);
      if (info.status === 404) outcome = "already gone";
      // An archived session has ended and nothing starts it again. Whether
      // one can be deleted is in no document, so a refusal is reported and
      // not tried again: `--cleanup` could do no more about it.
      else if (await ended(id)) {
        leftEnded++;
        outcome = `left archived or terminated (its delete was refused: ${describe(error)})`;
      }
      else if (tries >= 6) outcome = `NOT deleted (${describe(error)}); ${capped}`;
      else await sleep(5_000);
    }
  }
  console.log(`cleanup: session ${id} (${label}) ${outcome}`);
  return !outcome.includes("NOT");
}

async function cleanup() {
  let clean = true;
  for (const [id, label] of made.sessions) clean = await removeSession(id, label) && clean;
  type Labelled = { metadata?: Record<string, string> | null };
  const remove = async (kind: string, id: string, done: string, read: () => Promise<Labelled>, run: () => Promise<unknown>) => {
    if (keep) return console.log(`cleanup: ${kind} ${id} kept`);
    try {
      // Read from the resource itself, however its id got here: nothing
      // without this script's label is removed, so never one of the bot's.
      if ((await read()).metadata?.app !== APP) {
        clean = false;
        return console.log(`cleanup: ${kind} ${id} NOT ${done}: it does not carry metadata.app = ${APP}`);
      }
      await run();
      console.log(`cleanup: ${kind} ${id} ${done}`);
    } catch (error) {
      const gone = apiErrorInfo(error).status === 404;
      clean &&= gone;
      console.log(`cleanup: ${kind} ${id} ${gone ? "already gone" : `NOT ${done} (${describe(error)})`}`);
    }
  };
  for (const id of made.environments)
    await remove("environment", id, "deleted", () => client.beta.environments.retrieve(id), () => client.beta.environments.delete(id));
  // Agents have no delete.
  for (const id of made.agents)
    await remove("agent", id, "archived", () => client.beta.agents.retrieve(id), () => client.beta.agents.archive(id));
  const count = made.sessions.size + made.environments.size + made.agents.size;
  step("cleanup", clean, !clean ? "something is left: see the lines above, and run again with --cleanup"
    : !count ? "nothing to remove"
    : keep ? "everything kept on request; the sessions were brought to rest"
    : "sessions and environments deleted, agents archived" +
      (leftEnded ? `; ${leftEnded} session(s) that had ended could not be deleted and were left` : ""));
}

try {
  if (option("--cleanup")) await leftovers();
  else {
    await plain();
    if (option("--ultra")) await ultra();
  }
} catch (error) {
  step("run", false, stop.signal.aborted ? "stopped by a signal" : describe(error));
} finally {
  await cleanup().catch((error) => step("cleanup", false, describe(error)));
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
}
const frames = [...wire.frames.values()].reduce((sum, n) => sum + n, 0);
if (frames || wire.comments)
  note("the event stream", `${frames} frames with an SSE event name (${tally(wire.frames)}), ${wire.comments} comment line(s)`);
const failures = steps.filter((s) => !s.ok).length;
console.log(`${wire.requests} requests, ${steps.length - failures}/${steps.length} steps passed`);
process.exit(failures ? 1 : 0);

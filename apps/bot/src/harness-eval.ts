// Manual comparison of the two harnesses on questions people asked in
// production (#69):
//   cd apps/bot && bun run harness-eval run --limit 3 [--budget 5] [--run trial]
//   cd apps/bot && bun run harness-eval review <run>
//   cd apps/bot && bun run harness-eval summary <run> [verdicts.json]
// The questions come from the bot's stored conversations
// (`export-conversations.ts`). `run` replays each selected one twice, once per
// harness, on Anthropic's API with the model and effort the production turn
// used. The conversation before it is given to both as text: what was asked
// and answered, without the tool calls in between.
// Before each measured turn a short turn on the same harness and model puts
// the part every conversation shares (system prompt, tool definitions) into
// Anthropic's cache, so every case is measured warm; what a cold start costs
// is reported from those warm-ups (#69, the owner's decision). The LLM, the Docker sandbox and Anthropic's web tools are real, so
// it is billed and is not part of `make ci`. Discord, settings, publishing and
// every other integration answer with one fixed error in both arms, and a
// question to the user is answered with "nobody is here".
// The questions and replies are people's messages. They are read from and
// written to .local/harness-eval/ (gitignored); nothing here prints them, and
// `review` writes a local page, not a published one.
import { appendFile, chmod, copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { Writable } from "node:stream";
import { ANTHROPIC_PRICES, anthropicCost } from "@hibana/shared/catalog";
import pino from "pino";
import { Hibana } from "./bot";
import { contextBlock, contextMessage } from "./claude/prompt";
import { conversationKey } from "./claude/select";
import { loadConfig } from "./config";
import type { LlmHooks, RequestRecord } from "./llm";
import { splitMessage } from "./triggers";
import { emptyUsage, type Context, type Json, type Message } from "./types";

export type Arm = "codex" | "claude";
/** One production turn, as `export-conversations.ts` writes it. */
export type Case = {
  id: string; at: number; scope: "guild" | "dm"; channel: string;
  provider: string | null; model: string | null; effort: string | null;
  /** Earlier turns of the same conversation, text only. */
  history: { role: "user" | "assistant"; content: string }[];
  /** The stored conversation no longer starts at its first turn. */
  summarized: boolean; trimmed: boolean;
  /** An earlier turn of the conversation called tools. */
  earlier_tools: boolean;
  prompt: string;
  /** Messages the person added while the turn was running. */
  extra_messages: number;
  reply: string | null;
  /** Tools the production turn called. */
  tools: string[];
  production: { latency_ms: number | null } | null;
};
export type ArmResult = {
  case: string; arm: Arm; first: boolean; model: string; effort: string | null; scope: Case["scope"];
  /** Wall time of the turn, from the message arriving to the final reply. */
  ms: number;
  requests: number; input: number; cache_read: number; cache_write: number; output: number;
  /** A search is billed per request and is not in `cost`, which is tokens
   *  only; `billed` adds it. A fetch has no fee of its own. */
  searches: number; fetches: number;
  cost: number; models: string[];
  tools: Record<string, number>; blocked: string[]; asked: boolean; status_messages: number;
  /** Names of the files the turn delivered. Copies are kept beside the results. */
  files: string[];
  /** Requests that were sent again after the provider had started answering:
   *  the lost attempt may have been billed and is not in `cost`. */
  retries: number;
  /** Optional request features the API refused during this turn. */
  rejected: string[];
  error: string | null; reply: string;
  /** The failure happened before the turn began (configuration, sandbox). */
  setup_failed: boolean;
  /** Written by `run`: the code and the invocation that produced the row. */
  commit?: string; invoked?: string;
};
export type Verdict = "left" | "right" | "same" | "skip";

const ROOT = join(import.meta.dir, "../../../.local/harness-eval");
// Each replay's bot keeps its data here while it runs: the conversation is
// written there as a checkpoint, so it stays under .local/ like the rest.
const TMP = join(ROOT, "tmp");
// The line the bot appends to a Discord message (`Hibana.onMessage`).
const META = /\n\n\[author: (.*); user_id: \d+; channel_id: \d+; message_id: \d+\]/;
const IDS = { user: "20000000000000002", channel: "20000000000000001", guild: "20000000000000003", bot: "20000000000000004" };
// Tools that run for real: they stay inside the turn's own workspace and data
// directory and end with the turn. Everything else would act on Discord,
// settings or an outside service that the replay does not have, or (the video
// renderer) start a container that outlives the turn and gets in the way of
// the next one. `send_file` is answered by the replay itself.
const REAL = new Set([
  "Bash", "Read", "Edit", "Write", "Glob", "Grep", "Skill", "Agent",
  "shell_command", "apply_patch", "update_plan", "view_image", "tool_search",
  "bash", "read_file", "write_file", "write_files", "edit_file", "list_files", "grep_files",
  "download_file", "download_media", "playwright_cli",
  "list_skills", "use_skill", "read_skill_file", "get_bot_settings", "get_user_context",
]);
const ASKS = new Set(["AskUserQuestion", "request_user_input"]);
const UNAVAILABLE = "This tool is not available in this replay environment.";
const NO_ANSWER = "Nobody is available to answer in this replay. Continue with your best judgment and state the assumption you made.";

/** Why a production turn cannot be replayed, or null. */
export function exclusion(c: Case): string | null {
  if (!c.prompt.replace(META, "").trim()) return "no message text";
  // The files are on Discord under the real message, out of the replay's reach.
  if (/\nAttachments: \{/.test(c.prompt)) return "has attachments";
  if (!c.model || !ANTHROPIC_PRICES[c.model]) return "model is unknown or not on Anthropic's API";
  // A message sent into a running turn steered it; one question cannot stand for both.
  if (c.extra_messages > 0) return "more than one message in the turn";
  // The earlier conversation is replayed as text. Files an earlier turn made
  // and what its tools returned are not in it, so a follow-up that builds on
  // them would be asked about things the replay does not have.
  if (c.earlier_tools) return "an earlier turn used tools";
  return null;
}

function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle<T>(items: T[], next: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** The turns to replay, in a seeded random order so that a limit is a sample
 *  of everything stored and a rerun picks the same ones. `perModel` takes
 *  that many of each model first, for a trial that prices every model. */
export function select(cases: Case[], options: { seed: number; limit?: number; perModel?: number; ids?: string[] }) {
  const excluded: Record<string, number> = {};
  const eligible: Case[] = [];
  for (const c of [...cases].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))) {
    const reason = exclusion(c);
    if (reason) excluded[reason] = (excluded[reason] ?? 0) + 1;
    else eligible.push(c);
  }
  let ordered = options.ids ? eligible.filter((c) => options.ids!.includes(c.id)) : shuffle(eligible, random(options.seed));
  if (options.perModel) {
    const taken = new Map<string, number>();
    ordered = ordered.filter((c) => {
      const n = taken.get(c.model!) ?? 0;
      taken.set(c.model!, n + 1);
      return n < options.perModel!;
    });
  }
  return { chosen: options.limit ? ordered.slice(0, options.limit) : ordered, eligible: eligible.length, excluded };
}

/** The message as the replay sends it: the same text, with the ids of the
 *  replay's own user and channel in place of the real ones. */
export function replayPrompt(prompt: string) {
  return prompt.replace(META, (_, author: string) => `\n\n[author: ${author}; user_id: ${IDS.user}; channel_id: ${IDS.channel}; message_id: 1]`);
}

export function totals(records: RequestRecord[]) {
  const sum = (pick: (r: RequestRecord) => number | undefined) => records.reduce((total, r) => total + (pick(r) ?? 0), 0);
  return {
    requests: records.length,
    input: sum((r) => r.usage.prompt_tokens), cache_read: sum((r) => r.usage.cached_tokens),
    cache_write: sum((r) => r.usage.cache_write_tokens), output: sum((r) => r.usage.completion_tokens),
    searches: sum((r) => r.usage_detail?.web_search_requests), fetches: sum((r) => r.usage_detail?.web_fetch_requests),
    cost: sum((r) => anthropicCost(r.model, {
      prompt: r.usage.prompt_tokens, cache_read: r.usage.cached_tokens,
      cache_write: r.usage.cache_write_tokens ?? 0, output: r.usage.completion_tokens,
    })),
    models: [...new Set(records.map((r) => r.model))],
  };
}

/** Which arm is on the left of each pair, and the order the pairs are shown
 *  in. Only cases that have both arms are paired. A pair that was dealt before
 *  keeps its side and its place: verdicts given on the earlier page name
 *  "left" and "right", and would be credited to the wrong harness otherwise. */
export function blind(results: ArmResult[], seed: number, dealt: { id: string; left: Arm }[] = []) {
  const arms = new Map<string, Set<Arm>>();
  for (const r of results) arms.set(r.case, (arms.get(r.case) ?? new Set()).add(r.arm));
  const next = random(seed);
  const known = new Set(dealt.map((d) => d.id));
  const fresh = shuffle([...arms].filter(([id, set]) => set.size === 2 && !known.has(id)).map(([id]) => id).sort(), next);
  return [...dealt, ...fresh.map((id) => ({ id, left: (next() < 0.5 ? "claude" : "codex") as Arm }))];
}

const quantile = (values: number[], q: number) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (sorted.length - 1) * q;
  const low = Math.floor(at);
  return sorted[low]! + (sorted[Math.min(low + 1, sorted.length - 1)]! - sorted[low]!) * (at - low);
};
const mean = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);

/** The owner's acceptance criteria (#69, 2026-10-11), decided before the run. */
export const LIMIT = 1.2;
/** USD per web search, billed on top of the tokens; a web fetch has no fee of
 *  its own. Source: https://platform.claude.com/docs/en/about-claude/pricing
 *  ("$10 per 1,000 searches"), read 2026-10-11. The shared price table has no
 *  row for it, so a row's `cost` is tokens only and the fee is added here. */
export const SEARCH_USD = 0.01;
/** What a turn cost: its tokens and its searches. */
export const billed = (r: ArmResult) => r.cost + r.searches * SEARCH_USD;

/** Time and cost are compared over the cases both arms finished; a failure is
 *  counted and left out of them, so one arm failing fast does not look fast. */
export function summarize(
  results: ArmResult[],
  review?: { key: { id: string; left: Arm }[]; verdicts: Record<string, Verdict> },
  warmups: ArmResult[] = [],
) {
  const by = new Map<string, Partial<Record<Arm, ArmResult>>>();
  for (const r of results) by.set(r.case, { ...by.get(r.case), [r.arm]: r });
  const pairs = [...by.values()].filter((p): p is Record<Arm, ArmResult> => Boolean(p.codex && p.claude));
  const both = pairs.filter((p) => !p.codex.error && !p.claude.error);
  const arm = (name: Arm) => {
    const done = both.map((p) => p[name]);
    // A warm-up is one request made of the shared part and a few words, so its
    // input is the size of that part; written cold, it is billed at the write price.
    const shared: Record<string, { tokens: number; cold_write_cost: number | null }> = {};
    for (const w of warmups.filter((w) => w.arm === name && !w.error && w.requests === 1)) {
      const price = ANTHROPIC_PRICES[w.model];
      shared[w.model] = { tokens: w.input, cold_write_cost: price ? (w.input * price.cache_write_1h) / 1_000_000 : null };
    }
    return {
      failed: pairs.filter((p) => p[name].error).length,
      seconds: { median: quantile(done.map((r) => r.ms / 1000), 0.5), mean: mean(done.map((r) => r.ms / 1000)), p90: quantile(done.map((r) => r.ms / 1000), 0.9) },
      // Tokens and web searches together.
      cost: { total: done.reduce((t, r) => t + billed(r), 0), mean: mean(done.map(billed)), median: quantile(done.map(billed), 0.5) },
      requests: mean(done.map((r) => r.requests)), searches: done.reduce((t, r) => t + r.searches, 0),
      shared_prefix: shared,
    };
  };
  const quality = review && { claude: 0, codex: 0, same: 0, skipped: 0, unjudged: 0 };
  for (const { id, left } of review?.key ?? []) {
    const verdict = review!.verdicts[id];
    if (!verdict) quality!.unjudged++;
    else if (verdict === "skip") quality!.skipped++;
    else if (verdict === "same") quality!.same++;
    else quality![verdict === "left" ? left : left === "claude" ? "codex" : "claude"]++;
  }
  const codex = arm("codex"), claude = arm("claude");
  // Per case, claude ÷ codex: below 1 means the Claude harness was faster or cheaper.
  const ratio = {
    seconds_median: quantile(both.map((p) => p.claude.ms / p.codex.ms), 0.5),
    cost_median: quantile(both.filter((p) => billed(p.codex) > 0).map((p) => billed(p.claude) / billed(p.codex)), 0.5),
    claude_faster: both.filter((p) => p.claude.ms < p.codex.ms).length,
    claude_cheaper: both.filter((p) => billed(p.claude) < billed(p.codex)).length,
  };
  return {
    pairs: pairs.length, both_finished: both.length, codex, claude, ratio,
    ...(quality && {
      quality,
      criteria: {
        // Judged only once every pair has a verdict.
        quality: quality.unjudged ? null : quality.claude + quality.same >= quality.codex,
        cost: ratio.cost_median === null ? null : ratio.cost_median <= LIMIT,
        time: ratio.seconds_median === null ? null : ratio.seconds_median <= LIMIT,
        failures: claude.failed <= codex.failed,
      },
    }),
  };
}

/** One stored turn per earlier question, each with the answers that followed it. */
export function earlierTurns(history: Case["history"]): Message[][] {
  const turns: Message[][] = [];
  for (const item of history) {
    if (item.role === "user" || !turns.length) turns.push([]);
    turns.at(-1)!.push(item.role === "user" ? { role: "user", content: replayPrompt(item.content), turnStart: true } : { role: "assistant", content: item.content });
  }
  return turns;
}

/** The turn sent before a measured one: same harness, model, effort and kind
 *  of channel, so its request starts with the same bytes, and nothing else. */
export const warmUp = (c: Case): Case => ({
  ...c, id: `warm-${c.id}`, history: [], summarized: false, trimmed: false, earlier_tools: false,
  prompt: "Reply with the single word: ok", extra_messages: 0, reply: null, tools: [], production: null,
});

export type ReplayOptions = {
  image?: string; perArm: number; minutes: number;
  /** Where the files a turn delivers are kept, as `<dir>/<case>/<arm>/`. */
  files?: string;
  /** Stands in for the API: given the request's messages, the reply text (or a
   *  throw). No sandbox and no network are used with it. */
  fake?: (messages: Message[]) => string;
};
/** The conversation as the model is sent it: questions and answers, without the harness's own preamble. */
export const dryReply = (messages: Message[]) =>
  `dry run: ${messages.filter((m) => m.role === "assistant" || (m.role === "user" && m.turnStart)).length} messages`;

/** One question through one harness: a new bot with its own data directory,
 *  so nothing carries over from another case or the other arm. */
export async function replay(c: Case, arm: Arm, first: boolean, o: ReplayOptions): Promise<ArmResult> {
  await mkdir(TMP, { recursive: true, mode: 0o700 });
  const data = await mkdtemp(join(TMP, `${c.id}-${arm}-`));
  const records: RequestRecord[] = [];
  const tools: Record<string, number> = {};
  const blocked = new Set<string>();
  const files: string[] = [];
  const rejected: string[] = [];
  let asked = false, sends = 0, reply = "", stopped = "", failure = "", ms = 0, retries = 0, setup = true;
  let effort = c.effort;
  let error: string | null = null;
  let bot: Hibana | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The bot reports a failed turn to its log and tells the channel; it does
  // not throw. This keeps what it reported: the failure's class, not the text.
  const log = pino({ level: "error" }, new Writable({
    write(chunk, _encoding, done) {
      try {
        const entry = JSON.parse(String(chunk)) as { failure_code?: string; failure_phase?: string; http_status?: number };
        if (entry.failure_code) failure = `${entry.failure_code} in ${entry.failure_phase}${entry.http_status ? ` (HTTP ${entry.http_status})` : ""}`;
      } catch {}
      done();
    },
  }));
  try {
    // Only what the replay needs: the bot's own .env also names the web API,
    // Jev and other services that a replay must not reach.
    bot = new Hibana(loadConfig({
      PROVIDER: "anthropic", LLM_MODEL: c.model ?? "", LLM_EFFORT: c.effort ?? "",
      ANTHROPIC_API_KEY: o.fake ? "dry-run" : process.env.ANTHROPIC_API_KEY, ANTHROPIC_HARNESS: arm,
      HIBANA_DATA_DIR: data, RUNTIME_STATE_PATH: "", LOG_DIR: "",
      ...(o.image && { SANDBOX_IMAGE: o.image }), ...(o.fake && { SANDBOX_ENABLED: "false", SKILLS_ENABLED: "false" }),
    }), log);
    const running = bot;
    // What was sent, which is the default when the log had no effort.
    effort = bot.config.selection.effort ?? null;
    const stop = (reason: string) => { if (!stopped) { stopped = reason; void running.close().catch(() => {}); } };
    if (o.fake) {
      const fake = o.fake;
      bot.llm.complete = (async (_selection: unknown, messages: Message[]) => ({
        message: { role: "assistant", content: fake(messages) }, usage: emptyUsage(), incomplete: false,
      })) as typeof bot.llm.complete;
    } else {
      await bot.tools.sandbox.probe();
      if (!bot.tools.sandbox.available) throw new Error(`Sandbox image ${bot.config.sandboxImage} is not available`);
      // The client's hooks are how the bot itself logs each request. They are
      // read from this object at call time, so replacing its members is enough.
      const hooks = (bot.llm as unknown as { hooks: LlmHooks }).hooks;
      const { onCompletion, onRetry, onFeatureDisabled } = hooks;
      hooks.onCompletion = (record) => {
        records.push(record);
        onCompletion?.(record);
        const sum = totals(records);
        if (sum.cost + sum.searches * SEARCH_USD > o.perArm) stop(`stopped: over $${o.perArm} for one turn`);
      };
      hooks.onRetry = (notice) => { retries++; onRetry?.(notice); };
      hooks.onFeatureDisabled = (feature) => { rejected.push(String(feature)); onFeatureDisabled?.(feature); };
    }
    // Delivery has no Discord to go to. The file is checked the way the bot
    // checks it and kept for the reviewer, and the model is told it was sent,
    // as it would be in production.
    const deliver = async (args: Json, ctx: Context) => {
      const path = await running.tools.sandbox.path(ctx, String(args.path));
      const stat = await lstat(path);
      if (!stat.isFile() || stat.size > 25 * 1024 * 1024) throw new Error("Attachment must be a regular file under 25 MiB");
      const name = basename(String(args.filename ?? path));
      if (o.files) {
        const dir = join(o.files, c.id, arm);
        await mkdir(dir, { recursive: true, mode: 0o700 });
        await copyFile(path, join(dir, `${files.length + 1}-${name}`));
      }
      files.push(name);
      ctx.delivered = true;
      return { id: String(900 + files.length), channel_id: ctx.channelId, attachments: [{ filename: name, size: stat.size }] };
    };
    const execute = bot.tools.execute.bind(bot.tools);
    bot.tools.execute = async (name, args, ctx) => {
      const internal = name.replace(/^mcp__[^_]+__/, "");
      tools[name] = (tools[name] ?? 0) + 1;
      if (ASKS.has(internal)) { asked = true; throw new Error(NO_ANSWER); }
      if (internal === "send_file") return deliver(args, ctx);
      if (!REAL.has(internal)) { blocked.add(name); throw new Error(UNAVAILABLE); }
      return execute(name, args, ctx);
    };
    // The one channel the turn lives in. The bot checks that the channel is
    // in the turn's server and that the author can read it before it sends.
    bot.client.channels.fetch = (async () => ({
      id: IDS.channel, isSendable: () => true, sendTyping: async () => {},
      send: async () => { sends++; return { id: String(100 + sends), edit: async () => {}, delete: async () => {} }; },
      ...(c.scope === "guild" && {
        guildId: IDS.guild, guild: { members: { fetch: async () => ({}) } }, permissionsFor: () => ({ has: () => true }),
      }),
    })) as never;
    // The role a paying member has: every Anthropic model is selectable.
    bot.runtime.snapshot.user_roles[IDS.user] = "premium";
    const ctx: Context = {
      channelId: IDS.channel, userId: IDS.user, botId: IDS.bot, thread: false, depth: 0, delivered: false,
      ...(c.scope === "guild" && { guildId: IDS.guild }),
    };
    if (c.history.length) {
      // The earlier conversation, stored the way the bot stores a finished
      // turn, under the key this turn will look it up by.
      const key = conversationKey(bot.runtime.resolve(ctx.guildId, ctx.userId).selection, arm);
      bot.history.get(ctx.channelId, ctx.guildId, key, false, 0, arm === "claude");
      const turns = earlierTurns(c.history);
      if (arm === "claude") {
        // A conversation on this harness opens with the block that says who
        // the bot is here, and a later turn adds it only when it is missing.
        // Without it here the block would land after the whole conversation.
        const skills = bot.config.skillsEnabled ? await bot.tools.skillCatalog(ctx) : "";
        turns[0]!.unshift(contextMessage(await contextBlock(bot.runtime, ctx, skills), [])!);
      }
      for (const turn of turns) bot.history.put(ctx.channelId, turn, emptyUsage(), arm === "claude");
    }
    timer = setTimeout(() => stop(`stopped: over ${o.minutes} minutes`), o.minutes * 60_000);
    setup = false;
    const started = performance.now();
    try { reply = await bot.respond(replayPrompt(c.prompt), ctx); }
    finally { ms = Math.round(performance.now() - started); }
    // A turn that fails comes back empty: the bot has caught the error and
    // sent the channel a notice. A turn that answers never returns "".
    if (!reply) error = stopped || `the turn failed: ${failure || "no reply"}`;
  } catch (e) {
    error = stopped || (e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(timer);
    await bot?.close().catch(() => {});
    await rm(data, { recursive: true, force: true }).catch(() => {});
  }
  return {
    case: c.id, arm, first, model: c.model ?? "", effort, scope: c.scope, ms,
    ...totals(records), tools, blocked: [...blocked], asked,
    // What the channel was sent besides the reply (which goes out in pieces of
    // 1,900 characters) and besides the notice of a failed turn.
    status_messages: Math.max(0, sends - (reply ? splitMessage(reply).length : setup ? 0 : 1)),
    files, retries, rejected, error, reply, setup_failed: Boolean(error) && setup,
  };
}

const lines = async <T>(file: string): Promise<T[]> =>
  (await readFile(file, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as T);
const flag = (name: string) => {
  if (process.argv.some((a) => a.startsWith(`--${name}=`))) throw new Error(`Write --${name} VALUE, not --${name}=VALUE`);
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? undefined : process.argv[i + 1];
};
/** A limit that is missing its value or is not a number would otherwise
 *  compare as never reached. */
export function amount(name: string, value: string | undefined, fallback: number): number;
export function amount(name: string, value: string | undefined, fallback?: undefined): number | undefined;
export function amount(name: string, value: string | undefined, fallback?: number) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (value.trim() === "" || !Number.isFinite(n) || n <= 0) throw new Error(`--${name} needs a positive number, got "${value}"`);
  return n;
}
const has = (name: string) => process.argv.includes(`--${name}`);
const usd = (value: number | null) => (value === null ? "-" : `$${value.toFixed(4)}`);

async function run() {
  const dry = has("dry");
  // A dry run's rows are not replays; they go to a run of their own.
  const name = flag("run") ?? (dry ? "dry" : "trial");
  const value = (flagName: string) => { if (has(flagName) && flag(flagName) === undefined) throw new Error(`--${flagName} needs a value`); return flag(flagName); };
  const o = {
    seed: amount("seed", value("seed"), 1), limit: amount("limit", value("limit")),
    perModel: amount("per-model", value("per-model")), ids: value("ids")?.split(","), budget: amount("budget", value("budget"), 5),
    image: value("image"), perArm: amount("per-turn", value("per-turn"), 2), minutes: amount("minutes", value("minutes"), 15),
    warm: !has("no-warm"),
    ...(dry && { fake: dryReply }),
  };
  if (!o.fake && !process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is required");
  const cases = await lines<Case>(join(ROOT, "cases.jsonl"));
  if (!cases.length) throw new Error("No cases: export them first (see export-conversations.ts)");
  const { chosen, eligible, excluded } = select(cases, o);
  console.log(`${cases.length} production turns, ${eligible} replayable, ${chosen.length} selected`);
  const models = new Map<string, number>();
  for (const c of chosen) models.set(`${c.model} ${c.effort ?? "-"}`, (models.get(`${c.model} ${c.effort ?? "-"}`) ?? 0) + 1);
  for (const [model, n] of [...models].sort()) console.log(`  selected ${n}: ${model}`);
  for (const [reason, n] of Object.entries(excluded)) console.log(`  left out ${n}: ${reason}`);
  const dir = join(ROOT, "runs", name);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // What an interrupted run left behind holds conversations.
  await rm(TMP, { recursive: true, force: true });
  const file = join(dir, "results.jsonl");
  const done = await lines<ArmResult & { dry?: boolean }>(file);
  if (done.some((r) => Boolean(r.dry) !== dry)) throw new Error(`Run "${name}" holds ${dry ? "real" : "dry"} rows; give this one another --run name`);
  // The cases are people's messages, whatever the shell's umask made the file.
  await chmod(join(ROOT, "cases.jsonl"), 0o600);
  const stamp = { commit: (await Bun.$`git rev-parse --short HEAD`.text()).trim(), invoked: new Date().toISOString(), ...(dry && { dry }) };
  const image = o.image ?? loadConfig({ PROVIDER: "anthropic", ANTHROPIC_API_KEY: "-", LOG_DIR: "", RUNTIME_STATE_PATH: "" }).sandboxImage;
  await appendFile(join(dir, "meta.jsonl"), JSON.stringify({
    ...stamp,
    // A change to any tracked file, anywhere: the price table and the harness
    // are outside apps/bot. Untracked files are counted apart; a scratch
    // directory is not a change to the code that ran.
    dirty: (await Bun.$`git status --porcelain --untracked-files=no`.text()).trim() !== "",
    untracked: (await Bun.$`git status --porcelain`.text()).split("\n").filter((line) => line.startsWith("??")).length,
    bun: Bun.version, platform: `${process.platform} ${process.arch}`,
    prices: ANTHROPIC_PRICES, ...o, fake: Boolean(o.fake),
    image, image_id: (await Bun.$`docker image inspect ${image} --format {{.Id}}`.nothrow().quiet().text()).trim() || null,
  }) + "\n");
  let spent = done.reduce((total, r) => total + billed(r), 0);
  for (const [i, c] of chosen.entries()) {
    // Alternate which harness goes first, so neither always runs second.
    const order: Arm[] = i % 2 ? ["claude", "codex"] : ["codex", "claude"];
    const todo = order.filter((arm) => !done.some((r) => r.case === c.id && r.arm === arm));
    if (!todo.length) continue;
    // Checked per case, with room for both of its turns at the cap: the
    // budget is then a ceiling, and a pair is never left with one arm, or
    // with one arm held to a smaller cap than the other.
    if (o.budget - spent < todo.length * o.perArm) {
      console.log(`Stopped: ${usd(o.budget - spent)} is left of $${o.budget}, less than ${todo.length} turns at the per-turn cap of $${o.perArm}`);
      return;
    }
    for (const arm of todo) {
      if (o.warm) {
        const warmed = await replay(warmUp(c), arm, false, o);
        // Measuring after a warm-up that did not happen would be a cold turn in disguise.
        if (warmed.error) throw new Error(`The warm-up before case ${c.id} (${arm}) failed: ${warmed.error}`);
        await appendFile(join(dir, "warmups.jsonl"), JSON.stringify({ ...warmed, reply: "", ...stamp }) + "\n", { mode: 0o600 });
        spent += billed(warmed);
        console.log(`  warm-up ${arm.padEnd(6)} ${warmed.model} ${usd(warmed.cost)} input ${warmed.input} (read ${warmed.cache_read}, written ${warmed.cache_write})`);
      }
      const result = await replay(c, arm, arm === order[0], { ...o, files: join(dir, "files") });
      // Nothing was measured: stop instead of recording a failure of the harness.
      if (result.setup_failed) throw new Error(`Could not start the replay: ${result.error}`);
      await appendFile(file, JSON.stringify({ ...result, ...stamp }) + "\n", { mode: 0o600 });
      spent += billed(result);
      const used = Object.entries(result.tools).map(([tool, count]) => `${tool}×${count}`).join(" ");
      console.log(`case ${c.id} (${c.history.length} earlier) ${arm.padEnd(6)} ${result.model} ${result.effort ?? "-"} ${(result.ms / 1000).toFixed(1)}s ${usd(billed(result))} ${result.requests} requests` +
        ` input ${result.input} (read ${result.cache_read}, written ${result.cache_write}) output ${result.output}` +
        `${result.searches ? ` ${result.searches} searches` : ""}${used ? ` [${used}]` : ""}${result.blocked.length ? ` blocked:${result.blocked.length}` : ""}` +
        `${result.files.length ? ` files:${result.files.length}` : ""}${result.retries ? ` retries:${result.retries}` : ""}${result.rejected.length ? ` rejected:${result.rejected.join(",")}` : ""}` +
        `${result.asked ? " asked" : ""}${result.error ? ` FAILED (${result.error.slice(0, 80)})` : ""}`);
    }
  }
  console.log(`Done: ${usd(spent)} in total for run "${name}", warm-ups and web searches included`);
}

type Deal = { id: string; pairs: { id: string; left: Arm }[] };
type Shown = { href: string; name: string };
type Pair = {
  id: string; history: Case["history"]; incomplete: boolean; prompt: string; unavailable: string[]; production: string | null;
  left: string | null; right: string | null; leftFiles: Shown[]; rightFiles: Shown[];
};

/** The judging page: one local file, no network. Text is escaped before it is
 *  rendered, and the data is embedded with `<` escaped so that a reply cannot
 *  close the script element. */
export function reviewPage(data: { run: string; deal: string; pairs: Pair[] }) {
  return PAGE.replace("__DATA__", () => JSON.stringify(data).replace(/</g, "\\u003c"));
}

const PAGE = `<!doctype html>
<html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ハーネスの比較</title>
<style>
:root{color-scheme:light dark;--bg:#fafafa;--card:#fff;--line:#d5d5d5;--text:#1b1b1b;--dim:#666;--pick:#1a6dd6}
@media (prefers-color-scheme:dark){:root{--bg:#161616;--card:#202020;--line:#3a3a3a;--text:#e8e8e8;--dim:#a0a0a0;--pick:#6aa9ff}}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.6 system-ui,sans-serif}
header{position:sticky;top:0;background:var(--bg);border-bottom:1px solid var(--line);padding:10px 16px;display:flex;gap:12px;align-items:center;flex-wrap:wrap}
main{max-width:1400px;margin:0 auto;padding:16px}
section{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:14px;margin-bottom:20px}
.q,.a{white-space:pre-wrap;overflow-wrap:anywhere}
.q{border-left:3px solid var(--line);padding-left:10px;margin:6px 0 12px}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:12px}
@media (max-width:800px){.pair{grid-template-columns:1fr}}
.a{border:1px solid var(--line);border-radius:6px;padding:10px;min-height:3em}
.a code,.a pre{font:13px/1.5 ui-monospace,monospace}
.a pre{overflow:auto;background:var(--bg);padding:8px;border-radius:4px}
.files{margin-top:8px;display:flex;flex-direction:column;gap:8px}
.files img,.files video{max-width:100%;border:1px solid var(--line);border-radius:6px}
h2{font-size:15px;margin:0}h3{font-size:13px;margin:0 0 4px;color:var(--dim)}
.pick{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
button{font:inherit;padding:6px 14px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--text);cursor:pointer}
button.on{border-color:var(--pick);color:var(--pick);font-weight:600}
textarea{width:100%;box-sizing:border-box;margin-top:8px;font:inherit;background:var(--card);color:var(--text);border:1px solid var(--line);border-radius:6px;padding:6px}
details{margin-top:10px;color:var(--dim)}small{color:var(--dim)}
</style>
<header><strong>ハーネスの比較</strong><span id="progress"></span><button id="export">結果を書き出す</button>
<small>左右のどちらが新しいハーネスかは、件ごとに入れ替えてあります。このページは手元のファイルで、質問と返答は外に送りません。</small></header>
<main id="list"></main>
<script>
const DATA = __DATA__;
const key = "harness-eval:" + DATA.run + ":" + DATA.deal;
const state = JSON.parse(localStorage.getItem(key) || '{"verdicts":{},"notes":{}}');
const save = () => { localStorage.setItem(key, JSON.stringify(state)); progress(); };
const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// Enough of Discord's markdown to judge a reply as it would be read.
const render = (s) => esc(s).split(/(\`\`\`[\\s\\S]*?\`\`\`)/).map((part) => part.startsWith("\`\`\`")
  ? "<pre>" + part.slice(3, -3).replace(/^[a-z]*\\n/, "") + "</pre>"
  : part.replace(/\`([^\`\\n]+)\`/g, "<code>$1</code>").replace(/\\*\\*([^*\\n]+)\\*\\*/g, "<strong>$1</strong>").replace(/^(#{1,3}) (.+)$/gm, "<strong>$2</strong>")).join("");
// The files a turn delivered. Their paths are made by the review command, not taken from the turn.
const shown = (files) => files.length ? "<div class='files'>" + files.map((f) =>
  /\\.(png|jpe?g|gif|webp)$/.test(f.href) ? "<a href='" + f.href + "' target='_blank'><img src='" + f.href + "' alt=''></a><small>" + esc(f.name) + "</small>"
  : /\\.(mp4|webm|mov)$/.test(f.href) ? "<video controls src='" + f.href + "'></video><small>" + esc(f.name) + "</small>"
  : "<a href='" + f.href + "' target='_blank'>" + esc(f.name) + "</a>").join("") + "</div>" : "";
const labels = { left: "左がよい", same: "同じくらい", right: "右がよい", skip: "比較できない" };
function progress() {
  document.getElementById("progress").textContent = Object.keys(state.verdicts).length + " / " + DATA.pairs.length + " 件";
}
const list = document.getElementById("list");
DATA.pairs.forEach((p, i) => {
  const el = document.createElement("section");
  const earlier = p.history.length
    ? "<details><summary>それまでの会話（" + p.history.length + " 件。新旧どちらにも同じ文章を渡しています" + (p.incomplete ? "。保存されていた会話は途中からです" : "") + "）</summary>" +
      p.history.map((h) => "<div class='q'><small>" + (h.role === "user" ? "利用者" : "bot") + "</small><br>" + esc(h.content) + "</div>").join("") + "</details>"
    : "";
  const note = p.unavailable.length
    ? "<small>本番のこのターンは、この再現では使えないツールも使っていました（新旧どちらにも同じエラーを返しています）: " + esc(p.unavailable.join("、")) + "</small>"
    : "";
  el.innerHTML = "<h2>" + (i + 1) + " 件目 <small>#" + esc(p.id) + "</small></h2>" + earlier + "<div class='q'>" + esc(p.prompt) + "</div>" + note +
    "<div class='pair'>" + ["left", "right"].map((side) => "<div><h3>" + (side === "left" ? "左" : "右") + "</h3><div class='a'>" +
      (p[side] === null ? "<small>（返答なし。このターンは失敗しました）</small>" : render(p[side])) + shown(p[side + "Files"]) + "</div></div>").join("") + "</div>" +
    "<div class='pick'>" + Object.entries(labels).map(([v, text]) => "<button data-v='" + v + "'>" + text + "</button>").join("") + "</div>" +
    "<textarea rows='1' placeholder='メモ（任意）'></textarea>" +
    (p.production ? "<details class='production'><summary>本番での返答（参考。実際のツールと会話で返したもの）</summary><div class='a'>" + render(p.production) + "</div></details>" : "");
  const buttons = [...el.querySelectorAll("button")];
  // The production reply came from one of the two harnesses, so it is shown
  // only once this pair has a verdict.
  const production = el.querySelector(".production");
  const paint = () => {
    buttons.forEach((b) => b.classList.toggle("on", state.verdicts[p.id] === b.dataset.v));
    if (production) production.hidden = !state.verdicts[p.id];
  };
  buttons.forEach((b) => b.addEventListener("click", () => { state.verdicts[p.id] = b.dataset.v; paint(); save(); }));
  const memo = el.querySelector("textarea");
  memo.value = state.notes[p.id] || "";
  memo.addEventListener("input", () => { state.notes[p.id] = memo.value; save(); });
  paint();
  list.append(el);
});
document.getElementById("export").addEventListener("click", () => {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify({ run: DATA.run, deal: DATA.deal, ...state }, null, 1)], { type: "application/json" }));
  a.download = "verdicts.json";
  a.click();
});
progress();
</script></html>
`;

async function review(name: string) {
  const dir = join(ROOT, "runs", name);
  const results = await lines<ArmResult>(join(dir, "results.jsonl"));
  const cases = new Map((await lines<Case>(join(ROOT, "cases.jsonl"))).map((c) => [c.id, c]));
  // Sides once dealt are kept: the page and an exported file say "left" and "right".
  const saved = JSON.parse(await readFile(join(dir, "key.json"), "utf8").catch(() => "null")) as Deal | null;
  const deal: Deal = { id: saved?.id ?? crypto.randomUUID().slice(0, 8), pairs: blind(results, Number(flag("seed") ?? Date.now() % 2 ** 31), saved?.pairs) };
  await rm(join(dir, "review-files"), { recursive: true, force: true });
  const pairs: Pair[] = [];
  for (const { id, left } of deal.pairs) {
    const c = cases.get(id);
    const side = async (arm: Arm, where: "left" | "right") => {
      const result = results.find((r) => r.case === id && r.arm === arm)!;
      // Copies under a name that tells neither the harness nor anything the model chose.
      const from = join(dir, "files", id, arm);
      const files: Shown[] = [];
      for (const [n, stored] of (await readdir(from).catch(() => [] as string[])).sort((a, b) => parseInt(a) - parseInt(b)).entries()) {
        const extension = /\.([A-Za-z0-9]{1,5})$/.exec(stored)?.[1]?.toLowerCase();
        const href = `review-files/${id}/${where}/${n + 1}${extension ? `.${extension}` : ""}`;
        await mkdir(join(dir, "review-files", id, where), { recursive: true, mode: 0o700 });
        await cp(join(from, stored), join(dir, href));
        files.push({ href, name: result.files[n] ?? stored });
      }
      return { text: result.error ? null : result.reply, files };
    };
    const [l, r] = [await side(left, "left"), await side(left === "claude" ? "codex" : "claude", "right")];
    pairs.push({
      id, history: c?.history ?? [], incomplete: Boolean(c?.summarized || c?.trimmed), prompt: c?.prompt ?? "", production: c?.reply ?? null,
      unavailable: [...new Set((c?.tools ?? []).map((tool) => tool.replace(/^mcp__[^_]+__/, "")).filter((tool) => !REAL.has(tool) && !ASKS.has(tool) && tool !== "send_file"))],
      left: l.text, right: r.text, leftFiles: l.files, rightFiles: r.files,
    });
  }
  await writeFile(join(dir, "review.html"), reviewPage({ run: name, deal: deal.id, pairs }), { mode: 0o600 });
  await writeFile(join(dir, "key.json"), JSON.stringify(deal), { mode: 0o600 });
  await chmod(join(dir, "review.html"), 0o600);
  console.log(`${pairs.length} pairs -> ${join(dir, "review.html")}`);
  console.log(`Which side is which harness is in key.json; do not open it before judging.`);
}

async function summary(name: string, verdictFile?: string) {
  const dir = join(ROOT, "runs", name);
  const results = await lines<ArmResult>(join(dir, "results.jsonl"));
  const deal = JSON.parse(await readFile(join(dir, "key.json"), "utf8").catch(() => "null")) as Deal | null;
  const judged = JSON.parse(await readFile(verdictFile ?? join(dir, "verdicts.json"), "utf8").catch(() => "null")) as { deal?: string; verdicts: Record<string, Verdict> } | null;
  if (deal && judged && judged.deal !== deal.id) throw new Error("These verdicts were given on a page dealt differently from key.json; their left and right cannot be mapped");
  const out = summarize(results, deal && judged ? { key: deal.pairs, verdicts: judged.verdicts } : undefined, await lines<ArmResult>(join(dir, "warmups.jsonl")));
  await writeFile(join(dir, "summary.json"), JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out, null, 1));
}

if (import.meta.main) {
  const [command, name, extra] = process.argv.slice(2);
  if (command === "run") await run();
  else if (command === "review" && name) await review(name);
  else if (command === "summary" && name) await summary(name, extra);
  else { console.error("usage: harness-eval run [--limit N] [--budget USD] [--run NAME] | review NAME | summary NAME [verdicts.json]"); process.exitCode = 2; }
}

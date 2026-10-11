// Manual comparison of the two harnesses on questions people asked in
// production (#69):
//   cd apps/bot && bun run harness-eval run --limit 3 [--budget 5] [--run trial]
//   cd apps/bot && bun run harness-eval review <run>
//   cd apps/bot && bun run harness-eval summary <run> [verdicts.json]
// `run` replays each selected question twice, once per harness, as a new
// conversation on Anthropic's API with the model and effort the production
// turn used. The LLM, the Docker sandbox and Anthropic's web tools are real, so
// it is billed and is not part of `make ci`. Discord, settings, publishing and
// every other integration answer with one fixed error in both arms, and a
// question to the user is answered with "nobody is here".
// The questions and replies are people's messages. They are read from and
// written to .local/harness-eval/ (gitignored); nothing here prints them, and
// `review` writes a local page, not a published one.
import { appendFile, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ANTHROPIC_PRICES, anthropicCost } from "@hibana/shared/catalog";
import pino from "pino";
import { Hibana } from "./bot";
import { loadConfig } from "./config";
import type { LlmHooks, RequestRecord } from "./llm";
import { emptyUsage, type Context } from "./types";

export type Arm = "codex" | "claude";
/** One production turn, as `apps/api/src/export-logs.ts` writes it. */
export type Case = {
  id: number; at: number; scope: "guild" | "dm"; channel: string | null;
  provider: string | null; model: string | null; effort: string | null;
  failed: boolean; latency_ms: number | null; prompt: string; reply: string | null;
};
export type ArmResult = {
  case: number; arm: Arm; first: boolean; model: string; effort: string | null; scope: Case["scope"];
  /** Wall time of the turn, from the message arriving to the final reply. */
  ms: number;
  requests: number; input: number; cache_read: number; cache_write: number; output: number;
  /** Billed per request by Anthropic and not in `cost`: the price table has no row for them. */
  searches: number; fetches: number;
  cost: number; models: string[];
  tools: Record<string, number>; blocked: string[]; asked: boolean; status_messages: number;
  error: string | null; reply: string;
};
export type Verdict = "left" | "right" | "same" | "skip";

const ROOT = join(import.meta.dir, "../../../.local/harness-eval");
// The line the bot appends to a Discord message (`Hibana.onMessage`).
const META = /\n\n\[author: (.*); user_id: \d+; channel_id: \d+; message_id: \d+\]/;
const IDS = { user: "20000000000000002", channel: "20000000000000001", guild: "20000000000000003", bot: "20000000000000004" };
// Tools that run for real: they stay inside the turn's own workspace and data
// directory. Everything else would act on Discord, settings or an outside
// service that the replay does not have.
const REAL = new Set([
  "Bash", "Read", "Edit", "Write", "Glob", "Grep", "Skill", "Agent",
  "shell_command", "apply_patch", "update_plan", "view_image", "tool_search",
  "bash", "read_file", "write_file", "write_files", "edit_file", "list_files", "grep_files", "send_file",
  "download_file", "download_media", "video_edit", "playwright_cli",
  "list_skills", "use_skill", "read_skill_file", "get_bot_settings", "get_user_context",
]);
const ASKS = new Set(["AskUserQuestion", "request_user_input"]);
const UNAVAILABLE = "This tool is not available in this replay environment.";
const NO_ANSWER = "Nobody is available to answer in this replay. Continue with your best judgment and state the assumption you made.";

/** Why a production turn cannot be replayed as a new conversation, or null. */
export function exclusion(c: Case, earlier: number | undefined, gapMs: number): string | null {
  if (!c.prompt.replace(META, "").trim() || c.prompt === "/retry") return "no message text";
  if (/\nAttachments: \{/.test(c.prompt)) return "has attachments";
  if (!c.model || !ANTHROPIC_PRICES[c.model]) return "model is not on Anthropic's API";
  if (earlier !== undefined && c.at - earlier < gapMs) return "follows another turn in the channel";
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
 *  of the whole period and a rerun picks the same ones. A turn that follows
 *  another one in its channel within the gap is left out: the log has the
 *  message but not the conversation it continued. */
export function select(cases: Case[], options: { gapHours: number; seed: number; limit?: number; ids?: number[] }) {
  const last = new Map<string, number>();
  const excluded: Record<string, number> = {};
  const eligible: Case[] = [];
  for (const c of [...cases].sort((a, b) => a.at - b.at || a.id - b.id)) {
    const reason = exclusion(c, last.get(c.channel ?? ""), options.gapHours * 3_600_000);
    last.set(c.channel ?? "", c.at);
    if (reason) excluded[reason] = (excluded[reason] ?? 0) + 1;
    else eligible.push(c);
  }
  const ordered = options.ids
    ? eligible.filter((c) => options.ids!.includes(c.id))
    : shuffle(eligible, random(options.seed));
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
 *  in. Only cases that have both arms are paired. */
export function blind(results: ArmResult[], seed: number) {
  const arms = new Map<number, Set<Arm>>();
  for (const r of results) arms.set(r.case, (arms.get(r.case) ?? new Set()).add(r.arm));
  const next = random(seed);
  const ids = shuffle([...arms].filter(([, set]) => set.size === 2).map(([id]) => id).sort((a, b) => a - b), next);
  return ids.map((id) => ({ id, left: (next() < 0.5 ? "claude" : "codex") as Arm }));
}

const quantile = (values: number[], q: number) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (sorted.length - 1) * q;
  const low = Math.floor(at);
  return sorted[low]! + (sorted[Math.min(low + 1, sorted.length - 1)]! - sorted[low]!) * (at - low);
};
const mean = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);

/** Time and cost are compared over the cases both arms finished; a failure is
 *  counted and left out of them, so one arm failing fast does not look fast. */
export function summarize(
  results: ArmResult[],
  review?: { key: { id: number; left: Arm }[]; verdicts: Record<string, Verdict> },
) {
  const by = new Map<number, Partial<Record<Arm, ArmResult>>>();
  for (const r of results) by.set(r.case, { ...by.get(r.case), [r.arm]: r });
  const pairs = [...by.values()].filter((p): p is Record<Arm, ArmResult> => Boolean(p.codex && p.claude));
  const both = pairs.filter((p) => !p.codex.error && !p.claude.error);
  const arm = (name: Arm) => {
    const done = both.map((p) => p[name]);
    return {
      failed: pairs.filter((p) => p[name].error).length,
      seconds: { median: quantile(done.map((r) => r.ms / 1000), 0.5), mean: mean(done.map((r) => r.ms / 1000)), p90: quantile(done.map((r) => r.ms / 1000), 0.9) },
      cost: { total: done.reduce((t, r) => t + r.cost, 0), mean: mean(done.map((r) => r.cost)), median: quantile(done.map((r) => r.cost), 0.5) },
      requests: mean(done.map((r) => r.requests)), searches: done.reduce((t, r) => t + r.searches, 0),
    };
  };
  const quality = review && { claude: 0, codex: 0, same: 0, skipped: 0, unjudged: 0 };
  for (const { id, left } of review?.key ?? []) {
    const verdict = review!.verdicts[String(id)];
    if (!verdict) quality!.unjudged++;
    else if (verdict === "skip") quality!.skipped++;
    else if (verdict === "same") quality!.same++;
    else quality![verdict === "left" ? left : left === "claude" ? "codex" : "claude"]++;
  }
  return {
    pairs: pairs.length, both_finished: both.length,
    codex: arm("codex"), claude: arm("claude"),
    // Per case, claude ÷ codex: below 1 means the Claude harness was faster or cheaper.
    ratio: {
      seconds_median: quantile(both.map((p) => p.claude.ms / p.codex.ms), 0.5),
      cost_median: quantile(both.filter((p) => p.codex.cost > 0).map((p) => p.claude.cost / p.codex.cost), 0.5),
      claude_faster: both.filter((p) => p.claude.ms < p.codex.ms).length,
      claude_cheaper: both.filter((p) => p.claude.cost < p.codex.cost).length,
    },
    ...(quality && { quality }),
  };
}

export type ReplayOptions = { image?: string; perArm: number; minutes: number; dry?: boolean };

/** One question through one harness: a new bot with its own data directory,
 *  so nothing carries over from another case or the other arm. */
export async function replay(c: Case, arm: Arm, first: boolean, o: ReplayOptions): Promise<ArmResult> {
  const data = await mkdtemp(join(tmpdir(), `harness-eval-${c.id}-${arm}-`));
  const records: RequestRecord[] = [];
  const tools: Record<string, number> = {};
  const blocked = new Set<string>();
  let asked = false, status = 0, reply = "", stopped = "", ms = 0;
  let error: string | null = null;
  let bot: Hibana | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Only what the replay needs: the bot's own .env also names the web API,
    // Jev and other services that a replay must not reach.
    bot = new Hibana(loadConfig({
      PROVIDER: "anthropic", LLM_MODEL: c.model ?? "", LLM_EFFORT: c.effort ?? "",
      ANTHROPIC_API_KEY: o.dry ? "dry-run" : process.env.ANTHROPIC_API_KEY, ANTHROPIC_HARNESS: arm,
      HIBANA_DATA_DIR: data, RUNTIME_STATE_PATH: "", LOG_DIR: "",
      ...(o.image && { SANDBOX_IMAGE: o.image }), ...(o.dry && { SANDBOX_ENABLED: "false", SKILLS_ENABLED: "false" }),
    }), pino({ enabled: false }));
    const running = bot;
    const stop = (reason: string) => { if (!stopped) { stopped = reason; void running.close().catch(() => {}); } };
    if (o.dry) {
      bot.llm.complete = (async () => ({ message: { role: "assistant", content: "dry run" }, usage: emptyUsage(), incomplete: false })) as typeof bot.llm.complete;
    } else {
      await bot.tools.sandbox.probe();
      if (!bot.tools.sandbox.available) throw new Error(`Sandbox image ${bot.config.sandboxImage} is not available`);
      // The client's hooks are how the bot itself logs each request.
      const hooks = (bot.llm as unknown as { hooks: LlmHooks }).hooks;
      const logged = hooks.onCompletion;
      hooks.onCompletion = (record) => {
        records.push(record);
        logged?.(record);
        if (totals(records).cost > o.perArm) stop(`stopped: over $${o.perArm} for one turn`);
      };
    }
    const execute = bot.tools.execute.bind(bot.tools);
    bot.tools.execute = async (name, args, ctx) => {
      const internal = name.replace(/^mcp__[^_]+__/, "");
      tools[name] = (tools[name] ?? 0) + 1;
      if (ASKS.has(internal)) { asked = true; throw new Error(NO_ANSWER); }
      if (!REAL.has(internal)) { blocked.add(name); throw new Error(UNAVAILABLE); }
      return execute(name, args, ctx);
    };
    // The one channel the turn lives in. The bot checks that the channel is
    // in the turn's server and that the author can read it before it sends.
    bot.client.channels.fetch = (async () => ({
      id: IDS.channel, isSendable: () => true, sendTyping: async () => {},
      send: async () => { status++; return { id: String(100 + status), edit: async () => {}, delete: async () => {} }; },
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
    timer = setTimeout(() => stop(`stopped: over ${o.minutes} minutes`), o.minutes * 60_000);
    const started = performance.now();
    try { reply = await bot.respond(replayPrompt(c.prompt), ctx); }
    finally { ms = Math.round(performance.now() - started); }
  } catch (e) {
    error = stopped || (e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(timer);
    await bot?.close().catch(() => {});
    await rm(data, { recursive: true, force: true }).catch(() => {});
  }
  return {
    case: c.id, arm, first, model: c.model ?? "", effort: c.effort, scope: c.scope, ms,
    ...totals(records), tools, blocked: [...blocked], asked,
    // The final reply is the last message sent; the ones before it are status.
    status_messages: Math.max(0, status - (reply ? 1 : 0)), error, reply,
  };
}

const lines = async <T>(file: string): Promise<T[]> =>
  (await readFile(file, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as T);
const flag = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? undefined : process.argv[i + 1]; };
const usd = (value: number | null) => (value === null ? "-" : `$${value.toFixed(4)}`);

async function run() {
  const name = flag("run") ?? "trial";
  const o = {
    gapHours: Number(flag("gap-hours") ?? 6), seed: Number(flag("seed") ?? 1), limit: flag("limit") ? Number(flag("limit")) : undefined,
    ids: flag("ids")?.split(",").map(Number), budget: Number(flag("budget") ?? 5),
    image: flag("image"), perArm: Number(flag("per-turn") ?? 2), minutes: Number(flag("minutes") ?? 15), dry: process.argv.includes("--dry"),
  };
  if (!o.dry && !process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is required");
  const cases = await lines<Case>(join(ROOT, "cases.jsonl"));
  if (!cases.length) throw new Error("No cases: run `bun run export-logs` in apps/api first");
  const { chosen, eligible, excluded } = select(cases, o);
  console.log(`${cases.length} production turns, ${eligible} replayable, ${chosen.length} selected`);
  for (const [reason, n] of Object.entries(excluded)) console.log(`  left out ${n}: ${reason}`);
  const dir = join(ROOT, "runs", name);
  await mkdir(dir, { recursive: true });
  const file = join(dir, "results.jsonl");
  const done = await lines<ArmResult>(file);
  const commit = (await Bun.$`git rev-parse --short HEAD`.text()).trim();
  const dirty = (await Bun.$`git status --porcelain -- .`.text()).trim() !== "";
  await appendFile(join(dir, "meta.jsonl"), JSON.stringify({ at: new Date().toISOString(), commit, dirty, bun: Bun.version, platform: `${process.platform} ${process.arch}`, ...o }) + "\n");
  let spent = done.reduce((total, r) => total + r.cost, 0);
  for (const [i, c] of chosen.entries()) {
    // Alternate which harness goes first, so neither always runs second.
    const order: Arm[] = i % 2 ? ["claude", "codex"] : ["codex", "claude"];
    for (const [n, arm] of order.entries()) {
      if (done.some((r) => r.case === c.id && r.arm === arm)) continue;
      if (spent >= o.budget) { console.log(`Stopped at the budget: ${usd(spent)} of $${o.budget}`); return; }
      const result = await replay(c, arm, n === 0, o);
      await appendFile(file, JSON.stringify(result) + "\n", { mode: 0o600 });
      spent += result.cost;
      const used = Object.entries(result.tools).map(([tool, count]) => `${tool}×${count}`).join(" ");
      console.log(`case ${c.id} ${arm.padEnd(6)} ${result.model} ${(result.ms / 1000).toFixed(1)}s ${usd(result.cost)} ${result.requests} requests` +
        `${result.searches ? ` ${result.searches} searches` : ""}${used ? ` [${used}]` : ""}${result.blocked.length ? ` blocked:${result.blocked.length}` : ""}` +
        `${result.asked ? " asked" : ""}${result.error ? " FAILED" : ""}`);
    }
  }
  console.log(`Done: ${usd(spent)} in total for run "${name}" (web searches are billed separately)`);
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
const key = "harness-eval:" + DATA.run;
const state = JSON.parse(localStorage.getItem(key) || '{"verdicts":{},"notes":{}}');
const save = () => { localStorage.setItem(key, JSON.stringify(state)); progress(); };
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
// Enough of Discord's markdown to judge a reply as it would be read.
const render = (s) => esc(s).split(/(\`\`\`[\\s\\S]*?\`\`\`)/).map((part) => part.startsWith("\`\`\`")
  ? "<pre>" + part.slice(3, -3).replace(/^[a-z]*\\n/, "") + "</pre>"
  : part.replace(/\`([^\`\\n]+)\`/g, "<code>$1</code>").replace(/\\*\\*([^*\\n]+)\\*\\*/g, "<strong>$1</strong>").replace(/^(#{1,3}) (.+)$/gm, "<strong>$2</strong>")).join("");
const labels = { left: "左がよい", same: "同じくらい", right: "右がよい", skip: "比較できない" };
function progress() {
  document.getElementById("progress").textContent = Object.keys(state.verdicts).length + " / " + DATA.pairs.length + " 件";
}
const list = document.getElementById("list");
DATA.pairs.forEach((p, i) => {
  const el = document.createElement("section");
  el.innerHTML = "<h2>" + (i + 1) + " 件目 <small>#" + p.id + "</small></h2><div class='q'>" + esc(p.prompt) + "</div>" +
    "<div class='pair'>" + ["left", "right"].map((side) => "<div><h3>" + (side === "left" ? "左" : "右") + "</h3><div class='a'>" +
      (p[side] === null ? "<small>（返答なし。このターンは失敗しました）</small>" : render(p[side])) + "</div></div>").join("") + "</div>" +
    "<div class='pick'>" + Object.entries(labels).map(([v, text]) => "<button data-v='" + v + "'>" + text + "</button>").join("") + "</div>" +
    "<textarea rows='1' placeholder='メモ（任意）'></textarea>" +
    (p.production ? "<details><summary>本番での返答（参考。従来のハーネスで、会話の続きとして返したもの）</summary><div class='a'>" + render(p.production) + "</div></details>" : "");
  const buttons = [...el.querySelectorAll("button")];
  const paint = () => buttons.forEach((b) => b.classList.toggle("on", state.verdicts[p.id] === b.dataset.v));
  buttons.forEach((b) => b.addEventListener("click", () => { state.verdicts[p.id] = b.dataset.v; paint(); save(); }));
  const note = el.querySelector("textarea");
  note.value = state.notes[p.id] || "";
  note.addEventListener("input", () => { state.notes[p.id] = note.value; save(); });
  paint();
  list.append(el);
});
document.getElementById("export").addEventListener("click", () => {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify({ run: DATA.run, ...state }, null, 1)], { type: "application/json" }));
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
  const key = blind(results, Number(flag("seed") ?? Date.now() % 2 ** 31));
  const of = (id: number, arm: Arm) => results.find((r) => r.case === id && r.arm === arm)!;
  const pairs = key.map(({ id, left }) => {
    const right: Arm = left === "claude" ? "codex" : "claude";
    const text = (arm: Arm) => (of(id, arm).error ? null : of(id, arm).reply);
    return { id, prompt: cases.get(id)?.prompt ?? "", left: text(left), right: text(right), production: cases.get(id)?.reply ?? null };
  });
  // `<` is escaped so that a reply cannot close the script element.
  const page = PAGE.replace("__DATA__", () => JSON.stringify({ run: name, pairs }).replace(/</g, "\\u003c"));
  await writeFile(join(dir, "review.html"), page, { mode: 0o600 });
  await writeFile(join(dir, "key.json"), JSON.stringify(key), { mode: 0o600 });
  await chmod(join(dir, "review.html"), 0o600);
  console.log(`${pairs.length} pairs -> ${join(dir, "review.html")}`);
  console.log(`Which side is which harness is in key.json; do not open it before judging.`);
}

async function summary(name: string, verdictFile?: string) {
  const dir = join(ROOT, "runs", name);
  const results = await lines<ArmResult>(join(dir, "results.jsonl"));
  const key = JSON.parse(await readFile(join(dir, "key.json"), "utf8").catch(() => "null")) as { id: number; left: Arm }[] | null;
  const judged = JSON.parse(await readFile(verdictFile ?? join(dir, "verdicts.json"), "utf8").catch(() => "null")) as { verdicts: Record<string, Verdict> } | null;
  const out = summarize(results, key && judged ? { key, verdicts: judged.verdicts } : undefined);
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

// Manual export of production turns for the harness comparison (#69):
//   cd apps/api && bun run export-logs [--days 30]
// It needs DATABASE_URL (the production database; this only reads). It writes
// the turns that used Anthropic's API or a Claude model to
// .local/harness-eval/cases.jsonl, which is gitignored: prompts and replies
// are people's messages, DMs included, and must not reach the repository, an
// Issue or a log. Server, channel and user ids are stored as short hashes.
// Only counts are printed.
import { createHash } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { neon } from "@neondatabase/serverless";

type Row = {
  id: string; at: string; guild_id: string | null; channel_id: string; user_id: string;
  trigger_reason: string | null; prompt: string; reply: string | null; provider: string | null;
  model: string | null; effort: string | null; error: string | null; failure_code: string | null;
  latency_ms: number | null;
};

const url = (process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? "").trim();
if (!/^postgres(ql)?:\/\//.test(url)) throw new Error("DATABASE_URL is required");
const days = Number(process.argv[process.argv.indexOf("--days") + 1]) || 30;
const since = Date.now() - days * 86_400_000;
const sql = neon(url);
const tag = (value: string | null) => (value ? createHash("sha256").update(value).digest("hex").slice(0, 8) : null);

const cases: unknown[] = [];
const count = new Map<string, number>();
const bump = (key: string) => count.set(key, (count.get(key) ?? 0) + 1);
// Keyset pages: the HTTP driver returns a whole result in one response.
for (let after = 0n; ;) {
  const rows = (await sql`
    SELECT id, at, guild_id, channel_id, user_id, trigger_reason, prompt, reply,
           provider, model, effort, error, failure_code, latency_ms
    FROM logs
    WHERE id > ${after.toString()}::bigint AND at >= ${since}::bigint
      AND (provider IN ('anthropic', 'claude_max', 'claude_kiro') OR model LIKE 'claude%')
    ORDER BY id LIMIT 500`) as Row[];
  for (const row of rows) {
    cases.push({
      id: Number(row.id), at: Number(row.at), scope: row.guild_id ? "guild" : "dm",
      guild: tag(row.guild_id), channel: tag(row.channel_id), user: tag(row.user_id),
      trigger: row.trigger_reason, provider: row.provider, model: row.model, effort: row.effort,
      failed: Boolean(row.error), failure_code: row.failure_code, latency_ms: row.latency_ms,
      prompt: row.prompt, reply: row.reply,
    });
    bump(`${row.provider} ${row.model} ${row.effort ?? "-"}`);
    bump(row.guild_id ? "scope guild" : "scope dm");
    if (row.error) bump("failed in production");
  }
  if (rows.length < 500) break;
  after = BigInt(rows.at(-1)!.id);
}

const file = join(import.meta.dir, "../../../.local/harness-eval/cases.jsonl");
await mkdir(dirname(file), { recursive: true });
await writeFile(file, cases.map((c) => JSON.stringify(c)).join("\n") + (cases.length ? "\n" : ""), { mode: 0o600 });
await chmod(file, 0o600);
console.log(`database host: ${new URL(url).host.replace(/^[^.]+/, "***")}`);
console.log(`${cases.length} turns from the last ${days} days -> .local/harness-eval/cases.jsonl`);
for (const [key, n] of [...count].sort()) console.log(`  ${String(n).padStart(5)}  ${key}`);

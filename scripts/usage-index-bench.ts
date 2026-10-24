// Measures which index the usage table (`usage_events`, #110) needs, with
// EXPLAIN (ANALYZE, BUFFERS) on synthetic rows in a local Postgres.
//
//   docker run --rm -d --name hibana-pg -e POSTGRES_PASSWORD=test \
//     -p 127.0.0.1:55432:5432 postgres:17-alpine
//   HIBANA_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/postgres \
//     bun scripts/usage-index-bench.ts [rows ...]
//
// It works in its own schema (`usage_bench`), which it drops first, so only a
// local database is accepted. Rows default to 24,000 (60 turns a day for the
// 400 days the table keeps) and 1,000,000 (about 2,500 a day).
import { SQL } from "bun";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-25T00:00:00Z");
const KEEP_DAYS = 400;
const FIRST = NOW - KEEP_DAYS * DAY;
// One billing month (5 September to 4 October, #81): the page's usual query.
const FROM = Date.parse("2026-09-05T00:00:00Z");
const TO = Date.parse("2026-10-05T00:00:00Z");
// The hourly prune at the end of the retention: about one hour of rows.
const PRUNE_BEFORE = FIRST + 3_600_000;
const RUNS = 7;
const USERS = 40;
const MODELS: [string, string][] = [
  ["anthropic", "claude-opus-5-5"],
  ["anthropic", "claude-haiku-5-5"],
  ["anthropic", "claude-sonnet-5-5"],
  ["anthropic_workspace", "claude-haiku-5-5"],
  ["refuseless", "glm-5.3-abliterated"],
  ["codex_pro", "gpt-6.1-sol"],
];

const url = process.env.HIBANA_TEST_DATABASE_URL ?? "";
if (!["127.0.0.1", "localhost"].includes(new URL(url || "x:/").hostname)) {
  console.error("Set HIBANA_TEST_DATABASE_URL to a local Postgres.");
  process.exit(1);
}
const sizes = process.argv.slice(2).map(Number).filter(Boolean);
// One connection: the schema is set per session, and EXPLAIN ANALYZE of the
// DELETE runs inside BEGIN/ROLLBACK on that same connection.
const db = new SQL(url, { max: 1 });

const VARIANTS: { name: string; ddl: string | null }[] = [
  { name: "なし", ddl: null },
  { name: "btree (at)", ddl: "CREATE INDEX ue_at ON usage_events (at)" },
  {
    name: "btree (at) INCLUDE (user_hash, provider, model, ok)",
    ddl: "CREATE INDEX ue_at_cover ON usage_events (at) INCLUDE (user_hash, provider, model, ok)",
  },
  {
    name: "brin (at)",
    ddl: "CREATE INDEX ue_at_brin ON usage_events USING brin (at)",
  },
];

// The administrators' hashes are passed as JSON, as the store does.
const EXCLUDE = JSON.stringify(["u0"]);
const QUERIES: { name: string; sql: string; write?: boolean }[] = [
  {
    name: "日ごと（1 か月）",
    sql: `SELECT at / ${DAY} AS d, count(*) AS turns,
      count(*) FILTER (WHERE NOT ok) AS failed,
      count(DISTINCT user_hash) AS users,
      count(DISTINCT user_hash) FILTER (WHERE NOT (user_hash = ANY (ARRAY(SELECT jsonb_array_elements_text('${EXCLUDE}'::jsonb))))) AS others
      FROM usage_events WHERE at >= ${FROM} AND at < ${TO} GROUP BY 1 ORDER BY 1`,
  },
  {
    name: "合計（1 か月）",
    sql: `SELECT count(*) AS turns, count(*) FILTER (WHERE NOT ok) AS failed,
      count(DISTINCT user_hash) AS users,
      count(DISTINCT user_hash) FILTER (WHERE NOT (user_hash = ANY (ARRAY(SELECT jsonb_array_elements_text('${EXCLUDE}'::jsonb))))) AS others
      FROM usage_events WHERE at >= ${FROM} AND at < ${TO}`,
  },
  {
    name: "モデル別（1 か月）",
    sql: `SELECT provider, model, count(*) AS turns FROM usage_events
      WHERE at >= ${FROM} AND at < ${TO} GROUP BY provider, model ORDER BY turns DESC`,
  },
  { name: "最初の記録", sql: `SELECT min(at) FROM usage_events` },
  {
    name: "古い記録の削除（1 時間分）",
    sql: `DELETE FROM usage_events WHERE at < ${PRUNE_BEFORE}`,
    write: true,
  },
];

type Measured = { ms: number; plan: string; buffers: string };

async function explain(sql: string, write: boolean): Promise<Measured> {
  const run = async () => {
    const rows = (await db.unsafe(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`,
    )) as { "QUERY PLAN": unknown }[];
    const doc = (rows[0]!["QUERY PLAN"] as any[])[0];
    return doc;
  };
  const times: number[] = [];
  let first: any = null;
  for (let i = 0; i < RUNS; i++) {
    let doc: any;
    if (write) {
      // A DELETE under EXPLAIN ANALYZE runs, so it is rolled back each time.
      await db.unsafe("BEGIN");
      doc = await run();
      await db.unsafe("ROLLBACK");
    } else doc = await run();
    // The first run reads the pages in; the median of the rest is reported.
    if (i === 0) first = doc;
    else times.push(doc["Execution Time"]);
  }
  times.sort((a, b) => a - b);
  const nodes: string[] = [];
  const walk = (n: any) => {
    nodes.push(
      n["Index Name"]
        ? `${n["Node Type"]}(${n["Index Name"]})`
        : n["Node Type"],
    );
    for (const c of n.Plans ?? []) walk(c);
  };
  walk(first.Plan);
  const p = first.Plan;
  return {
    ms: times[Math.floor(times.length / 2)]!,
    plan: nodes.join(" > "),
    buffers: `hit ${p["Shared Hit Blocks"] ?? 0} / read ${p["Shared Read Blocks"] ?? 0}`,
  };
}

async function fill(rows: number) {
  await db.unsafe("DROP SCHEMA IF EXISTS usage_bench CASCADE");
  await db.unsafe("CREATE SCHEMA usage_bench");
  await db.unsafe("SET search_path TO usage_bench");
  await db.unsafe(`CREATE TABLE usage_events (
    at BIGINT NOT NULL,
    user_hash TEXT NOT NULL,
    provider TEXT,
    model TEXT,
    ok BOOLEAN NOT NULL
  )`);
  // Rows arrive in time order, as the bot posts them at the end of each turn.
  // Users and models are skewed: a few people and Opus make most of the turns.
  await db.unsafe(`INSERT INTO usage_events (at, user_hash, provider, model, ok)
    SELECT ${FIRST} + (i::bigint * ${KEEP_DAYS * DAY}) / ${rows},
           'u' || floor(${USERS} * power(random(), 3))::int,
           (ARRAY[${MODELS.map(([p]) => `'${p}'`).join(",")}])[1 + floor(${MODELS.length} * power(random(), 2))::int],
           NULL,
           random() > 0.03
    FROM generate_series(0, ${rows - 1}) AS i`);
  await db.unsafe(`UPDATE usage_events SET model = CASE provider
    ${MODELS.map(([p, m]) => `WHEN '${p}' THEN '${m}'`).join(" ")} END`);
  await db.unsafe("VACUUM FULL ANALYZE usage_events");
}

console.log(
  `Postgres: ${((await db`SELECT version()`) as { version: string }[])[0]!.version}`,
);
console.log(
  `期間: ${new Date(FIRST).toISOString().slice(0, 10)}〜${new Date(NOW).toISOString().slice(0, 10)}、集計する月: 2026-09-05〜2026-10-04、各クエリ ${RUNS} 回（1 回目を除いた中央値）\n`,
);

for (const rows of sizes.length ? sizes : [24_000, 1_000_000]) {
  await fill(rows);
  const share = (
    (await db.unsafe(
      `SELECT count(*) FILTER (WHERE at >= ${FROM} AND at < ${TO})::float / count(*) AS s FROM usage_events`,
    )) as { s: number }[]
  )[0]!.s;
  console.log(
    `## ${rows.toLocaleString("en-US")} 行（集計する月は ${(share * 100).toFixed(1)}%）\n`,
  );
  for (const v of VARIANTS) {
    await db.unsafe("DROP INDEX IF EXISTS ue_at, ue_at_cover, ue_at_brin");
    if (v.ddl) await db.unsafe(v.ddl);
    await db.unsafe("VACUUM ANALYZE usage_events");
    const size = (
      (await db.unsafe(
        `SELECT pg_relation_size('usage_events') AS t, pg_indexes_size('usage_events') AS i`,
      )) as { t: string; i: string }[]
    )[0]!;
    console.log(
      `### インデックス: ${v.name}（表 ${(Number(size.t) / 1048576).toFixed(2)} MB、インデックス ${(Number(size.i) / 1048576).toFixed(3)} MB）\n`,
    );
    console.log("| クエリ | 実行時間（ms） | 計画 | バッファ（1 回目） |");
    console.log("|---|---:|---|---|");
    for (const q of QUERIES) {
      const m = await explain(q.sql, Boolean(q.write));
      console.log(
        `| ${q.name} | ${m.ms.toFixed(3)} | ${m.plan} | ${m.buffers} |`,
      );
    }
    console.log();
  }
  await rollup();
}

// The same turns kept as one row per UTC day, user and model, with the turns
// counted (#110): what the page shows is per day at the finest, and a month's
// distinct users then come from far fewer rows. The primary key is what an
// upsert of each turn needs; its column order decides whether a range of days
// can use it.
async function rollup() {
  const dayFrom = Math.floor(FROM / DAY);
  const dayTo = Math.floor(TO / DAY);
  const pruneBefore = Math.floor(FIRST / DAY) + 1;
  const queries = [
    {
      name: "日ごと（1 か月）",
      sql: `SELECT day, sum(turns) AS turns, sum(failed) AS failed,
        count(DISTINCT user_hash) AS users,
        count(DISTINCT user_hash) FILTER (WHERE NOT (user_hash = ANY (ARRAY(SELECT jsonb_array_elements_text('${EXCLUDE}'::jsonb))))) AS others
        FROM usage_daily WHERE day >= ${dayFrom} AND day < ${dayTo} GROUP BY day ORDER BY day`,
    },
    {
      name: "合計（1 か月）",
      sql: `SELECT sum(turns) AS turns, sum(failed) AS failed,
        count(DISTINCT user_hash) AS users,
        count(DISTINCT user_hash) FILTER (WHERE NOT (user_hash = ANY (ARRAY(SELECT jsonb_array_elements_text('${EXCLUDE}'::jsonb))))) AS others
        FROM usage_daily WHERE day >= ${dayFrom} AND day < ${dayTo}`,
    },
    {
      name: "モデル別（1 か月）",
      sql: `SELECT provider, model, sum(turns) AS turns FROM usage_daily
        WHERE day >= ${dayFrom} AND day < ${dayTo} GROUP BY provider, model ORDER BY turns DESC`,
    },
    { name: "最初の記録", sql: `SELECT min(day) FROM usage_daily` },
    {
      name: "古い記録の削除（1 日分）",
      sql: `DELETE FROM usage_daily WHERE day < ${pruneBefore}`,
      write: true,
    },
  ];
  for (const key of [
    "day, user_hash, provider, model",
    "user_hash, day, provider, model",
  ]) {
    await db.unsafe("DROP TABLE IF EXISTS usage_daily");
    await db.unsafe(`CREATE TABLE usage_daily (
      day INTEGER NOT NULL,
      user_hash TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      turns INTEGER NOT NULL,
      failed INTEGER NOT NULL,
      PRIMARY KEY (${key})
    )`);
    await db.unsafe(`INSERT INTO usage_daily
      SELECT (at / ${DAY})::int, user_hash, provider, model,
             count(*), count(*) FILTER (WHERE NOT ok)
      FROM usage_events GROUP BY 1, 2, 3, 4 ORDER BY 1`);
    await db.unsafe("VACUUM FULL ANALYZE usage_daily");
    const size = (
      (await db.unsafe(
        `SELECT count(*) AS n, pg_relation_size('usage_daily') AS t, pg_indexes_size('usage_daily') AS i FROM usage_daily`,
      )) as { n: string; t: string; i: string }[]
    )[0]!;
    console.log(
      `### 日ごとにまとめた表: 主キー (${key})（${Number(size.n).toLocaleString("en-US")} 行、表 ${(Number(size.t) / 1048576).toFixed(2)} MB、インデックス ${(Number(size.i) / 1048576).toFixed(3)} MB）\n`,
    );
    console.log("| クエリ | 実行時間（ms） | 計画 | バッファ（1 回目） |");
    console.log("|---|---:|---|---|");
    for (const q of queries) {
      const m = await explain(q.sql, Boolean(q.write));
      console.log(
        `| ${q.name} | ${m.ms.toFixed(3)} | ${m.plan} | ${m.buffers} |`,
      );
    }
    console.log();
  }
}
await db.unsafe("DROP SCHEMA IF EXISTS usage_bench CASCADE");
await db.close();

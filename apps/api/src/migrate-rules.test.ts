import { expect, test } from "bun:test";
import { join } from "node:path";

// The API migrates the database when it boots, and a deploy can be undone by
// promoting the previous build (docs/adr/0006). That build has to run against
// the schema the newer one left behind, so a migration may only add: no drops,
// renames or type changes, and no new column an older INSERT would violate.
// A destructive change is made in two deploys and is not written here.
const ADDITIVE = [
  /^CREATE TABLE IF NOT EXISTS /,
  /^CREATE (UNIQUE )?INDEX IF NOT EXISTS /,
  /^ALTER TABLE \w+ ADD COLUMN IF NOT EXISTS /,
];

/** The SQL statements inside PostgresStore.migrate(), with whitespace collapsed. */
async function migrationStatements(): Promise<string[]> {
  const source = await Bun.file(join(import.meta.dir, "store.ts")).text();
  const start = source.lastIndexOf("  async migrate() {");
  const end = source.indexOf("\n  }\n", start);
  if (start < 0 || end < 0) throw new Error("PostgresStore.migrate() not found");
  const body = source.slice(start, end);
  return [...body.matchAll(/\.sql`([^`]*)`/g)].map((match) => match[1]!.replace(/\s+/g, " ").trim());
}

test("the boot migration only adds to the schema", async () => {
  const statements = await migrationStatements();
  expect(statements.length).toBeGreaterThan(10);
  expect(statements.filter((sql) => !ADDITIVE.some((allowed) => allowed.test(sql)))).toEqual([]);
});

test("a column added to an existing table is nullable or has a default", async () => {
  const added = (await migrationStatements()).filter((sql) => sql.startsWith("ALTER TABLE"));
  expect(added.filter((sql) => /\bNOT NULL\b/.test(sql) && !/\bDEFAULT\b/.test(sql))).toEqual([]);
});

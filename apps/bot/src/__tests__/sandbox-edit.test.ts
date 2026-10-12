import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config";
import { Sandbox } from "../tools/sandbox";
import type { Context } from "../types";

const dir = await mkdtemp(join(tmpdir(), "hibana-edit-"));
afterAll(() => rm(dir, { recursive: true, force: true }));
const ctx: Context = { guildId: "1", channelId: "2", userId: "3", botId: "4", thread: false, depth: 0, delivered: false };

test("an edit inserts the new text literally, whatever characters it contains", async () => {
  const sandbox = new Sandbox(loadConfig({ HIBANA_DATA_DIR: dir, RUNTIME_STATE_PATH: "" }));
  await sandbox.write(ctx, "price.js", "const label = PRICE;\nconst other = PRICE;\n");
  // `$&`, `$1` and `$$` are replacement patterns to String.replace when the
  // replacement is passed as a string: the file got "PRICE" and "$" instead.
  await sandbox.edit(ctx, "price.js", "const label = PRICE;", "const label = `$& costs $$5, ${1}`;");
  const path = await sandbox.path(ctx, "price.js");
  expect(await readFile(path, "utf8")).toBe("const label = `$& costs $$5, ${1}`;\nconst other = PRICE;\n");
  await sandbox.edit(ctx, "price.js", "PRICE", "'$&'", true);
  expect(await readFile(path, "utf8")).toBe("const label = `$& costs $$5, ${1}`;\nconst other = '$&';\n");
});

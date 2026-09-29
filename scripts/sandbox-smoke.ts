import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../apps/bot/src/config";
import { Sandbox } from "../apps/bot/src/tools/sandbox";
import { strict as assert } from "node:assert";
const root = await mkdtemp(join(tmpdir(), "hibana-sandbox-smoke-"));
const sandbox = new Sandbox(
  loadConfig({
    ...process.env,
    HIBANA_DATA_DIR: root,
    SKILLS_DIR: join(import.meta.dir, "../apps/bot/skills"),
  }),
);
const ctx = {
  guildId: "10000",
  channelId: "20000",
  userId: "30000",
  botId: "40000",
  thread: false,
  depth: 0,
  delivered: false,
};
try {
  await sandbox.probe();
  assert(sandbox.available, "Build hibana-sandbox first, or set SANDBOX_IMAGE");
  await sandbox.write(ctx, "input.txt", "Hibana");
  const result = await sandbox.run(
    ctx,
    'test -z "$DISCORD_TOKEN" && test -z "$OPENAI_API_KEY" && test ! -S /var/run/docker.sock && test -r /skills/create-skill/SKILL.md && ! touch /hibana-root-write && cat input.txt > output.txt && rg Hibana output.txt',
    15,
  );
  assert.equal(result.exit_code, 0, result.stderr);
  assert.equal((await sandbox.read(ctx, "output.txt")).content, "Hibana");
  assert.notEqual(
    await sandbox.root(ctx),
    await sandbox.root({ ...ctx, thread: true }),
  );
  assert.notEqual((await sandbox.run(ctx, "sleep 10", 1)).exit_code, 0);
  console.log(
    "Sandbox isolation, bounded execution, file delivery path and thread separation passed.",
  );
} finally {
  await sandbox.close();
  await rm(root, { recursive: true, force: true });
}

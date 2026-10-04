// What clients of the API rely on, as a list that can be diffed.
//
// The bot and the dashboard are deployed separately from the API, and a bot
// deploy that fails rolls back alone (docs/adr/0006), so the API has to keep
// working with the previous bot and dashboard. `contract.json` is the list as
// of the last change; contract.test.ts fails when the code and the file differ.
// Adding an entry is always safe. Removing one is a deliberate edit of
// contract.json that a reviewer sees, made only after the clients that used it
// have been deployed without it.
// Regenerate with: bun apps/api/src/contract.ts --write
import { join } from "node:path";
import { createApp } from "./create-app";
import { loadTestEnv } from "./env";
import { guildPatchSchema, userOverridePatchSchema } from "./settings";
import { MemoryStore } from "./store";

export interface Contract {
  /** `METHOD path` of every route. */
  routes: string[];
  /** Fields PATCH accepts for a server; unknown fields are rejected, so a removal breaks an older dashboard. */
  guildPatchKeys: string[];
  /** Fields PATCH accepts for a user's own settings. */
  userPatchKeys: string[];
  /** Top-level fields of GET /internal/snapshot, which the bot reads. */
  snapshotKeys: string[];
}

export const CONTRACT_PATH = join(import.meta.dir, "contract.json");

export async function currentContract(): Promise<Contract> {
  const env = loadTestEnv();
  const store = new MemoryStore();
  await store.migrate();
  const app = createApp(env, store, { guildAccess: async () => true, listGuilds: async () => [] });
  const snapshot = await app.handle(
    new Request("http://127.0.0.1/internal/snapshot", { headers: { authorization: `Bearer ${env.internalToken}` } }),
  );
  if (snapshot.status !== 200) throw new Error(`GET /internal/snapshot answered HTTP ${snapshot.status}`);
  return {
    routes: [...new Set(app.routes.map((route) => `${route.method} ${route.path}`))].sort(),
    guildPatchKeys: Object.keys(guildPatchSchema.shape).sort(),
    userPatchKeys: Object.keys(userOverridePatchSchema.shape).sort(),
    snapshotKeys: Object.keys((await snapshot.json()) as object).sort(),
  };
}

if (import.meta.main) {
  const text = `${JSON.stringify(await currentContract(), null, 2)}\n`;
  if (process.argv.includes("--write")) await Bun.write(CONTRACT_PATH, text);
  else process.stdout.write(text);
}

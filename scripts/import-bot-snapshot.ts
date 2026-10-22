/**
 * Restores the settings API's database from the snapshot the bot keeps on disk
 * (`/var/lib/hibana/runtime_state.json`), for a database that starts empty
 * (#93). The old database was unreadable (Neon answered HTTP 402), so the bot's
 * last copy is the only one at hand.
 *
 * What the snapshot holds and is restored: server settings, DM user contexts,
 * personal settings, roles, the block list (ids only), the dashboard's preset
 * visibility and Premium floors, and the budget fallback model.
 *
 * What it does not hold, so is not restored: sessions (everyone logs in again),
 * usernames and avatars (filled in at the next login), block reasons, the
 * ChatGPT account login (sealed in `meta`), logs, published sites, the skill
 * catalog and the bot's available presets. The bot uploads the last three when
 * it starts, so restart it after the switch.
 *
 * The snapshot contains people's own text, so this prints counts only.
 *
 *   ssh <vps> 'cat /var/lib/hibana/runtime_state.json' \
 *     | DATABASE_URL='postgres://…?sslmode=require' bun scripts/import-bot-snapshot.ts -
 */
import {
  catalogPublished,
  isPremium,
  SELECTABLE_PRESETS,
} from "../packages/shared/src/catalog";
import { parseBudgetFallback } from "../packages/shared/src/budget";
import { parseRole } from "../apps/api/src/roles";
import {
  openStore,
  type Store,
  type UserContextEntry,
} from "../apps/api/src/store";
import type { GuildRow, UserOverrideRow } from "../apps/api/src/settings";

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const ids = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];

export type ImportSummary = {
  guilds: number;
  user_contexts: number;
  user_overrides: number;
  users: number;
  blocked_users: number;
  preset_visibility_overrides: number;
  preset_premium_overrides: number;
  version: number;
};

/** Who `blocked_by` names for rows restored here; the snapshot does not keep it. */
export const IMPORT_ACTOR = "bot-snapshot";

/**
 * Dashboard overrides that reproduce the snapshot's effective lists. Only ids
 * that differ from the catalog default get an override, so a later change of
 * the catalog default still applies to the rest, as it did before.
 */
export function presetOverrides(unpublished: string[], premium: string[]) {
  const hidden = new Set(unpublished);
  const floor = new Set(premium);
  const visibility: Record<string, boolean> = {};
  const premiumOverrides: Record<string, boolean> = {};
  for (const { id } of SELECTABLE_PRESETS) {
    const published = !hidden.has(id);
    if (published !== catalogPublished(id)) visibility[id] = published;
    const isFloor = floor.has(id);
    if (isFloor !== isPremium(id, {})) premiumOverrides[id] = isFloor;
  }
  return { visibility, premium: premiumOverrides };
}

export async function importBotSnapshot(
  store: Store,
  input: unknown,
  opts: { now?: number; force?: boolean } = {},
): Promise<ImportSummary> {
  const snapshot = record(input);
  if (typeof snapshot.version !== "number" || !snapshot.guilds)
    throw new Error("Not a bot snapshot: version and guilds are missing");
  if (!opts.force) {
    const existing =
      Object.keys(await store.allGuilds()).length +
      (await store.listUsers()).length;
    if (existing)
      throw new Error(
        "The database already has guilds or users; pass --force to overwrite them",
      );
  }
  const now = opts.now ?? Date.now();

  const guilds = record(snapshot.guilds) as Record<string, GuildRow>;
  const contexts: Record<string, UserContextEntry> = {};
  for (const [id, value] of Object.entries(record(snapshot.user_contexts))) {
    const entry = record(value);
    contexts[id] = {
      text: typeof entry.text === "string" ? entry.text : "",
      persona_override: entry.persona_override === true,
    };
  }
  // Normalizes every guild against the store's defaults, as the API does.
  await store.replaceSnapshot(guilds, contexts);

  const overrides = record(snapshot.user_overrides);
  for (const [id, row] of Object.entries(overrides))
    await store.putUserOverride(id, record(row) as UserOverrideRow);

  let users = 0;
  for (const [id, raw] of Object.entries(record(snapshot.user_roles))) {
    const role = typeof raw === "string" ? parseRole(raw) : null;
    if (!role) continue;
    // The username is blank until the person logs in; login keeps the role.
    await store.upsertUser({
      discord_id: id,
      username: "",
      avatar: null,
      role,
    });
    users++;
  }

  const blocked = ids(snapshot.blocked_users);
  for (const id of blocked)
    await store.setBlocked({
      discord_id: id,
      username: null,
      reason: null,
      blocked_by: IMPORT_ACTOR,
      blocked_at: now,
    });

  const presets = presetOverrides(
    ids(snapshot.unpublished_presets),
    ids(snapshot.premium_presets),
  );
  await store.setMeta("preset_visibility", JSON.stringify(presets.visibility));
  await store.setMeta("preset_premium", JSON.stringify(presets.premium));
  if (snapshot.budget_fallback)
    await store.setMeta(
      "budget_fallback",
      JSON.stringify(parseBudgetFallback(snapshot.budget_fallback)),
    );

  // Above the bot's version, so its next poll cannot match a stale ETag.
  const version = Math.max(await store.version(), snapshot.version) + 1;
  await store.setMeta("snapshot_version", String(version));

  return {
    guilds: Object.keys(guilds).length,
    user_contexts: Object.keys(contexts).length,
    user_overrides: Object.keys(overrides).length,
    users,
    blocked_users: blocked.length,
    preset_visibility_overrides: Object.keys(presets.visibility).length,
    preset_premium_overrides: Object.keys(presets.premium).length,
    version,
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const source = args.find((a) => !a.startsWith("--"));
  if (!source || args.includes("--help") || args.includes("-h")) {
    console.log(
      "Usage: DATABASE_URL=… bun scripts/import-bot-snapshot.ts SNAPSHOT_JSON|- [--force]",
    );
    process.exit(source ? 0 : 1);
  }
  const text =
    source === "-" ? await Bun.stdin.text() : await Bun.file(source).text();
  const url = (process.env.DATABASE_URL ?? "").trim();
  if (!url) throw new Error("DATABASE_URL is not set");
  const store = await openStore(url);
  try {
    const summary = await importBotSnapshot(store, JSON.parse(text), {
      force: args.includes("--force"),
    });
    console.log(JSON.stringify(summary));
  } finally {
    await (store as { close?: () => Promise<void> }).close?.();
  }
}

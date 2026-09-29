import {
  emptyGuild,
  normalizeGuild,
  normalizeUserOverride,
  selectionSchema,
  type GuildRow,
} from "../packages/shared/src/settings";
import { atomicJson } from "../apps/bot/src/io";
import { resolve } from "node:path";

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const entries = (value: unknown) =>
  Object.entries(record(value)).filter(([id]) => /^\d{1,25}$/.test(id));

export function migrateState(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Expected a settings snapshot object");
  const old = record(input);
  const defaults: Partial<GuildRow> = {};
  // Copy legacy global values before materializing each independent server row.
  for (const [key, value] of Object.entries(emptyGuild())) {
    if (old[key] != null)
      Object.assign(defaults, { [key]: old[key] });
  }
  if (typeof old.provider === "string" && typeof old.model === "string")
    defaults.selection = selectionSchema.parse({
      provider: old.provider,
      model: old.model,
      effort: old.effort,
    });
  return {
    defaults,
    guilds: Object.fromEntries(
      entries(old.guilds).map(([id, row]) => [id, normalizeGuild(record(row), normalizeGuild(defaults))]),
    ),
    user_overrides: Object.fromEntries(
      entries(old.user_overrides).map(([id, row]) => [
        id,
        normalizeUserOverride(record(row), normalizeGuild(defaults)),
      ]),
    ),
    user_contexts: Object.fromEntries(
      entries(old.user_contexts).map(([id, value]) => {
        const row = record(value);
        return [
          id,
          {
            text: typeof row.text === "string" ? row.text : "",
            persona_override: row.persona_override === true,
          },
        ];
      }),
    ),
  };
}

if (import.meta.main) {
  const [source, destination] = process.argv.slice(2);
  if (source === "--help" || source === "-h") {
    console.log("Usage: bun scripts/migrate-state.ts OLD_JSON NEW_JSON");
  } else {
    if (!source || !destination)
      throw new Error("Usage: bun scripts/migrate-state.ts OLD_JSON NEW_JSON");
    if (
      resolve(source) === resolve(destination) ||
      (await Bun.file(destination).exists())
    )
      throw new Error(
        "Destination must be a new file; the source is never overwritten",
      );
    const result = migrateState(await Bun.file(source).json());
    await atomicJson(destination, result);
    console.log(
      `Migrated ${Object.keys(result.guilds).length} guilds and ${Object.keys(result.user_overrides).length} personal settings to ${destination}.`,
    );
  }
}

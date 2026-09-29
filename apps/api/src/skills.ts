import { z } from "zod";

export const skillName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/);
export const guildId = z.string().regex(/^[1-9][0-9]{0,19}$/);
const filePath = z
  .string()
  .refine(
    (p) =>
      p === "SKILL.md" ||
      (/^(scripts|references|assets)\//.test(p) &&
        p.split("/").every((s) => s.length > 0 && s !== "." && s !== "..") &&
        !/[\\\x00]/.test(p)),
  );
export const skillRow = z.object({
  guild_id: z.union([guildId, z.literal("0")]),
  name: skillName,
  description: z.string().max(8000),
  builtin: z.boolean(),
  enabled: z.boolean(),
  files: z
    .record(
      filePath,
      z
        .string()
        .max(341336)
        .regex(
          /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
        ),
    )
    .refine(
      (f) => Object.keys(f).length <= 33 && typeof f["SKILL.md"] === "string",
    ),
});
export type SkillRow = z.infer<typeof skillRow>;
export const skillAction = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    name: skillName,
    description: z.string().trim().min(1).max(2000),
    body: z.string().trim().min(1).max(80000),
  }),
  z.object({ action: z.literal("delete"), name: skillName }),
  z.object({
    action: z.literal("enabled"),
    name: skillName,
    enabled: z.boolean(),
  }),
  z.object({
    action: z.literal("import"),
    name: skillName,
    source_guild_id: guildId,
  }),
]);
export type SkillCommand = {
  id: number;
  guild_id: string;
  action: string;
  args: Record<string, unknown>;
  result: Record<string, unknown> | null;
};

export function guildSkills(rows: SkillRow[], id: string): SkillRow[] {
  const merged = new Map(
    rows
      .filter((r) => r.guild_id === "0")
      .map((r) => [r.name, { ...r, guild_id: id }]),
  );
  for (const row of rows.filter((r) => r.guild_id === id))
    merged.set(row.name, row);
  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}

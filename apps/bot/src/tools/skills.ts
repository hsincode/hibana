import { readFile, writeFile, mkdir, readdir, rm, cp } from "node:fs/promises";
import { join, dirname } from "node:path";
import { parse, stringify } from "yaml";
import type { Config } from "../config";
import type { Context, Json } from "../types";
import { atomicJson, readJson, Serial } from "../io";
import { safePath, filesUnder } from "./sandbox";
type Skill = {
  name: string;
  description: string;
  body: string;
  root: string;
  builtin: boolean;
  enabled: boolean;
};
export class Skills {
  private serial = new Serial();
  private disabled: Record<string, string[]> = {};
  constructor(private config: Config) {}
  async load() {
    this.disabled = await readJson(
      join(this.config.customSkillsRoot, "disabled.json"),
      {},
    );
  }
  private scope(ctx: Pick<Context, "guildId" | "channelId">) {
    const id = ctx.guildId ?? ctx.channelId;
    if (!/^\d+$/.test(id)) throw new Error("Invalid scope");
    return `${ctx.guildId ? "guilds" : "dms"}/${id}`;
  }
  private custom(ctx: Context) {
    return join(this.config.customSkillsRoot, this.scope(ctx));
  }
  private name(raw: unknown) {
    if (
      typeof raw !== "string" ||
      !/^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/.test(raw)
    )
      throw new Error("Invalid skill name");
    return raw;
  }
  async list(ctx: Context): Promise<Skill[]> {
    const map = new Map<string, Skill>();
    for (const [root, builtin] of [
      [this.config.skillsRoot, true],
      [this.custom(ctx), false],
    ] as const) {
      const dirs = await readdir(root, { withFileTypes: true }).catch(() => []);
      for (const dir of dirs) {
        if (!dir.isDirectory() || dir.isSymbolicLink()) continue;
        const path = await safePath(root, `${dir.name}/SKILL.md`);
        let source: string;
        try {
          source = await readFile(path, "utf8");
        } catch {
          continue;
        }
        const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(
          source,
        );
        if (!match) continue;
        let front: Json;
        try {
          front = parse(match[1]!);
        } catch {
          continue;
        }
        if (typeof front.description !== "string") continue;
        map.set(dir.name, {
          name: dir.name,
          description: front.description,
          body: source,
          root: join(root, dir.name),
          builtin,
          enabled: !(this.disabled[this.scope(ctx)] ?? []).includes(dir.name),
        });
      }
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
  async catalog(ctx: Context) {
    return (await this.list(ctx))
      .filter((s) => s.enabled)
      .map((s) => `- ${s.name}: ${s.description}`)
      .join("\n");
  }
  async execute(name: string, a: Json, ctx: Context): Promise<unknown> {
    if (name === "list_skills")
      return (await this.list(ctx)).map(({ root, body, ...s }) => s);
    const skillName = this.name(a.name);
    const existing = (await this.list(ctx)).find((s) => s.name === skillName);
    if (name === "use_skill" || name === "read_skill_file") {
      if (!existing || !existing.enabled)
        throw new Error("Skill not found or disabled");
      if (name === "use_skill") {
        await ctx.progress?.(`Skill: ${skillName}`);
        return {
          name: skillName,
          content: existing.body,
          files: (await filesUnder(existing.root, 500)).map((f) => f.path),
          base: existing.builtin
            ? `/skills/${skillName}`
            : `.skills/${skillName}`,
        };
      }
      const path = await safePath(existing.root, String(a.path));
      return { content: (await readFile(path, "utf8")).slice(0, 80000) };
    }
    if (ctx.depth > 0) throw new Error("Subagents cannot modify skills");
    return this.serial.run(async () => {
      if (name === "set_skill_enabled") {
        if (!existing) throw new Error("Skill not found");
        const set = new Set(this.disabled[this.scope(ctx)] ?? []);
        if (a.enabled) set.delete(skillName);
        else set.add(skillName);
        this.disabled[this.scope(ctx)] = [...set];
        await atomicJson(
          join(this.config.customSkillsRoot, "disabled.json"),
          this.disabled,
        );
        return { ok: true };
      }
      const root = await safePath(this.custom(ctx), skillName);
      if (existing?.builtin) throw new Error("Built-in skills are read-only");
      if (name === "delete_skill") {
        if (!existing) throw new Error("Skill not found");
        await rm(root, { recursive: true });
        return { ok: true };
      }
      if (name === "import_skill") {
        if (existing) throw new Error("Skill already exists");
        if (!/^\d+$/.test(String(a.source_guild_id)))
          throw new Error("Invalid source guild");
        const source = await safePath(
          join(
            this.config.customSkillsRoot,
            "guilds",
            String(a.source_guild_id),
          ),
          skillName,
        );
        for (const file of await filesUnder(source, 33))
          await safePath(source, file.path);
        await mkdir(dirname(root), { recursive: true });
        await cp(source, root, { recursive: true, dereference: false });
        return { ok: true };
      }
      if (name === "write_skill_file") {
        if (!existing) throw new Error("Skill not found");
        const path = String(a.path);
        if (!/^(scripts|references|assets)\//.test(path))
          throw new Error(
            "Supporting files must be under scripts, references or assets",
          );
        const target = await safePath(root, path);
        const content = String(a.content ?? "");
        if (Buffer.byteLength(content) > 256000)
          throw new Error("Skill file exceeds 256 KB");
        if (!content) await rm(target, { force: true });
        else {
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, content, { mode: 0o600 });
        }
        return { ok: true };
      }
      if (name !== "create_skill" && name !== "edit_skill")
        throw new Error("Unknown skill operation");
      if (name === "create_skill" && existing)
        throw new Error("Skill already exists");
      if (name === "edit_skill" && !existing)
        throw new Error("Skill not found");
      const oldBody =
        existing?.body.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "") ?? "";
      const description = String(
          a.description ?? existing?.description ?? "",
        ).trim(),
        body = String(a.body ?? oldBody).trim();
      if (
        !description ||
        description.length > 2000 ||
        !body ||
        body.length > 80000
      )
        throw new Error(
          "Description and body are required and must fit skill limits",
        );
      await mkdir(root, { recursive: true });
      await writeFile(
        join(root, "SKILL.md"),
        `---\n${stringify({ name: skillName, description })}---\n\n${body}\n`,
        { mode: 0o600 },
      );
      return { ok: true, name: skillName };
    });
  }
  async materialize(ctx: Context, workspace: string) {
    for (const skill of await this.list(ctx))
      if (!skill.builtin && skill.enabled) {
        const target = await safePath(workspace, `.skills/${skill.name}`);
        await mkdir(dirname(target), { recursive: true });
        await cp(skill.root, target, {
          recursive: true,
          force: true,
          dereference: false,
        });
      }
  }
  async export(guildIds: string[]) {
    const rows: Json[] = [];
    for (const guildId of ["0", ...guildIds]) {
      const ctx = {
        guildId,
        channelId: guildId,
        userId: "0",
        botId: "0",
        thread: false,
        depth: 0,
        delivered: false,
      } satisfies Context;
      for (const skill of await this.list(ctx)) {
        if (guildId === "0" && !skill.builtin) continue;
        // Enabled builtins inherit the global row; only disabled scopes need overrides.
        if (guildId !== "0" && skill.builtin && skill.enabled) continue;
        const files: Record<string, string> = {};
        for (const f of (await filesUnder(skill.root, 500))
          .filter(
            (f) =>
              f.path === "SKILL.md" ||
              /^(scripts|references|assets)\//.test(f.path),
          )
          .sort(
            (a, b) =>
              Number(b.path === "SKILL.md") - Number(a.path === "SKILL.md") ||
              a.path.localeCompare(b.path),
          )
          .slice(0, 33)) {
          if (f.bytes <= 256000)
            files[f.path] = (
              await readFile(await safePath(skill.root, f.path))
            ).toString("base64");
        }
        if (files["SKILL.md"])
          rows.push({
            guild_id: guildId,
            name: skill.name,
            description: skill.description,
            builtin: skill.builtin,
            enabled: skill.enabled,
            files,
          });
      }
    }
    return rows;
  }
}

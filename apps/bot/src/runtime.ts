import {
  MODEL_PRESETS,
  canonicalPresetId,
  unpublishedPresetIds,
  premiumPresetIds,
} from "@hibana/shared/catalog";
import {
  applyPatch,
  applyUserOverridePatch,
  normalizeGuild,
  normalizeUserOverride,
  patchPresetIds,
  emptyGuild,
  emptyUserOverride,
  guildPatchSchema,
  userOverridePatchSchema,
  type GuildRow,
  type GuildPatch,
  type UserOverrideRow,
} from "@hibana/shared/settings";
import type { Config, Selection } from "./config";
import { atomicJson, readJson, Serial } from "./io";
import { ultracodeActive } from "./ultracode";
export type Snapshot = {
  chatgpt_available?: boolean;
  version?: number;
  defaults?: Partial<GuildRow>;
  guilds: Record<string, GuildRow>;
  user_contexts: Record<string, { text: string; persona_override: boolean }>;
  user_overrides: Record<string, UserOverrideRow>;
  blocked_users: string[];
  user_roles: Record<string, string>;
  unpublished_presets: string[];
  premium_presets: string[];
  artifact_commands?: {
    id: number;
    token: string;
    guild_id: string | null;
    action: string;
  }[];
  skill_commands?: {
    id: number;
    guild_id: string;
    action: string;
    args: Record<string, unknown>;
  }[];
};
export class Runtime {
  snapshot: Snapshot = {
    guilds: {},
    user_contexts: {},
    user_overrides: {},
    blocked_users: [],
    user_roles: {},
    unpublished_presets: unpublishedPresetIds({}),
    premium_presets: premiumPresetIds({}),
  };
  private serial = new Serial();
  onChange?: (guildId?: string) => void;
  constructor(readonly config: Config) {}
  async load() {
    if (this.config.statePath) {
      this.replace(await readJson(this.config.statePath, this.snapshot));
      await this.persist();
    }
  }
  replace(raw: Partial<Snapshot>) {
    const previous = this.snapshot;
    const defaults = normalizeGuild(raw.defaults, this.defaultSettings());
    this.snapshot = {
      ...previous,
      ...raw,
      guilds: Object.fromEntries(
        Object.entries(raw.guilds ?? {}).map(([k, v]) => [
          k,
          normalizeGuild(v, defaults),
        ]),
      ),
      user_overrides: Object.fromEntries(
        Object.entries(raw.user_overrides ?? {}).map(([k, v]) => [
          k,
          normalizeUserOverride(v, defaults),
        ]),
      ),
    };
    for (const id of new Set([
      ...Object.keys(previous.guilds),
      ...Object.keys(this.snapshot.guilds),
    ])) {
      const a = previous.guilds[id],
        b = this.snapshot.guilds[id];
      if (JSON.stringify([a?.selection, a?.effort, a?.ultra_mode, a?.multi_agent]) !==
          JSON.stringify([b?.selection, b?.effort, b?.ultra_mode, b?.multi_agent]))
        this.onChange?.(id);
    }
  }
  guild(id?: string) {
    return normalizeGuild(id ? this.snapshot.guilds[id] : null,
      normalizeGuild(this.snapshot.defaults, this.defaultSettings()));
  }
  async initializeGuild(id: string) {
    return this.serial.run(async () => {
      if (this.snapshot.guilds[id]) return;
      if (this.config.webApiUrl) {
        // An empty patch creates a concrete row without replacing an existing one.
        await this.remote(`/internal/guilds/${id}`, "PATCH", {});
        this.replace(await this.remote("/internal/snapshot", "GET") as Snapshot);
      } else {
        this.snapshot.guilds[id] = this.guild(id);
        await this.persist();
      }
    });
  }
  defaultSettings(): GuildRow {
    return { ...emptyGuild(), selection: this.config.selection,
      effort: this.config.selection.effort ?? "default",
      ultra_mode: this.config.ultraMode || this.config.multiAgent, multi_agent: this.config.multiAgent,
      subagent_enabled: this.config.subagentEnabled,
      jev_enabled: this.config.jevEnabled, jev_task_enabled: this.config.jevTaskEnabled,
      suppress_embeds: this.config.suppressEmbeds, temperature: this.config.temperature,
      exa_mode: this.config.exaMode, extra_triggers: [...this.config.extraTriggers],
      thread_history_max_age_secs: this.config.threadHistoryAge };
  }
  role(userId: string) {
    if ((process.env.WEB_ADMIN_IDS || "").split(",").includes(userId))
      return "administrator";
    return this.snapshot.user_roles[userId] || "free";
  }
  canSelect(preset: string, userId: string) {
    const id = canonicalPresetId(preset);
    const p = MODEL_PRESETS.find((p) => p.id === id);
    if (!p || p.provider === "grok_free") return false;
    return (
      !this.snapshot.unpublished_presets.includes(id) &&
      (!this.snapshot.premium_presets.includes(id) ||
        ["premium", "moderator", "administrator"].includes(
          this.role(userId),
        )) &&
      this.providerAvailable(p.provider)
    );
  }
  available() {
    return MODEL_PRESETS.filter(
      (p) => this.providerAvailable(p.provider),
    ).map((p) => p.id);
  }
  providerAvailable(provider: string) {
    return provider === "chatgpt"
      ? Boolean(this.config.webApiUrl && this.snapshot.chatgpt_available)
      : Boolean(this.config.endpoints[provider]?.apiKey);
  }
  resolve(guildId?: string, userId?: string) {
    const guild = this.guild(guildId);
    // null on a personal field is デフォルト: follow this server, or the
    // process default in a DM. Only a stored non-null value overrides.
    const saved = userId ? this.snapshot.user_overrides[userId] : undefined;
    const user = saved ? normalizeUserOverride(saved) : emptyUserOverride();
    const pick = <T>(override: T | null | undefined, fallback: T): T =>
      override == null ? fallback : override;
    let selection = pick(user.selection, guild.selection!);
    const effort = pick(user.effort, guild.effort);
    const preset = MODEL_PRESETS.find(
      (p) => p.provider === selection.provider && p.model === selection.model,
    );
    const unavailable = (
      preset &&
      userId &&
      this.snapshot.premium_presets.includes(preset.id) &&
      !["premium", "moderator", "administrator"].includes(this.role(userId))
    );
    if (unavailable) selection = this.config.selection;
    else selection = { ...selection, effort: effort ?? selection.effort };
    // Resolved Multi still implies Ultra, including when only one of the two
    // switches was stored on the personal row.
    const multiAgent = pick(user.multi_agent, guild.multi_agent!);
    const context = user.context ??
      (guildId ? guild.context : this.snapshot.user_contexts[userId || ""] ?? null);
    const subagentEnabled = pick(user.subagent_enabled, guild.subagent_enabled!);
    const ultraMode = multiAgent || pick(user.ultra_mode, guild.ultra_mode!);
    return {
      ...guild,
      selection: selection as Selection,
      service_tier: pick(user.service_tier, guild.service_tier!),
      subagent_enabled: subagentEnabled,
      ultra_mode: ultraMode,
      multi_agent: multiAgent,
      // Whether this scope's turns run as Ultracode (xhigh + workflows);
      // selection keeps the stored effort.
      ultracode: ultracodeActive(this.config, { subagent_enabled: subagentEnabled, ultra_mode: ultraMode, multi_agent: multiAgent }),
      multi_agent_roles: pick(user.multi_agent_roles, guild.multi_agent_roles!),
      subagent_model: pick(user.subagent_model, guild.subagent_model!),
      subagent_effort: pick(user.subagent_effort, guild.subagent_effort!),
      jev_enabled: pick(user.jev_enabled, guild.jev_enabled!),
      jev_task_enabled: pick(user.jev_task_enabled, guild.jev_task_enabled!),
      context,
      suppress_embeds: guild.suppress_embeds!,
      temperature: guild.temperature!,
      exa_mode: guild.exa_mode!,
    };
  }
  async patch(guildId: string, raw: unknown, userId: string) {
    const patch = guildPatchSchema.parse(raw);
    if (
      patch.preset &&
      patch.preset !== "reset" &&
      !this.canSelect(patch.preset, userId)
    )
      throw new Error("This model is unavailable for your account");
    if (patch.subagent_model?.mode === "fixed" && !this.canSelect(patch.subagent_model.preset, userId))
      throw new Error("This subagent model is unavailable for your account");
    // Per-role Multi-Agent presets need the same plan/visibility check.
    for (const id of patchPresetIds({ multi_agent_roles: patch.multi_agent_roles }))
      if (!this.canSelect(id, userId))
        throw new Error("This subagent model is unavailable for your account");
    return this.serial.run(async () => {
      if (this.config.webApiUrl) {
        await this.remote(`/internal/guilds/${guildId}`, "PATCH", patch);
        const fresh = await this.remote("/internal/snapshot", "GET");
        this.replace(fresh as Snapshot);
      } else {
        const row = applyPatch(this.guild(guildId), patch, this.defaultSettings());
        const next = {
          ...this.snapshot,
          guilds: { ...this.snapshot.guilds, [guildId]: row },
        };
        this.replace(next);
        await this.persist();
      }
      return this.guild(guildId);
    });
  }
  async setContext(
    guildId: string | undefined,
    userId: string,
    raw: { text?: string; persona_override?: boolean; clear?: boolean },
  ) {
    if (guildId)
      return this.patch(
        guildId,
        {
          context_text: raw.text,
          persona_override: raw.persona_override,
          context_clear: raw.clear,
        },
        userId,
      );
    const patch = userOverridePatchSchema.parse({
      context_text: raw.text,
      persona_override: raw.persona_override,
      context_clear: raw.clear,
    });
    return this.serial.run(async () => {
      if (this.config.webApiUrl) {
        await this.remote(`/internal/users/${userId}/settings`, "PATCH", patch);
        this.replace(
          (await this.remote("/internal/snapshot", "GET")) as Snapshot,
        );
      } else {
        const row = applyUserOverridePatch(
          normalizeUserOverride(this.snapshot.user_overrides[userId], this.defaultSettings()),
          patch,
          this.defaultSettings(),
        );
        this.snapshot.user_overrides[userId] = row;
        await this.persist();
      }
    });
  }
  async persist() {
    if (this.config.statePath)
      await atomicJson(this.config.statePath, this.snapshot);
  }
  async remote(
    path: string,
    method: string,
    body?: unknown,
    signal?: AbortSignal,
  ) {
    const res = await fetch(`${this.config.webApiUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.config.internalToken}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
        : AbortSignal.timeout(30000),
      redirect: "error",
    });
    if (!res.ok)
      throw new Error(`Settings API ${method} ${path}: HTTP ${res.status}`);
    return res.status === 204 ? {} : res.json();
  }
}

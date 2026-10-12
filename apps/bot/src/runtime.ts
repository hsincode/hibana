import {
  MODEL_PRESETS,
  canonicalPresetId,
  deprecatedPreset,
  isAutoRoute,
  serverShared,
  subagentsUnsupported,
  unpublishedPresetIds,
  premiumPresetIds,
  WORKSPACE_PROVIDER,
} from "@hibana/shared/catalog";
import {
  applyPatch,
  applyUserOverridePatch,
  effectiveSubagentMode,
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
import { ultracodeActive, workflowsEnabled } from "./ultracode";
import { harnessFor } from "./claude/select";
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
      // Restoring is not a change: stored conversations were written under
      // these settings, and reporting every guild here would clear them all
      // on each start (#59).
      this.replace(await readJson(this.config.statePath, this.snapshot), false);
      if (!this.config.webApiUrl) this.withholdWorkspacePresets();
      await this.persist();
    }
  }
  /** Without the settings API the two preset lists are only ever what the
   *  state file holds: nothing on the bot publishes a preset or lifts its
   *  plan floor. A file written before the Anthropic Workspace presets existed
   *  (#76) names none of them, and would offer them to every member as soon as
   *  the key is set. They are put back as the catalog ships them; the stored
   *  state of every other preset is left as it is. */
  private withholdWorkspacePresets() {
    const workspace = new Set(MODEL_PRESETS.filter((p) => p.provider === WORKSPACE_PROVIDER).map((p): string => p.id));
    for (const [list, shipped] of [
      ["unpublished_presets", unpublishedPresetIds({})],
      ["premium_presets", premiumPresetIds({})],
    ] as const) {
      const stored = this.snapshot[list];
      const missing = shipped.filter((id) => workspace.has(id) && !stored.includes(id));
      if (missing.length) this.snapshot[list] = [...stored, ...missing];
    }
  }
  /** `notify: false` adopts a snapshot as the baseline that later ones are
   *  compared with, without reporting its guilds as changed. */
  replace(raw: Partial<Snapshot>, notify = true) {
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
      if (notify &&
          JSON.stringify([a?.selection, a?.effort, a?.ultra_mode, a?.multi_agent]) !==
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
  /** Whether this user's turns may run the preset. Picking a preset needs
   *  canSelect; a `server_shared` preset that a server selected also serves
   *  every member (#35). The auto preset covers the models it routes to. */
  canUse(preset: string, guildId: string | undefined, userId: string) {
    if (this.canSelect(preset, userId)) return true;
    const p = MODEL_PRESETS.find((p) => p.id === preset);
    const chosen = guildId ? this.guild(guildId).selection : undefined;
    const server = chosen && MODEL_PRESETS.find(
      (x) => x.provider === chosen.provider && x.model === chosen.model,
    );
    return Boolean(
      p && server && serverShared(p.id) && serverShared(server.id) &&
      (server.id === p.id || (isAutoRoute(server) && p.provider === server.provider)) &&
      !this.snapshot.unpublished_presets.includes(p.id) &&
      this.providerAvailable(p.provider),
    );
  }
  /** Whether this user may newly pick the preset: `canSelect`, minus the
   *  deprecated providers (#67, ADR-0010). Only the entrances that choose a
   *  model ask this (`/switch`, `set_bot_model`). `canSelect` and `canUse`
   *  keep their meaning, so a saved deprecated selection still runs, and a
   *  child agent can still inherit a deprecated parent. */
  selectable(preset: string, userId: string) {
    return this.canSelect(preset, userId) && !deprecatedPreset(preset);
  }
  /** What `selectable` leaves, in catalog order. Empty for a user without the
   *  plan, or while the bot has no Anthropic key. The Anthropic Workspace
   *  presets (#76) are among them once they are published and keyed. */
  selectablePresets(userId: string) {
    return MODEL_PRESETS.filter((p) => this.selectable(p.id, userId));
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
    // A member without the plan keeps a server's `server_shared` pick, but
    // not one stored on their own row (e.g. after losing the plan).
    const shared = preset && user.selection == null && guildId && serverShared(preset.id);
    const unavailable = (
      preset &&
      userId &&
      !shared &&
      this.snapshot.premium_presets.includes(preset.id) &&
      !["premium", "moderator", "administrator"].includes(this.role(userId))
    );
    if (unavailable) selection = this.config.selection;
    else selection = { ...selection, effort: effort ?? selection.effort };
    // Resolved Multi still implies Ultra, including when only one of the two
    // switches was stored on the personal row.
    // The Claude harness has one form of delegation, its Agent tool (#68). A
    // stored Ultra or Multi-Agent choice counts as "on" there; neither the
    // Workflow tool nor the collaboration tools are offered.
    const harness = harnessFor(selection, this.config);
    const claude = harness === "claude", workspace = harness === "workspace";
    const storedMulti = pick(user.multi_agent, guild.multi_agent!);
    const stored = {
      subagent_enabled: pick(user.subagent_enabled, guild.subagent_enabled!),
      ultra_mode: storedMulti || pick(user.ultra_mode, guild.ultra_mode!),
      multi_agent: storedMulti,
    };
    const multiAgent = !claude && !workspace && storedMulti;
    const context = user.context ??
      (guildId ? guild.context : this.snapshot.user_contexts[userId || ""] ?? null);
    // The stored switches are kept; they apply again under another provider.
    // On the Codex-style harness an Anthropic turn still runs without
    // subagents (#35), which is what `ANTHROPIC_HARNESS=codex` goes back to.
    // An Anthropic Workspace session (#76) has none of Hibana's own
    // delegation, so all three resolve to off there, and `ultracode` with
    // them: no Agent tool, no Workflow tool, no team, no forced xhigh.
    const subagentEnabled = !workspace && (claude || !subagentsUnsupported(selection.provider)) &&
      stored.subagent_enabled;
    const ultraMode = !claude && !workspace && stored.ultra_mode;
    // Haiku Ultra: the session is created with Managed Agents' dynamic
    // workflows. It takes a stored Ultra on Haiku 5.5 and the same process
    // switches as Hibana's own workflows, so WORKFLOWS_ENABLED=false (or
    // tools or subagents off) stops it too.
    const workspaceUltra = workspace && workflowsEnabled(this.config, stored) &&
      effectiveSubagentMode(stored, selection) === "ultra";
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
      // Present for Workspace only, so what `/info` and `get_bot_settings`
      // print for every other provider is what it was.
      ...(workspace ? { workspace_ultra: workspaceUltra } : {}),
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

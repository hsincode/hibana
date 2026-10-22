import { createHash } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import type { BetaManagedAgentsAgent } from "@anthropic-ai/sdk/resources/beta/agents/agents";
import type { BetaMonetaryAmount } from "@anthropic-ai/sdk/resources/beta/beta";
import type {
  BetaEnvironment,
  BetaLimitedNetworkParams,
  BetaUnrestrictedNetwork,
} from "@anthropic-ai/sdk/resources/beta/environments/environments";
import type {
  BetaManagedAgentsAgentWithOverridesParams,
  BetaManagedAgentsBudgetLimit,
  BetaManagedAgentsSession,
} from "@anthropic-ai/sdk/resources/beta/sessions/sessions";
import {
  ultraSupported,
  WORKSPACE_PROVIDER,
  WORKSPACE_ULTRA_MODEL,
} from "@hibana/shared/catalog";
import type { Logger } from "pino";
import { recommendedEffort, type Selection } from "../config";
import { atomicJson, readJson, Serial } from "../io";
import { promptCacheKey, wireEffort } from "../llm";
import { ProviderError } from "../llm-errors";
import { apiErrorInfo, toProviderError } from "./client";
import type { WorkspaceVariant } from "./select";

/** The tool list a session is created with; the tools side builds it. */
export type SessionTools = NonNullable<
  BetaManagedAgentsAgentWithOverridesParams["tools"]
>;
export type WorkspaceNetworking =
  BetaUnrestrictedNetwork | BetaLimitedNetworkParams;

const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type WorkspaceEffort = (typeof EFFORT_LEVELS)[number];

/** The effort a session is created with. Always explicit, as on the Claude
 *  harness: the default differs by model, and `none` has no counterpart here,
 *  so it becomes the lowest level. */
export function workspaceEffort(selection: Selection): WorkspaceEffort {
  const wire = wireEffort(
    selection.model,
    selection.effort ?? recommendedEffort(selection.model, selection.provider),
  );
  return (EFFORT_LEVELS as readonly string[]).includes(wire ?? "")
    ? (wire as WorkspaceEffort)
    : "low";
}

/** An amount the API reports, in whole US cents. Nothing when it is missing
 *  or in a form this code does not count in: unknown, never zero. */
export const cents = (
  amount?: BetaMonetaryAmount | null,
): number | undefined =>
  amount?.currency === "USD" &&
  typeof amount.amount === "string" &&
  /^\d+$/.test(amount.amount)
    ? Number(amount.amount)
    : undefined;
/** A session budget of that many cents. The API takes the amount as a string
 *  of minor units, at least one. */
export const budgetLimit = (cents: number): BetaManagedAgentsBudgetLimit => ({
  type: "limit",
  max_list_cost: {
    amount: String(Math.max(1, Math.round(cents))),
    currency: "USD",
  },
});

/** Whose resources these are: how their names start, and the `metadata.app`
 *  they and their sessions carry. The bot's own unless another is given,
 *  which only the smoke script does: it creates through this class so that
 *  what it checks is the bot's code, and removes what it created afterwards.
 *  Nothing is adopted across two identities, by name or from the file. */
export type WorkspaceIdentity = { prefix: string; app: string };
const BOT_IDENTITY: WorkspaceIdentity = {
  prefix: "hibana-workspace",
  app: "hibana",
};

type StoredResource = { id: string; spec: string };
type StoredAgent = StoredResource & { version: number };
type Stored = {
  version: 1;
  /** The ids belong to one API host; another host starts again. */
  base_url: string;
  /** Whose ids these are, when not the bot's. A file of another identity is
   *  read as empty. */
  app?: string;
  environment?: StoredResource;
  agents: Partial<Record<WorkspaceVariant, StoredAgent>>;
};

// Stored with the agent only to satisfy the required field. Every session
// replaces the model, the system prompt and the tools with its own.
const AGENT_MODEL = WORKSPACE_ULTRA_MODEL;
const ENVIRONMENT_DESCRIPTION =
  "Cloud container for Hibana's Anthropic Workspace sessions.";
const AGENT_DESCRIPTION: Record<WorkspaceVariant, string> = {
  plain:
    "Hibana's Anthropic Workspace agent. Each session sets its own model, prompt and tools.",
  ultra:
    "Hibana's Anthropic Workspace agent with dynamic workflows. Each session sets its own prompt and tools.",
};
/** What the Haiku Ultra agent is created with. Workflows only: the block's
 *  defaults would also enable subagents. */
export const ULTRA_MULTIAGENT = {
  type: "multiagent_20261001" as const,
  workflows: { type: "enabled" as const },
  subagents: { type: "disabled" as const },
  advisor: { type: "disabled" as const },
};
// How many listed resources are looked through for one to adopt. Missing one
// beyond that only creates another with the same definition.
const LIST_SCAN_MAX = 500;

/** Names a definition: the first 8 hex digits of its creation request's hash
 *  (without the name and metadata, which carry this value). */
const specOf = (request: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(request))
    .digest("hex")
    .slice(0, 8);

type MultiagentLike =
  | {
      type: string;
      workflows?: { type: string; predefined_agents?: unknown[] | null } | null;
      subagents?: { type: string } | null;
      advisor?: { type: string } | null;
    }
  | null
  | undefined;
/** What a resolved multiagent block has that its variant must not, in a fixed
 *  word for the log, or nothing when it is as intended. */
export function multiagentMismatch(
  multiagent: MultiagentLike,
  variant: WorkspaceVariant,
): string | undefined {
  if (!multiagent) return variant === "ultra" ? "no_multiagent" : undefined;
  if (multiagent.type !== "multiagent_20261001") return "other_multiagent_type";
  if (multiagent.subagents?.type !== "disabled") return "subagents_enabled";
  if (multiagent.advisor?.type !== "disabled") return "advisor_enabled";
  const workflows = multiagent.workflows?.type === "enabled";
  if (variant === "plain") return workflows ? "workflows_enabled" : undefined;
  if (!workflows) return "workflows_disabled";
  return multiagent.workflows?.predefined_agents?.length
    ? "predefined_agents"
    : undefined;
}
// A dated snapshot of the same model is the same model.
const sameModel = (actual: string | undefined, wanted: string) =>
  actual === wanted || !!actual?.startsWith(`${wanted}-`);

/**
 * The two agents and the one environment every Workspace session is created
 * from (#76). They are created on the first turn that needs them, never at
 * startup, and their ids are kept in a file under the data directory so a
 * restart reuses them. A definition that changes gets a new resource; the old
 * one is left alone for the sessions that still run on it.
 */
export class WorkspaceResources {
  private serial = new Serial();
  private stored?: Stored;
  private identity: WorkspaceIdentity;
  constructor(
    private client: Anthropic,
    private options: {
      path: string;
      baseUrl: string;
      networking: WorkspaceNetworking;
      log?: Logger;
      identity?: WorkspaceIdentity;
    },
  ) {
    this.identity = options.identity ?? BOT_IDENTITY;
  }

  /** The environment and the variant's agent, created if they do not exist.
   *  Calls are serialized: a turn that arrives while another is creating the
   *  resources waits and uses the same ones. */
  ensure(
    variant: WorkspaceVariant,
    signal?: AbortSignal,
  ): Promise<{
    environmentId: string;
    agent: { id: string; version: number };
  }> {
    return this.serial.run(async () => {
      const stored = await this.load();
      const environment = await this.environment(stored, signal);
      const agent = await this.agent(stored, variant, signal);
      return {
        environmentId: environment.id,
        agent: { id: agent.id, version: agent.version },
      };
    });
  }

  /** Creates a session with the turn's model, prompt, tools and a budget.
   *  The request is never retried by the SDK: a repeated create would leave a
   *  second, unknown session behind. */
  async createSession(
    spec: {
      variant: WorkspaceVariant;
      selection: Selection;
      system: string;
      tools: SessionTools;
      budgetCents: number;
      channelId: string;
    },
    signal?: AbortSignal,
  ): Promise<{ session: BetaManagedAgentsSession; effort?: string }> {
    // The last gate for Haiku Ultra: the workflow agent never runs another model.
    if (spec.variant === "ultra" && !ultraSupported(spec.selection))
      throw new Error("Haiku Ultra sessions run on claude-haiku-5-5 only");
    const effort = workspaceEffort(spec.selection);
    // A digest, so the channel's Discord id is not sent to the provider.
    const channel = promptCacheKey(spec.channelId);
    for (let retried = false; ; retried = true) {
      const resources = await this.ensure(spec.variant, signal);
      let session: BetaManagedAgentsSession;
      try {
        session = await this.client.beta.sessions.create(
          {
            agent: {
              type: "agent_with_overrides",
              id: resources.agent.id,
              version: resources.agent.version,
              model: { id: spec.selection.model, effort },
              system: spec.system,
              tools: spec.tools,
            },
            environment_id: resources.environmentId,
            budget: budgetLimit(spec.budgetCents),
            metadata: {
              app: this.identity.app,
              variant: spec.variant,
              channel,
            },
            title: `${this.identity.app} ${spec.variant} ${channel.slice(0, 8)}`,
          },
          { maxRetries: 0, signal },
        );
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        const status = apiErrorInfo(error).status;
        // An agent or environment archived outside the bot is reported here.
        // Only what is confirmed gone is created again, and only once.
        if (
          !retried &&
          (status === 404 || status === 400) &&
          (await this.forgetMissing(spec.variant, resources, signal))
        )
          continue;
        throw toProviderError(error, "request", spec.selection.model);
      }
      await this.verify(session, spec, signal);
      return { session, effort };
    }
  }

  private async load(): Promise<Stored> {
    if (this.stored) return this.stored;
    const { app } = this.identity;
    // The bot's own file carries no label and stays as it was written before
    // there was one.
    const empty = (): Stored => ({
      version: 1,
      base_url: this.options.baseUrl,
      ...(app !== BOT_IDENTITY.app && { app }),
      agents: {},
    });
    const resource = (value: unknown): StoredResource | undefined => {
      const v = value as Partial<StoredResource> | null | undefined;
      return v && typeof v.id === "string" && typeof v.spec === "string"
        ? { id: v.id, spec: v.spec }
        : undefined;
    };
    let stored = empty();
    try {
      const raw = await readJson<Partial<Stored> | null>(
        this.options.path,
        null,
      );
      if (
        raw?.version === 1 &&
        raw.base_url === this.options.baseUrl &&
        (raw.app ?? BOT_IDENTITY.app) === app
      ) {
        stored.environment = resource(raw.environment);
        for (const variant of ["plain", "ultra"] as const) {
          const agent = resource(raw.agents?.[variant]);
          const version = raw.agents?.[variant]?.version;
          if (agent && typeof version === "number")
            stored.agents[variant] = { ...agent, version };
        }
      }
    } catch {
      // A damaged file costs one lookup: the resources are found again by name.
      this.options.log?.warn(
        { path: this.options.path },
        "workspace resources file is unreadable; looking the resources up again",
      );
      stored = empty();
    }
    return (this.stored = stored);
  }
  private save() {
    return atomicJson(this.options.path, this.stored);
  }

  private async environment(
    stored: Stored,
    signal?: AbortSignal,
  ): Promise<StoredResource> {
    const request = {
      config: { type: "cloud" as const, networking: this.options.networking },
      description: ENVIRONMENT_DESCRIPTION,
    };
    const spec = specOf(request);
    if (stored.environment?.spec === spec) return stored.environment;
    const { prefix, app } = this.identity;
    const name = `${prefix}-env-${spec}`;
    const matches = (e: BetaEnvironment) =>
      e.name === name &&
      e.archived_at === null &&
      e.metadata?.app === app &&
      e.metadata?.spec === spec &&
      this.networkingMatches(e);
    const environment = await this.call(
      signal,
      async () =>
        (await this.find(
          this.client.beta.environments.list({}, { signal }),
          matches,
        )) ??
        (await this.client.beta.environments.create(
          { name, ...request, metadata: { app, spec } },
          { maxRetries: 0, signal },
        )),
    );
    stored.environment = { id: environment.id, spec };
    await this.save();
    return stored.environment;
  }

  private async agent(
    stored: Stored,
    variant: WorkspaceVariant,
    signal?: AbortSignal,
  ): Promise<StoredAgent> {
    const request = {
      model: AGENT_MODEL,
      description: AGENT_DESCRIPTION[variant],
      ...(variant === "ultra" && { multiagent: ULTRA_MULTIAGENT }),
    };
    const spec = specOf(request);
    const kept = stored.agents[variant];
    if (kept?.spec === spec) return kept;
    const { prefix, app } = this.identity;
    const name = `${prefix}-${variant}-${spec}`;
    // An agent edited outside the bot keeps its name and metadata, so what is
    // adopted is checked against the definition, not only against its labels.
    const matches = (a: BetaManagedAgentsAgent) =>
      a.name === name &&
      a.archived_at === null &&
      a.metadata?.app === app &&
      a.metadata?.spec === spec &&
      sameModel(a.model?.id, AGENT_MODEL) &&
      !a.mcp_servers?.length &&
      !a.skills?.length &&
      !multiagentMismatch(a.multiagent, variant);
    const agent = await this.call(
      signal,
      async () =>
        (await this.find(
          this.client.beta.agents.list({}, { signal }),
          matches,
        )) ??
        (await this.client.beta.agents.create(
          { name, ...request, metadata: { app, variant, spec } },
          { maxRetries: 0, signal },
        )),
    );
    const mismatch = multiagentMismatch(agent.multiagent, variant);
    if (mismatch)
      this.options.log?.warn(
        { agent: agent.id, variant, mismatch },
        "workspace agent was created with a different multiagent setting",
      );
    stored.agents[variant] = { id: agent.id, version: agent.version, spec };
    await this.save();
    return stored.agents[variant];
  }

  private networkingMatches(environment: BetaEnvironment): boolean {
    if (environment.config.type !== "cloud") return false;
    const actual = environment.config.networking,
      wanted = this.options.networking;
    if (actual.type !== wanted.type) return false;
    if (actual.type !== "limited" || wanted.type !== "limited") return true;
    const hosts = (list?: string[] | null) =>
      JSON.stringify([...(list ?? [])].sort());
    return (
      hosts(actual.allowed_hosts) === hosts(wanted.allowed_hosts) &&
      actual.allow_package_managers ===
        (wanted.allow_package_managers ?? false) &&
      actual.allow_mcp_servers === (wanted.allow_mcp_servers ?? false)
    );
  }

  /** The first listed item that matches. A create whose response was lost,
   *  or a lost file, is recovered this way instead of creating a duplicate. */
  private async find<T>(
    items: AsyncIterable<T>,
    matches: (item: T) => boolean,
  ): Promise<T | undefined> {
    let scanned = 0;
    for await (const item of items) {
      if (matches(item)) return item;
      if (++scanned >= LIST_SCAN_MAX) break;
    }
  }

  private async call<T>(
    signal: AbortSignal | undefined,
    run: () => Promise<T>,
  ): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      throw toProviderError(error, "request");
    }
  }

  /** Forgets the stored agent and environment that no longer exist. True
   *  when a retry has something new to use. */
  private forgetMissing(
    variant: WorkspaceVariant,
    used: { environmentId: string; agent: { id: string } },
    signal?: AbortSignal,
  ): Promise<boolean> {
    return this.serial.run(async () => {
      const stored = await this.load();
      // Another turn already replaced it.
      let changed =
        stored.environment?.id !== used.environmentId ||
        stored.agents[variant]?.id !== used.agent.id;
      const gone = async (
        retrieve: () => Promise<{ archived_at: string | null }>,
      ) => {
        try {
          return (await retrieve()).archived_at !== null;
        } catch (error) {
          if (signal?.aborted) throw signal.reason;
          // Anything but a clear 404 says nothing about the resource.
          return apiErrorInfo(error).status === 404;
        }
      };
      if (
        stored.environment?.id === used.environmentId &&
        (await gone(() =>
          this.client.beta.environments.retrieve(
            used.environmentId,
            {},
            { signal },
          ),
        ))
      ) {
        delete stored.environment;
        changed = true;
      }
      if (
        stored.agents[variant]?.id === used.agent.id &&
        (await gone(() =>
          this.client.beta.agents.retrieve(used.agent.id, {}, { signal }),
        ))
      ) {
        delete stored.agents[variant];
        changed = true;
      }
      if (changed) await this.save();
      return changed;
    });
  }

  /** A session that came back without the turn's model or without a budget
   *  must not be used: it would run the placeholder model, or uncapped. */
  private async verify(
    session: BetaManagedAgentsSession,
    spec: { variant: WorkspaceVariant; selection: Selection },
    signal?: AbortSignal,
  ) {
    const model = sameModel(session.agent?.model?.id, spec.selection.model);
    if (!model || session.budget == null) {
      await this.client.beta.sessions
        .archive(session.id, {}, { signal })
        .catch(() => {});
      if (signal?.aborted) throw signal.reason;
      const failure = new ProviderError("protocol", false);
      failure.diagnostics = {
        phase: "request",
        provider: WORKSPACE_PROVIDER,
        model: spec.selection.model,
        code: model ? "session_without_budget" : "session_model_mismatch",
      };
      throw failure;
    }
    // Whether the override keeps the agent's multiagent block is not verified
    // against the API yet, so a difference is logged instead of failing.
    const mismatch = multiagentMismatch(session.agent.multiagent, spec.variant);
    if (mismatch)
      this.options.log?.warn(
        { session: session.id, variant: spec.variant, mismatch },
        "workspace session multiagent differs from its variant",
      );
  }
}

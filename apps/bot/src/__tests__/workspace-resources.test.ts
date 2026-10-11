import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "pino";
import { loadConfig, type Selection } from "../config";
import { promptCacheKey } from "../llm";
import { ProviderError } from "../llm-errors";
import { createWorkspaceClient } from "../workspace/client";
import {
  budgetLimit, cents, multiagentMismatch, ULTRA_MULTIAGENT, workspaceEffort, WorkspaceResources,
  type SessionTools, type WorkspaceIdentity, type WorkspaceNetworking,
} from "../workspace/resources";

// Decision record: #76. The agents and the environment Anthropic Workspace
// sessions are created from, and the session create request itself. The API
// is a function in this file that keeps what was created; nothing is sent.

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "hibana-workspace-resources-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

type Json = Record<string, any>;
type Sent = { method: string; path: string; body?: Json };
const BASE = "https://api.anthropic.com";
const haiku: Selection = { provider: "anthropic_workspace", model: "claude-haiku-5-5", effort: "medium" };
const opus: Selection = { provider: "anthropic_workspace", model: "claude-opus-5-5", effort: "high" };
const tools: SessionTools = [
  { type: "agent_toolset_20260401" },
  { type: "custom", name: "send_file", description: "Sends a file.", input_schema: { type: "object", properties: {} } },
];
const rejected = (status: number, type = "invalid_request_error") =>
  Response.json({ type: "error", error: { type, message: "upstream text" } }, { status });

/** A Managed Agents API small enough to read: it stores what is created and
 *  answers lists and retrieves from that. `on` replaces one route's answer. */
function fakeApi() {
  const sent: Sent[] = [];
  const environments: Json[] = [], agents: Json[] = [], sessions: Json[] = [];
  const routes = new Map<string, (request: Sent) => Response | undefined>();
  let n = 0;
  const at = "2026-10-12T00:00:00Z";
  const fetcher = async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    const request: Sent = {
      method: (init?.method ?? "GET").toUpperCase(), path: url.pathname,
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    };
    sent.push(request);
    const key = `${request.method} ${request.path}`, body = request.body ?? {};
    const replaced = routes.get(key)?.(request);
    if (replaced) return replaced;
    const one = (list: Json[], id: string) => {
      const found = list.find((item) => item.id === id);
      return found ? Response.json(found) : rejected(404, "not_found_error");
    };
    if (key === "GET /v1/environments") return Response.json({ data: environments, next_page: null });
    if (key === "POST /v1/environments") {
      const networking = body.config.networking.type === "limited"
        ? { allow_mcp_servers: false, allow_package_managers: false, allowed_hosts: [], ...body.config.networking }
        : body.config.networking;
      const environment = {
        id: `env_${++n}`, type: "environment", name: body.name, description: body.description ?? null,
        metadata: body.metadata ?? {}, archived_at: null, created_at: at, updated_at: at,
        config: { type: "cloud", networking, packages: { apt: [], cargo: [], gem: [], go: [], npm: [], pip: [] } },
      };
      environments.push(environment);
      return Response.json(environment);
    }
    if (key === "GET /v1/agents") return Response.json({ data: agents, next_page: null });
    if (key === "POST /v1/agents") {
      const agent = {
        id: `agent_${++n}`, type: "agent", version: 1, name: body.name, description: body.description ?? null,
        metadata: body.metadata ?? {}, archived_at: null, created_at: at, updated_at: at,
        model: { id: body.model }, system: null, tools: [], mcp_servers: [], skills: [],
        // As the API resolves it: every member spelled out.
        multiagent: body.multiagent ? {
          type: "multiagent_20261001", advisor: { type: "disabled" }, subagents: { type: "disabled" },
          workflows: { type: "enabled", inline_agents: { type: "enabled" }, predefined_agents: [] },
        } : null,
      };
      agents.push(agent);
      return Response.json(agent);
    }
    if (key === "POST /v1/sessions") {
      const agent = agents.find((a) => a.id === body.agent.id);
      if (!agent || agent.archived_at) return rejected(404, "not_found_error");
      const session = {
        id: `sesn_${++n}`, type: "session", status: "idle", archived_at: null, created_at: at, updated_at: at,
        environment_id: body.environment_id, metadata: body.metadata ?? {}, title: body.title ?? null,
        budget: body.budget ?? null, usage: {}, stats: {}, resources: [], vault_ids: [], outcome_evaluations: [],
        agent: {
          ...agent, version: body.agent.version, system: body.agent.system, tools: body.agent.tools,
          model: { id: body.agent.model.id, effort: { type: body.agent.model.effort } },
        },
      };
      sessions.push(session);
      return Response.json(session);
    }
    const [, , kind, id, action] = request.path.split("/");
    if (request.method === "GET" && kind === "environments" && id) return one(environments, id);
    if (request.method === "GET" && kind === "agents" && id) return one(agents, id);
    if (request.method === "POST" && kind === "sessions" && id && action === "archive") {
      const session = sessions.find((s) => s.id === id);
      if (session) session.archived_at = at;
      return session ? Response.json(session) : rejected(404, "not_found_error");
    }
    return rejected(404, "not_found_error");
  };
  // The client's own default of two retries is kept: creation must not use it.
  const client = createWorkspaceClient(
    loadConfig({ ANTHROPIC_WORKSPACE_API_KEY: "fixture", RUNTIME_STATE_PATH: "", LOG_DIR: "" }),
    { fetch: fetcher as unknown as typeof fetch });
  const of = (method: string, path: string) => sent.filter((r) => r.method === method && r.path === path);
  return {
    client, sent, environments, agents, sessions, of,
    on: (key: string, reply: (request: Sent) => Response | undefined) => { routes.set(key, reply); },
  };
}
type Api = ReturnType<typeof fakeApi>;
const unrestricted: WorkspaceNetworking = { type: "unrestricted" };
function resources(
  api: Api,
  over: { networking?: WorkspaceNetworking; baseUrl?: string; log?: Logger; path?: string; identity?: WorkspaceIdentity } = {},
) {
  return new WorkspaceResources(api.client, {
    path: over.path ?? join(dir, "anthropic_workspace_resources.json"),
    baseUrl: over.baseUrl ?? BASE, networking: over.networking ?? unrestricted, log: over.log,
    ...(over.identity && { identity: over.identity }),
  });
}
const spec = (over: Partial<Parameters<WorkspaceResources["createSession"]>[0]> = {}) => ({
  variant: "plain" as const, selection: haiku, system: "You are Hibana.", tools, budgetCents: 100,
  channelId: "123456789012345678", ...over,
});
function logger() {
  const warnings: unknown[][] = [];
  return { warnings, log: { warn: (...args: unknown[]) => { warnings.push(args); } } as unknown as Logger };
}

describe("money", () => {
  test("is whole US cents as a string on the way out and a number on the way in", () => {
    expect(budgetLimit(125)).toEqual({ type: "limit", max_list_cost: { amount: "125", currency: "USD" } });
    // Never zero and never a fraction: both are rejected by the API.
    expect(budgetLimit(0).max_list_cost.amount).toBe("1");
    expect(budgetLimit(12.4).max_list_cost.amount).toBe("12");
    expect(cents({ amount: "2500", currency: "USD" })).toBe(2500);
    expect(cents({ amount: "0", currency: "USD" })).toBe(0);
  });
  test("is unknown, not zero, when it is missing or in another form", () => {
    expect(cents(undefined)).toBeUndefined();
    expect(cents(null)).toBeUndefined();
    expect(cents({ amount: "25.00", currency: "USD" })).toBeUndefined();
    expect(cents({ amount: "100", currency: "EUR" as "USD" })).toBeUndefined();
  });
});

describe("the effort", () => {
  test("is always one the API takes: none becomes low, unset becomes the bot's default", () => {
    expect(workspaceEffort({ ...haiku, effort: "none" })).toBe("low");
    expect(workspaceEffort({ ...haiku, effort: "xhigh" })).toBe("xhigh");
    expect(workspaceEffort({ ...opus, effort: "max" })).toBe("max");
    expect(workspaceEffort({ ...opus, effort: null })).toBe("high");
    expect(workspaceEffort({ provider: "anthropic_workspace", model: "claude-sonnet-5-5" })).toBe("high");
  });
});

describe("the resources", () => {
  test("are created once, stored, and reused by a second bot on the same data directory", async () => {
    const api = fakeApi();
    const first = resources(api);
    // Two turns arriving together use the same ones.
    const [a, b] = await Promise.all([first.ensure("plain"), first.ensure("plain")]);
    expect(a).toEqual(b);
    expect(a).toEqual({ environmentId: api.environments[0]!.id, agent: { id: api.agents[0]!.id, version: 1 } });
    expect(api.of("POST", "/v1/environments")).toHaveLength(1);
    expect(api.of("POST", "/v1/agents")).toHaveLength(1);

    const stored = JSON.parse(await readFile(join(dir, "anthropic_workspace_resources.json"), "utf8"));
    expect(stored).toMatchObject({ version: 1, base_url: BASE, environment: { id: a.environmentId }, agents: { plain: { id: a.agent.id, version: 1 } } });

    const before = api.sent.length;
    expect(await resources(api).ensure("plain")).toEqual(a);
    expect(api.sent.length).toBe(before);
  });

  test("are created with fixed names that carry the definition's digest", async () => {
    const api = fakeApi();
    await resources(api).ensure("plain");
    const environment = api.of("POST", "/v1/environments")[0]!.body!;
    expect(environment.name).toMatch(/^hibana-workspace-env-[0-9a-f]{8}$/);
    expect(environment.config).toEqual({ type: "cloud", networking: { type: "unrestricted" } });
    expect(environment.metadata).toEqual({ app: "hibana", spec: environment.name.slice(-8) });
    const agent = api.of("POST", "/v1/agents")[0]!.body!;
    expect(agent.name).toMatch(/^hibana-workspace-plain-[0-9a-f]{8}$/);
    expect(agent.metadata).toEqual({ app: "hibana", variant: "plain", spec: agent.name.slice(-8) });
  });

  test("the ultra agent enables workflows only; the plain agent sends no multiagent", async () => {
    const api = fakeApi();
    const store = resources(api);
    const plain = await store.ensure("plain"), ultra = await store.ensure("ultra");
    expect(ultra.environmentId).toBe(plain.environmentId);
    expect(ultra.agent.id).not.toBe(plain.agent.id);
    const [first, second] = api.of("POST", "/v1/agents").map((r) => r.body!);
    expect(first).not.toHaveProperty("multiagent");
    // The block's defaults would turn subagents on as well.
    expect(second!.multiagent).toEqual({
      type: "multiagent_20261001",
      workflows: { type: "enabled" }, subagents: { type: "disabled" }, advisor: { type: "disabled" },
    });
    // The one definition, which the smoke script reads instead of a copy.
    expect(second!.multiagent).toEqual(ULTRA_MULTIAGENT);
    expect(multiagentMismatch(api.agents[1]!.multiagent, "ultra")).toBeUndefined();
    expect(multiagentMismatch(api.agents[0]!.multiagent, "plain")).toBeUndefined();
    expect(multiagentMismatch(api.agents[1]!.multiagent, "plain")).toBe("workflows_enabled");
    expect(multiagentMismatch(api.agents[0]!.multiagent, "ultra")).toBe("no_multiagent");
    // Neither carries a prompt or tools: each session brings its own.
    for (const body of [first!, second!]) {
      expect(body.model).toBe("claude-haiku-5-5");
      expect(body).not.toHaveProperty("system");
      expect(body).not.toHaveProperty("tools");
    }
    expect(api.of("POST", "/v1/environments")).toHaveLength(1);
  });

  test("are found again by name when the file was lost, instead of creating duplicates", async () => {
    const api = fakeApi();
    const created = await resources(api).ensure("ultra");
    await rm(join(dir, "anthropic_workspace_resources.json"));
    expect(await resources(api).ensure("ultra")).toEqual(created);
    expect(api.of("POST", "/v1/environments")).toHaveLength(1);
    expect(api.of("POST", "/v1/agents")).toHaveLength(1);
  });

  test("do not adopt what was archived, belongs to another definition, or was edited", async () => {
    const api = fakeApi();
    await resources(api).ensure("ultra");
    const environment = api.environments[0]!, agent = api.agents[0]!;
    const fresh = async () => {
      await rm(join(dir, "anthropic_workspace_resources.json"), { force: true });
      return resources(api).ensure("ultra");
    };

    environment.archived_at = "2026-10-12T01:00:00Z";
    agent.metadata = { ...agent.metadata, spec: "00000000" };
    const second = await fresh();
    expect(second.environmentId).not.toBe(environment.id);
    expect(second.agent.id).not.toBe(agent.id);

    // Same name and metadata, but someone turned subagents on in the Console.
    const edited = api.agents.find((a) => a.id === second.agent.id)!;
    edited.multiagent = { ...edited.multiagent, subagents: { type: "enabled", inline_agents: { type: "enabled" }, predefined_agents: [] } };
    edited.version = 2;
    const third = await fresh();
    expect(third.agent.id).not.toBe(edited.id);
    expect(third.environmentId).toBe(second.environmentId);
  });

  test("a changed network setting creates a new environment and keeps the agents", async () => {
    const api = fakeApi();
    const open = await resources(api).ensure("plain");
    const limited: WorkspaceNetworking = { type: "limited", allowed_hosts: ["example.com"], allow_package_managers: true };
    const closed = await resources(api, { networking: limited }).ensure("plain");
    expect(closed.environmentId).not.toBe(open.environmentId);
    expect(closed.agent).toEqual(open.agent);
    expect(api.of("POST", "/v1/environments")[1]!.body!.config.networking).toEqual(limited);
    // And it is the one found again.
    await rm(join(dir, "anthropic_workspace_resources.json"));
    expect((await resources(api, { networking: limited }).ensure("plain")).environmentId).toBe(closed.environmentId);
    expect(api.of("POST", "/v1/environments")).toHaveLength(2);
  });

  test("ids stored for another API host are not used", async () => {
    const api = fakeApi();
    const first = await resources(api).ensure("plain");
    api.environments.length = 0;
    api.agents.length = 0;
    const second = await resources(api, { baseUrl: "https://proxy.example" }).ensure("plain");
    expect(second.environmentId).not.toBe(first.environmentId);
    expect(second.agent.id).not.toBe(first.agent.id);
  });

  test("a damaged file is read as empty, with a warning", async () => {
    const api = fakeApi();
    const path = join(dir, "anthropic_workspace_resources.json");
    await writeFile(path, "{ not json");
    const { log, warnings } = logger();
    const made = await resources(api, { log }).ensure("plain");
    expect(made.agent.id).toBe(api.agents[0]!.id);
    expect(warnings).toHaveLength(1);
    expect(JSON.parse(await readFile(path, "utf8")).agents.plain.id).toBe(made.agent.id);
  });

  test("creation is never repeated by the SDK, and its failure names no upstream text", async () => {
    const api = fakeApi();
    api.on("POST /v1/environments", () => rejected(500, "api_error"));
    let failure: unknown;
    try {
      await resources(api).ensure("plain");
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ProviderError);
    expect(failure).toMatchObject({ kind: "transient", status: 500 });
    expect((failure as Error).message).not.toContain("upstream");
    expect(api.of("POST", "/v1/environments")).toHaveLength(1);
    expect(api.of("POST", "/v1/agents")).toHaveLength(0);
  });

  test("an aborted call rejects with the signal's reason", async () => {
    const api = fakeApi();
    const stop = new AbortController();
    const reason = new Error("Shutdown");
    api.on("GET /v1/environments", () => { stop.abort(reason); return undefined; });
    await expect(resources(api).ensure("plain", stop.signal)).rejects.toBe(reason);
  });
});

// The smoke script creates its resources through this class as well, so that
// what it checks against the real API is the bot's own lookup, create and
// verify. They must stay apart from the bot's: the script removes what it made.
describe("under another identity, as the smoke script's", () => {
  const SMOKE: WorkspaceIdentity = { prefix: "hibana-smoke-run1", app: "hibana-smoke" };
  const channel = promptCacheKey("123456789012345678");

  test("everything is named and labelled as its own, with the bot's definitions", async () => {
    const api = fakeApi(), bot = fakeApi();
    await resources(api, { identity: SMOKE }).createSession(spec({ variant: "ultra" }));
    await resources(bot, { path: join(dir, "bot.json") }).createSession(spec({ variant: "ultra" }));
    const [environment, agent, session] = ["/v1/environments", "/v1/agents", "/v1/sessions"].map((path) => api.of("POST", path)[0]!.body!);
    const [botEnvironment, botAgent, botSession] = ["/v1/environments", "/v1/agents", "/v1/sessions"].map((path) => bot.of("POST", path)[0]!.body!);
    expect(environment!.name).toMatch(/^hibana-smoke-run1-env-[0-9a-f]{8}$/);
    expect(environment!.metadata).toEqual({ app: "hibana-smoke", spec: environment!.name.slice(-8) });
    expect(agent!.name).toMatch(/^hibana-smoke-run1-ultra-[0-9a-f]{8}$/);
    expect(agent!.metadata).toEqual({ app: "hibana-smoke", variant: "ultra", spec: agent!.name.slice(-8) });
    expect(session!.metadata).toEqual({ app: "hibana-smoke", variant: "ultra", channel });
    expect(session!.title).toBe(`hibana-smoke ultra ${channel.slice(0, 8)}`);
    // Apart from the name and the label, each request is the one the bot sends.
    const definition = ({ name, metadata, title, ...rest }: Json) => rest;
    expect(definition(environment!)).toEqual(definition(botEnvironment!));
    expect(definition(agent!)).toEqual(definition(botAgent!));
    expect(definition(session!)).toEqual(definition(botSession!));
    expect([environment!.name.slice(-8), agent!.name.slice(-8)]).toEqual([botEnvironment!.name.slice(-8), botAgent!.name.slice(-8)]);
    expect(botEnvironment!.name).toMatch(/^hibana-workspace-env-/);
    expect(botSession!.metadata.app).toBe("hibana");
    expect(JSON.stringify(bot.sent)).not.toContain("smoke");
    // The bot's file is what it always was; the other one says whose it is.
    expect(Object.keys(JSON.parse(await readFile(join(dir, "bot.json"), "utf8"))).sort()).toEqual(["agents", "base_url", "environment", "version"]);
    expect(JSON.parse(await readFile(join(dir, "anthropic_workspace_resources.json"), "utf8")).app).toBe("hibana-smoke");
  });

  test("neither adopts the bot's resources nor has its own adopted, on one account", async () => {
    const api = fakeApi();
    const botFile = join(dir, "bot.json"), smokeFile = join(dir, "smoke.json");
    const bot = await resources(api, { path: botFile }).ensure("ultra");
    const smoke = await resources(api, { path: smokeFile, identity: SMOKE }).ensure("ultra");
    expect(smoke.environmentId).not.toBe(bot.environmentId);
    expect(smoke.agent.id).not.toBe(bot.agent.id);
    expect(api.environments.map((e) => e.metadata.app)).toEqual(["hibana", "hibana-smoke"]);
    expect(api.agents.map((a) => a.metadata.app)).toEqual(["hibana", "hibana-smoke"]);
    // With both files lost, each finds its own again and nothing is created.
    await rm(botFile);
    await rm(smokeFile);
    expect(await resources(api, { path: smokeFile, identity: SMOKE }).ensure("ultra")).toEqual(smoke);
    expect(await resources(api, { path: botFile }).ensure("ultra")).toEqual(bot);
    expect(api.of("POST", "/v1/environments")).toHaveLength(2);
    expect(api.of("POST", "/v1/agents")).toHaveLength(2);
    // The script removing its own leaves the bot's in place and in use.
    api.environments.splice(1, 1);
    api.agents[1]!.archived_at = "2026-10-12T01:00:00Z";
    await rm(botFile);
    expect(await resources(api, { path: botFile }).ensure("ultra")).toEqual(bot);
    expect(api.of("POST", "/v1/environments")).toHaveLength(2);
  });

  test("a resource with the right name but another label is not adopted, in either direction", async () => {
    const api = fakeApi();
    const botFile = join(dir, "bot.json"), otherFile = join(dir, "other.json");
    // The bot's own names under another label: only the label tells them apart.
    const other: WorkspaceIdentity = { prefix: "hibana-workspace", app: "hibana-smoke" };
    const labelled = await resources(api, { path: otherFile, identity: other }).ensure("plain");
    const bot = await resources(api, { path: botFile }).ensure("plain");
    expect(api.environments.map((e) => e.name)).toEqual([api.environments[0]!.name, api.environments[0]!.name]);
    expect(bot.environmentId).not.toBe(labelled.environmentId);
    expect(bot.agent.id).not.toBe(labelled.agent.id);
    await rm(botFile);
    await rm(otherFile);
    expect(await resources(api, { path: otherFile, identity: other }).ensure("plain")).toEqual(labelled);
    expect(await resources(api, { path: botFile }).ensure("plain")).toEqual(bot);
    expect(api.of("POST", "/v1/environments")).toHaveLength(2);
    expect(api.of("POST", "/v1/agents")).toHaveLength(2);
  });

  test("ids stored by one identity are not used by the other, even from the same file", async () => {
    const api = fakeApi();
    const path = join(dir, "shared.json");
    const bot = await resources(api, { path }).ensure("plain");
    const smoke = await resources(api, { path, identity: SMOKE }).ensure("plain");
    expect(smoke.environmentId).not.toBe(bot.environmentId);
    expect(smoke.agent.id).not.toBe(bot.agent.id);
    // The file now holds the script's ids. The bot does not take them: it
    // finds its own again by name, and creates nothing.
    expect(await resources(api, { path }).ensure("plain")).toEqual(bot);
    expect(api.of("POST", "/v1/environments")).toHaveLength(2);
    expect(api.of("POST", "/v1/agents")).toHaveLength(2);
  });
});

describe("a session", () => {
  test("carries the turn's model, prompt, tools and budget, and a digest instead of the channel id", async () => {
    const api = fakeApi();
    const { session, effort } = await resources(api).createSession(spec({ selection: opus, budgetCents: 150 }));
    expect(effort).toBe("high");
    expect(session.id).toBe(api.sessions[0]!.id);
    const request = api.of("POST", "/v1/sessions")[0]!.body!;
    expect(request).toEqual({
      agent: {
        type: "agent_with_overrides", id: api.agents[0]!.id, version: 1,
        model: { id: "claude-opus-5-5", effort: "high" }, system: "You are Hibana.", tools,
      },
      environment_id: api.environments[0]!.id,
      budget: { type: "limit", max_list_cost: { amount: "150", currency: "USD" } },
      metadata: { app: "hibana", variant: "plain", channel: promptCacheKey("123456789012345678") },
      title: `hibana plain ${promptCacheKey("123456789012345678").slice(0, 8)}`,
    });
    expect(JSON.stringify(api.sent)).not.toContain("123456789012345678");
  });

  test("with no tools enabled sends an empty list, which clears the agent's", async () => {
    const api = fakeApi();
    await resources(api).createSession(spec({ tools: [] }));
    expect(api.of("POST", "/v1/sessions")[0]!.body!.agent.tools).toEqual([]);
  });

  test("always states the effort, and a rejection is not retried without it", async () => {
    const api = fakeApi();
    api.on("POST /v1/sessions", () => rejected(400));
    let failure: unknown;
    try {
      await resources(api).createSession(spec({ selection: { ...haiku, effort: "none" } }));
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ kind: "invalid_request", status: 400 });
    const creates = api.of("POST", "/v1/sessions");
    expect(creates).toHaveLength(1);
    expect(creates[0]!.body!.agent.model).toEqual({ id: "claude-haiku-5-5", effort: "low" });
    // The agent and the environment were looked at and are fine, so nothing was made again.
    expect(api.of("POST", "/v1/agents")).toHaveLength(1);
    expect(api.of("POST", "/v1/environments")).toHaveLength(1);
  });

  test("is not created twice when the answer is lost", async () => {
    const api = fakeApi();
    api.on("POST /v1/sessions", () => rejected(502, "api_error"));
    await expect(resources(api).createSession(spec())).rejects.toMatchObject({ kind: "transient", status: 502 });
    expect(api.of("POST", "/v1/sessions")).toHaveLength(1);
  });

  test("recreates an agent that was archived outside the bot, once", async () => {
    const api = fakeApi();
    const store = resources(api);
    const first = await store.ensure("plain");
    api.agents[0]!.archived_at = "2026-10-12T01:00:00Z";
    const { session } = await store.createSession(spec());
    expect(api.of("POST", "/v1/sessions")).toHaveLength(2);
    expect(api.agents).toHaveLength(2);
    expect(session.agent.id).toBe(api.agents[1]!.id);
    expect(session.agent.id).not.toBe(first.agent.id);
    // The environment was confirmed and kept.
    expect(api.of("POST", "/v1/environments")).toHaveLength(1);
    expect(session.environment_id).toBe(first.environmentId);
  });

  test("ultra is refused on any model but Haiku 5.5, before anything is sent", async () => {
    const api = fakeApi();
    await expect(resources(api).createSession(spec({ variant: "ultra", selection: opus }))).rejects.toThrow("claude-haiku-5-5");
    expect(api.sent).toHaveLength(0);
    const { session } = await resources(api).createSession(spec({ variant: "ultra" }));
    expect(api.of("POST", "/v1/sessions")[0]!.body!.metadata.variant).toBe("ultra");
    expect(session.agent.multiagent).toMatchObject({ type: "multiagent_20261001", workflows: { type: "enabled" } });
  });

  test("that came back on another model or without a budget is archived and not used", async () => {
    for (const [change, code] of [
      [(s: Json) => { s.agent.model = { id: "claude-haiku-5-5" }; }, "session_model_mismatch"],
      [(s: Json) => { s.budget = null; }, "session_without_budget"],
    ] as const) {
      const api = fakeApi();
      const store = resources(api);
      await store.ensure("plain");
      api.on("POST /v1/sessions", (request) => {
        const session = {
          id: "sesn_bad", type: "session", status: "idle", archived_at: null, usage: {}, metadata: {},
          budget: request.body!.budget, agent: { ...api.agents[0], model: { id: request.body!.agent.model.id } },
        };
        change(session);
        api.sessions.push(session);
        return Response.json(session);
      });
      let failure: unknown;
      try {
        await store.createSession(spec({ selection: opus }));
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ kind: "protocol", retryable: false });
      expect((failure as ProviderError).diagnostics.code).toBe(code);
      expect(api.of("POST", "/v1/sessions/sesn_bad/archive")).toHaveLength(1);
    }
  });

  test("on a dated snapshot of the chosen model is the chosen model", async () => {
    const api = fakeApi();
    const store = resources(api);
    await store.ensure("plain");
    api.on("POST /v1/sessions", (request) => Response.json({
      id: "sesn_dated", type: "session", status: "idle", archived_at: null, usage: {}, metadata: {},
      budget: request.body!.budget, agent: { ...api.agents[0], model: { id: "claude-opus-5-5-20260915" } },
    }));
    expect((await store.createSession(spec({ selection: opus }))).session.id).toBe("sesn_dated");
  });

  test("whose multiagent setting differs from its variant is used, with a warning", async () => {
    const api = fakeApi();
    const { log, warnings } = logger();
    const store = resources(api, { log });
    await store.ensure("ultra");
    // Whether an override keeps the agent's multiagent block is not confirmed against the API.
    api.on("POST /v1/sessions", (request) => Response.json({
      id: "sesn_flat", type: "session", status: "idle", archived_at: null, usage: {}, metadata: {},
      budget: request.body!.budget, agent: { ...api.agents[0], model: { id: "claude-haiku-5-5" }, multiagent: null },
    }));
    expect((await store.createSession(spec({ variant: "ultra" }))).session.id).toBe("sesn_flat");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]![0]).toMatchObject({ session: "sesn_flat", variant: "ultra", mismatch: "no_multiagent" });
    expect(api.sent.some((r) => r.path.endsWith("/archive"))).toBe(false);
  });
});

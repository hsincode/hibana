import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { resolve } from "node:path";
import {
  AUTO_ROUTE_MODEL,
  MODEL_PRESETS,
  EFFORTS,
  WORKSPACE_PROVIDER,
  canonicalModel,
} from "@hibana/shared/catalog";
import { SIZE_GUIDELINES, type SizeGuideline } from "./workflow/prompts";

export type Selection = {
  provider: string;
  model: string;
  effort?: string | null;
  /** Chosen by auto routing: requests for it never use the max effort. */
  routed?: boolean;
};
export type Endpoint = { baseUrl: string; apiKey: string };
const providers: Record<string, [string, string]> = {
  chatgpt: ["https://chatgpt.com/backend-api/codex", "gpt-6.1-sol"],
  deepseek: ["https://api.deepseek.com", "deepseek-flash"],
  openai: ["https://api.openai.com/v1", "gpt-4o-mini"],
  anthropic: ["https://api.anthropic.com/v1", "claude-sonnet-5-5"],
  // Anthropic Workspace (#76) has its own key, `ANTHROPIC_WORKSPACE_API_KEY`,
  // and never borrows `ANTHROPIC_API_KEY`. The official SDK adds `/v1` to the
  // path itself, so this base has none. The default model is the catalog's
  // first preset of the provider, as the settings API seeds it.
  anthropic_workspace: [
    "https://api.anthropic.com",
    MODEL_PRESETS.find((m) => m.provider === WORKSPACE_PROVIDER)!.model,
  ],
  xai: ["https://api.x.ai/v1", "grok-3-mini"],
  openrouter: ["https://openrouter.ai/api/v1", ""],
  orca_router: ["https://api.orcarouter.ai/v1", "obsidian/Qwen3.8-27B"],
  refuseless: [
    "https://api.refuseless.com/v1",
    MODEL_PRESETS.find((m) => m.provider === "refuseless")!.model,
  ],
  ...Object.fromEntries(
    [
      "claude_kiro",
      "claude_max",
      "codex_gemini",
      "grok_free",
      "grok_heavy",
      "codex_plus",
      "codex_pro",
    ].map((p) => [
      p,
      [
        "https://codex-everywhere.com/v1",
        // Catalog lists Sol first for the Plus picker; env default is Plus Luna.
        p === "codex_plus"
          ? "gpt-6-luna"
          : MODEL_PRESETS.find((m) => m.provider === p)!.model,
      ],
    ]),
  ),
  custom: ["", ""],
};
export function flag(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: boolean,
): boolean {
  const v = env[key]?.trim().toLowerCase();
  if (!v) return fallback;
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  throw new Error(`${key} must be a boolean`);
}
export function numberEnv(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): number {
  const n = env[key]?.trim() ? Number(env[key]) : fallback;
  if (!Number.isFinite(n) || n < min || n > max)
    throw new Error(`${key} must be between ${min} and ${max}`);
  return n;
}
function vpnProvider(env: NodeJS.ProcessEnv): "surfshark" | "vpngate" {
  const value = (env.VPN_PROVIDER || "surfshark").trim().toLowerCase();
  if (value === "surfshark" || value === "vpngate") return value;
  throw new Error("VPN_PROVIDER must be surfshark or vpngate");
}

/** CPUs this process may use, including a cgroup (container) CPU quota. */
function availableCpus(): number {
  let cpus = availableParallelism();
  try {
    const [quota, period] = readFileSync("/sys/fs/cgroup/cpu.max", "utf8")
      .trim()
      .split(/\s+/);
    if (quota && quota !== "max" && Number(period) > 0)
      cpus = Math.min(
        cpus,
        Math.max(1, Math.ceil(Number(quota) / Number(period))),
      );
  } catch {}
  return cpus;
}
/** The smallest allowance an Anthropic Workspace turn is started with, in
 *  cents: a single model request can cost more than less. A turn's own limit
 *  cannot be set below it, or every turn would be refused (#76). */
export const WORKSPACE_MIN_TURN_CENTS = 5;
/** A USD amount as whole cents, at least `minCents` (one unless given). The
 *  Managed Agents API takes money in minor units, so the limits are kept
 *  that way from the start. */
function centsEnv(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  max: number,
  minCents = 1,
): number {
  return Math.round(numberEnv(env, key, fallback, minCents / 100, max) * 100);
}
/** Network policy of the Workspace container. A host list only means
 *  something under `limited`, so one given without it stops the start rather
 *  than look like a restriction that is not applied. */
function workspaceNetworking(env: NodeJS.ProcessEnv): {
  networking: "unrestricted" | "limited";
  allowedHosts: string[];
} {
  const networking = (env.ANTHROPIC_WORKSPACE_NETWORKING || "unrestricted")
    .trim()
    .toLowerCase();
  if (networking !== "unrestricted" && networking !== "limited")
    throw new Error(
      "ANTHROPIC_WORKSPACE_NETWORKING must be unrestricted or limited",
    );
  const allowedHosts = (env.ANTHROPIC_WORKSPACE_ALLOWED_HOSTS || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  if (allowedHosts.length && networking !== "limited")
    throw new Error(
      "ANTHROPIC_WORKSPACE_ALLOWED_HOSTS requires ANTHROPIC_WORKSPACE_NETWORKING=limited",
    );
  // Host names only: no scheme, port or path.
  if (allowedHosts.some((host) => /[\s\/:]/.test(host)))
    throw new Error(
      "ANTHROPIC_WORKSPACE_ALLOWED_HOSTS must be a comma-separated list of host names",
    );
  return { networking, allowedHosts };
}
function sizeGuideline(env: NodeJS.ProcessEnv): SizeGuideline {
  const value = (env.WORKFLOW_SIZE_GUIDELINE || "medium").trim().toLowerCase();
  if ((SIZE_GUIDELINES as readonly string[]).includes(value))
    return value as SizeGuideline;
  throw new Error(
    `WORKFLOW_SIZE_GUIDELINE must be one of ${SIZE_GUIDELINES.join(", ")}`,
  );
}

export function recommendedEffort(
  model: string,
  provider: string,
): string | undefined {
  if (model === "ox-alpha-free") return undefined;
  if (model.includes("fable")) return "medium";
  if (/gpt-|deepseek/.test(model)) return "max";
  return "high";
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const provider = (
    env.PROVIDER ??
    env.LLM_PROVIDER ??
    "CODEX_PLUS"
  ).toLowerCase();
  if (!providers[provider]) throw new Error(`Unknown PROVIDER: ${provider}`);
  const endpoints: Record<string, Endpoint> = {};
  for (const [id, [base]] of Object.entries(providers)) {
    const prefix = id.toUpperCase();
    const aliases =
      id === "claude_kiro"
        ? env.ANTHROPIC_AUTH_TOKEN
        : id === "codex_gemini"
          ? env.GEMINI_API_KEY
          : id === "codex_pro"
            ? (env.CODEX_PRO_POOL_API_KEY ?? env.CODEX_PRO_POOL)
            : undefined;
    const apiKey =
      env[`${prefix}_API_KEY`] ??
      aliases ??
      (id === "custom" ? env.LLM_API_KEY : "") ??
      "";
    const baseUrl =
      env[`${prefix}_BASE_URL`] ??
      (id === "custom" ? env.LLM_BASE_URL : undefined) ??
      base;
    if (baseUrl) {
      const url = new URL(baseUrl);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        throw new Error(`${prefix}_BASE_URL is invalid`);
      endpoints[id] = { baseUrl: baseUrl.replace(/\/$/, ""), apiKey };
    }
  }
  const model = canonicalModel(
    provider,
    env.LLM_MODEL || providers[provider]![1],
  );
  if (!model)
    throw new Error(`LLM_MODEL is required for PROVIDER: ${provider}`);
  // "auto" is Jev's routing among the `anthropic` models (#35). Anywhere else
  // it is not a model, and a Workspace session would be created with that id.
  if (provider === WORKSPACE_PROVIDER && model === AUTO_ROUTE_MODEL)
    throw new Error("LLM_MODEL=auto is only available with PROVIDER=anthropic");
  const effort = env.LLM_EFFORT || recommendedEffort(model, provider);
  if (effort && !EFFORTS.includes(effort as (typeof EFFORTS)[number]))
    throw new Error("Invalid LLM_EFFORT");
  const dataDir = resolve(env.HIBANA_DATA_DIR || "./data");
  const webApiUrl = env.WEB_API_URL?.replace(/\/$/, "") || "";
  if (webApiUrl && !env.WEB_INTERNAL_TOKEN)
    throw new Error("WEB_INTERNAL_TOKEN is required with WEB_API_URL");
  const browserProxyUrl = env.BROWSER_PROXY_URL || "";
  if (browserProxyUrl) {
    const proxy = new URL(browserProxyUrl);
    if (
      proxy.protocol !== "http:" ||
      proxy.username ||
      proxy.password ||
      proxy.search ||
      proxy.hash ||
      proxy.pathname !== "/"
    )
      throw new Error(
        "BROWSER_PROXY_URL must be an HTTP proxy origin without credentials",
      );
    if (!env.BROWSER_PROXY_USERNAME)
      throw new Error("Browser proxy username required");
  }
  const imageWorkerUrl = env.IMAGE_WORKER_URL?.replace(/\/$/, "") || "";
  if (imageWorkerUrl) {
    const url = new URL(imageWorkerUrl);
    // The private image bridge is an explicit deployment capability, not a
    // user-configurable SSRF exception for arbitrary MCP or download URLs.
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new Error("IMAGE_WORKER_URL must be a loopback HTTP origin");
    if ((env.IMAGE_WORKER_TOKEN || "").length < 32)
      throw new Error("IMAGE_WORKER_TOKEN must contain at least 32 characters");
  }
  const vpn = vpnProvider(env);
  return {
    token: env.DISCORD_TOKEN || "",
    commandGuildId: env.DISCORD_COMMAND_GUILD_ID,
    selection: {
      provider,
      model,
      effort: effort === "ultra" ? "max" : effort,
    } as Selection,
    // Legacy LLM_EFFORT=ultra still turns Ultra on. Ultra is Claude Code's
    // Ultracode: the root runs at xhigh while it is on (see ultracode.ts).
    ultraMode: flag(env, "ULTRA_MODE", effort === "ultra"),
    // Multi-Agent seeds new settings rows only, like ULTRA_MODE. It stores
    // ultra_mode=true as well but keeps its own team policy (subagentMode).
    multiAgent: flag(env, "MULTI_AGENT", false),
    endpoints,
    temperature: numberEnv(env, "LLM_TEMPERATURE", 0.7, 0, 2),
    // Match the reference Codex fork's defaults: four HTTP retries, five
    // stream reconnects, and five minutes without incoming bytes (not total time).
    llmRequestRetries: Math.floor(
      numberEnv(env, "LLM_REQUEST_MAX_RETRIES", 4, 0, 100),
    ),
    llmStreamRetries: Math.floor(
      numberEnv(env, "LLM_STREAM_MAX_RETRIES", 5, 0, 100),
    ),
    llmStreamIdleMs: numberEnv(
      env,
      "LLM_STREAM_IDLE_TIMEOUT_MS",
      300000,
      1,
      3600000,
    ),
    maxTokens: numberEnv(env, "LLM_MAX_TOKENS", 8192, 1024, 65536),
    maxRounds: numberEnv(env, "MAX_TOOL_ROUNDS", 128, 1, 512),
    dataDir,
    statePath:
      env.RUNTIME_STATE_PATH === ""
        ? ""
        : resolve(env.RUNTIME_STATE_PATH || `${dataDir}/runtime_state.json`),
    // Conversation history and auto routes, kept across restarts (#59). An
    // empty value keeps them in process memory only.
    conversationDbPath:
      env.CONVERSATION_DB_PATH === ""
        ? ""
        : resolve(env.CONVERSATION_DB_PATH || `${dataDir}/conversations.db`),
    promptFile: resolve(env.PROMPT_FILE || "prompt.md"),
    personaFile: resolve(env.PERSONA_FILE || "persona.md"),
    // Anthropic Workspace (#76): limits of the Managed Agents path. The key
    // and base URL are `endpoints.anthropic_workspace`. The defaults are
    // those of #76.
    anthropicWorkspace: {
      // List cost one turn may add to its session, and what all Workspace
      // turns together may add in one UTC day and month, in cents. A turn's
      // limit below what a turn is started with would refuse every turn, so
      // it stops the start instead; the day and the month go down to a cent.
      turnBudgetCents: centsEnv(
        env,
        "ANTHROPIC_WORKSPACE_TURN_BUDGET_USD",
        1,
        100,
        WORKSPACE_MIN_TURN_CENTS,
      ),
      ultraTurnBudgetCents: centsEnv(
        env,
        "ANTHROPIC_WORKSPACE_ULTRA_TURN_BUDGET_USD",
        3,
        100,
        WORKSPACE_MIN_TURN_CENTS,
      ),
      dailyBudgetCents: centsEnv(
        env,
        "ANTHROPIC_WORKSPACE_DAILY_BUDGET_USD",
        5,
        10000,
      ),
      monthlyBudgetCents: centsEnv(
        env,
        "ANTHROPIC_WORKSPACE_MONTHLY_BUDGET_USD",
        50,
        100000,
      ),
      // Wall-clock time of one turn, counted from its first start.
      turnTimeoutMs: numberEnv(
        env,
        "ANTHROPIC_WORKSPACE_TURN_TIMEOUT_MS",
        1200000,
        1,
        86400000,
      ),
      ultraTurnTimeoutMs: numberEnv(
        env,
        "ANTHROPIC_WORKSPACE_ULTRA_TURN_TIMEOUT_MS",
        3600000,
        1,
        86400000,
      ),
      // Workspace turns running at once in the whole bot, and the longest
      // user message one of them accepts.
      concurrency: Math.floor(
        numberEnv(env, "ANTHROPIC_WORKSPACE_MAX_CONCURRENT", 2, 1, 64),
      ),
      inputMaxChars: Math.floor(
        numberEnv(
          env,
          "ANTHROPIC_WORKSPACE_INPUT_MAX_CHARS",
          60000,
          1,
          1000000,
        ),
      ),
      ...workspaceNetworking(env),
      // The container's own web search and fetch. Decided when a session is
      // created; an existing session keeps what it was created with.
      web: flag(env, "ANTHROPIC_WORKSPACE_WEB_ENABLED", true),
    },
    toolsEnabled: flag(env, "TOOLS_ENABLED", true),
    sandboxEnabled: flag(env, "SANDBOX_ENABLED", true),
    sandboxImage: env.SANDBOX_IMAGE || "hibana-sandbox:latest",
    imageWorkerUrl,
    imageWorkerToken: env.IMAGE_WORKER_TOKEN || "",
    // This only makes the home tools available; normal browsers stay direct.
    // Each explicit connection gets a fresh lease credential from HomeSession.
    browserProxyUrl,
    browserProxyUsername: env.BROWSER_PROXY_USERNAME || "",
    homeControlSocket:
      env.HOME_RELAY_CONTROL_SOCKET || "/run/hibana-home-egress/control.sock",
    workspaceRoot: resolve(
      env.SANDBOX_WORKSPACE_ROOT || `${dataDir}/workspaces`,
    ),
    skillsRoot: resolve(env.SKILLS_DIR || "skills"),
    customSkillsRoot: resolve(`${dataDir}/skills`),
    skillsEnabled: flag(env, "SKILLS_ENABLED", true),
    webApiUrl,
    internalToken: env.WEB_INTERNAL_TOKEN || "",
    // History is trimmed by size, in one step from max down to keep, so the
    // conversation head (and with it the provider's prompt cache) moves rarely.
    historyMaxTokens: numberEnv(env, "HISTORY_MAX_TOKENS", 160000, 1000),
    // Capped at half the limit: a keep size near the limit would trim, and so
    // move the head, on almost every turn.
    historyKeepTokens: Math.min(
      numberEnv(env, "HISTORY_KEEP_TOKENS", 80000, 0),
      Math.floor(numberEnv(env, "HISTORY_MAX_TOKENS", 160000, 1000) / 2),
    ),
    threadHistoryAge: numberEnv(env, "THREAD_HISTORY_MAX_AGE_SECS", 3600),
    // The summary size of a DM and of a server row created by the bot; a
    // server's own setting wins (#124). Estimated tokens of the history.
    compactionTokens: numberEnv(
      env,
      "THREAD_COMPACTION_TOKENS",
      30000,
      1000,
      1_000_000,
    ),
    extraTriggers: (env.EXTRA_TRIGGERS || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
    suppressEmbeds: flag(env, "DISCORD_SUPPRESS_EMBEDS", false),
    exaKey: env.EXA_API_KEY || "",
    exaMode:
      env.EXA_ENABLED === undefined
        ? "auto"
        : flag(env, "EXA_ENABLED", true)
          ? "on"
          : "off",
    webSearch: flag(env, "WEB_SEARCH_ENABLED", true),
    subagentEnabled: flag(env, "SUBAGENT_ENABLED", true),
    // V2 counts active descendants across the whole task tree; root is separate.
    subagentConcurrency: numberEnv(env, "SUBAGENT_MAX_CONCURRENT", 6, 1, 16),
    subagentForkAllowAll: flag(env, "SUBAGENT_FORK_ALLOW_ALL", false),
    // Claude Code's dynamic workflows: the Workflow tool, the "ultracode"
    // keyword and Ultra (Ultracode). Subagents must be enabled as well.
    workflowsEnabled: flag(env, "WORKFLOWS_ENABLED", true),
    ultracodeKeywordTrigger: flag(env, "ULTRACODE_KEYWORD_TRIGGER", true),
    // Claude Code runs min(16, max(2, CPUs - 2)) agent() calls at once per
    // workflow; CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS overrides it there.
    workflowConcurrency: Math.floor(
      numberEnv(
        env,
        "WORKFLOW_MAX_CONCURRENT_AGENTS",
        Math.min(16, Math.max(2, availableCpus() - 2)),
        1,
        256,
      ),
    ),
    // Advice appended to the Workflow description (default medium: <10 agents).
    workflowSizeGuideline: sizeGuideline(env),
    workflowSizeGuidelineDefault: !env.WORKFLOW_SIZE_GUIDELINE?.trim(),
    subagentForkMaxTurns: env.SUBAGENT_FORK_MAX_TURNS
      ? numberEnv(env, "SUBAGENT_FORK_MAX_TURNS", 3, 1)
      : undefined,
    jevEnabled: flag(env, "JEV_ENABLED", true),
    // Opt in separately: ordinary evaluations must not change task execution.
    jevTaskEnabled: flag(env, "JEV_TASK_ENABLED", false),
    // Jev uses a dedicated Decisions API key; never borrow a chat provider's quota.
    jevApiKey: env.JEV_API_KEY || "",
    // Jev's image input is experimental (#83); this turns it off without a deploy.
    jevImagesEnabled: flag(env, "JEV_IMAGES_ENABLED", true),
    siteEnabled: flag(env, "STATIC_SITE_ENABLED", false),
    siteBind: env.STATIC_SITE_BIND || "127.0.0.1:8080",
    siteBase: env.STATIC_SITE_BASE_URL || env.STATIC_SITE_PUBLIC_BASE_URL || "",
    // e.g. https://{token}.example.com: each site gets its own origin (#87).
    siteOriginTemplate: env.STATIC_SITE_ORIGIN_TEMPLATE || "",
    siteTtl: numberEnv(
      env,
      "STATIC_SITE_TTL_SECS",
      numberEnv(env, "STATIC_SITE_TTL_HOURS", 48) * 3600,
    ),
    siteMaxBytes: numberEnv(env, "STATIC_SITE_MAX_BYTES", 50000000, 1),
    siteMaxCount: numberEnv(env, "STATIC_SITE_MAX_SITES_PER_GUILD", 50, 1),
    siteMaxTotalBytes: numberEnv(
      env,
      "STATIC_SITE_MAX_TOTAL_BYTES",
      2000000000,
      1,
    ),
    skillCacheRoot: resolve(env.SKILLS_CACHE_DIR || `${dataDir}/skill-cache`),
    workspaceMaxBytes: numberEnv(
      env,
      "SANDBOX_MAX_WORKSPACE_BYTES",
      3 * 1024 ** 3,
      1,
    ),
    workspaceMaxTotalBytes: numberEnv(
      env,
      "SANDBOX_MAX_TOTAL_WORKSPACE_BYTES",
      8 * 1024 ** 3,
      1,
    ),
    workspaceTtl: numberEnv(env, "SANDBOX_TTL_HOURS", 12) * 3600000,
    voiceEnabled: flag(env, "VOICE_ENABLED", false),
    xaiKey: env.XAI_API_KEY || "",
    voiceModel: env.VOICE_S2S_MODEL || "grok-voice-latest",
    voiceName: env.VOICE_S2S_VOICE || "eve",
    // Meeting recording (#118). Limits: three hours a recording,
    // two at once (apart from the voice conversation's three).
    recordingMaxMinutes: numberEnv(env, "RECORDING_MAX_MINUTES", 180, 1, 1440),
    recordingMaxSessions: numberEnv(env, "RECORDING_MAX_SESSIONS", 2, 1, 10),
    // A recording's audio, kept as an artifact (#138): 1 GB over every
    // recording, the one in progress included, each kept three days. 0 keeps
    // no audio. Needs STATIC_SITE_ENABLED.
    recordingAudioMaxBytes: numberEnv(
      env,
      "RECORDING_AUDIO_MAX_BYTES",
      1_000_000_000,
    ),
    recordingAudioTtlHours: numberEnv(
      env,
      "RECORDING_AUDIO_TTL_HOURS",
      72,
      1,
      720,
    ),
    vpnEnabled: flag(env, "VPN_ENABLED", false),
    vpnProvider: vpn,
    vpnServer: env.VPN_SERVER || (vpn === "vpngate" ? "jp" : "jp-tok"),
    vpnUsername: env.SURFSHARK_OPENVPN_USERNAME || "",
    vpnPassword: env.SURFSHARK_OPENVPN_PASSWORD || "",
    logLevel: env.LOG_LEVEL || "info",
    logDir: env.LOG_DIR === "" ? "" : resolve(env.LOG_DIR || `${dataDir}/logs`),
  };
}
export type Config = ReturnType<typeof loadConfig>;

/** Process env. Secrets stay in env; never log values. */

export type WebEnv = {
  discordToken: string;
  discordClientId: string;
  discordClientSecret: string;
  /** Public origin of this API (OAuth redirect + cookie). */
  publicBaseUrl: string;
  /** SPA origin for CORS and post-login redirect. */
  frontendOrigin: string;
  sessionSecret: string;
  bind: string;
  databaseUrl: string | null;
  internalToken: string;
  adminIds: string[];
  botControlUrl: string;
  /**
   * Persist conversation audit rows (`POST /internal/logs`). Default off:
   * each turn is a Neon INSERT (+ hourly prune DELETE) and that write path
   * is what kept compute busy after snapshot polling stopped.
   */
  logsEnabled: boolean;
  /**
   * Anthropic Admin API key (`ANTHROPIC_ADMIN_KEY`) for the cost report behind
   * `/api/analytics/cost`. null = the page reports that it is not set up.
   * Not the key the bot sends messages with: a workspace key is rejected here,
   * and this one can manage the organization, so it is only ever sent to
   * Anthropic.
   */
  anthropicAdminKey: string | null;
  /**
   * Commit this deployment was built from (`HIBANA_COMMIT`, set by the deploy
   * job). `/version` reports it so the job can tell this build from the one
   * that currently serves production.
   */
  commit: string | null;
};

function req(name: string, fallback?: string): string {
  const v = (process.env[name] ?? fallback ?? "").trim();
  if (!v) throw new Error(`${name} is required`);
  return v;
}

function opt(name: string, fallback: string): string {
  const v = (process.env[name] ?? "").trim();
  return v || fallback;
}

function optBool(name: string, fallback: boolean): boolean {
  const v = (process.env[name] ?? "").trim().toLowerCase();
  if (!v) return fallback;
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return fallback;
}

export function loadEnv(): WebEnv {
  const adminRaw = (process.env.WEB_ADMIN_IDS ?? "").trim();
  const adminIds = adminRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const publicBaseUrl = req("WEB_PUBLIC_BASE_URL", "http://127.0.0.1:3000");
  return {
    discordToken: req("DISCORD_TOKEN"),
    discordClientId: opt("DISCORD_CLIENT_ID", ""),
    discordClientSecret: opt("DISCORD_CLIENT_SECRET", ""),
    publicBaseUrl,
    frontendOrigin: opt("FRONTEND_ORIGIN", publicBaseUrl),
    sessionSecret: req("WEB_SESSION_SECRET", "dev-session-secret-change-me"),
    bind: opt("WEB_BIND", "127.0.0.1:3000"),
    databaseUrl:
      (process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? "").trim() ||
      null,
    internalToken: opt("WEB_INTERNAL_TOKEN", ""),
    adminIds,
    botControlUrl: opt("BOT_CONTROL_URL", ""),
    logsEnabled: optBool("WEB_LOGS_ENABLED", false),
    anthropicAdminKey: (process.env.ANTHROPIC_ADMIN_KEY ?? "").trim() || null,
    commit: (process.env.HIBANA_COMMIT ?? "").trim() || null,
  };
}

export function loadTestEnv(overrides: Partial<WebEnv> = {}): WebEnv {
  return {
    discordToken: "test-bot-token",
    discordClientId: "cid",
    discordClientSecret: "csecret",
    publicBaseUrl: "http://127.0.0.1:3000",
    frontendOrigin: "http://127.0.0.1:5173",
    sessionSecret: "test-secret-at-least-16",
    bind: "127.0.0.1:0",
    databaseUrl: null,
    internalToken: "test-internal",
    adminIds: ["1"],
    botControlUrl: "",
    logsEnabled: false,
    anthropicAdminKey: null,
    commit: null,
    ...overrides,
  };
}

export function cookieCrossOrigin(env: WebEnv): boolean {
  try {
    return (
      new URL(env.publicBaseUrl).origin !== new URL(env.frontendOrigin).origin
    );
  } catch {
    return false;
  }
}

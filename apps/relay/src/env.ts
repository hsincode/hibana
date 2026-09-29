export interface RelayEnv {
  bind: string;
  /** git checkout that the bot service runs from. */
  appDir: string;
  /** keys.json and deployments.json live here, owned by the relay user only. */
  stateDir: string;
  service: string;
  remote: string;
  branch: string;
  bun: string;
  readyPattern: string;
  readyTimeoutMs: number;
}

export function loadEnv(source: Record<string, string | undefined> = process.env): RelayEnv {
  const timeout = Number(source.RELAY_READY_TIMEOUT_MS ?? 90_000);
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("RELAY_READY_TIMEOUT_MS must be a positive number");
  return {
    bind: source.RELAY_BIND ?? "127.0.0.1:8790",
    appDir: source.RELAY_APP_DIR ?? "/opt/hibana",
    stateDir: source.RELAY_STATE_DIR ?? "/var/lib/hibana-relay",
    service: source.RELAY_SERVICE ?? "hibana",
    remote: source.RELAY_REMOTE ?? "origin",
    branch: source.RELAY_BRANCH ?? "main",
    bun: source.RELAY_BUN ?? "/usr/local/bin/bun",
    readyPattern: source.RELAY_READY_PATTERN ?? "Hibana ready",
    readyTimeoutMs: timeout,
  };
}

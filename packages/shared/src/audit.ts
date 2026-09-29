/** Stable dimensions shared by the bot producer and API log consumer. */
export const FAILURE_PHASES = [
  "history_read",
  "history_compaction",
  "prompt_assembly",
  "checkpoint_save",
  "agent",
  "discord_send",
  "history_store",
  "checkpoint_clear",
] as const;

export type FailurePhase = (typeof FAILURE_PHASES)[number];

export const FAILURE_CODES = [
  "provider_auth",
  "provider_rate_limit",
  "provider_http",
  "provider_network",
  "provider_response",
  "settings_api",
  "prompt_io",
  "checkpoint_io",
  "discord",
  "agent",
  "history_compaction",
  "unknown",
] as const;

export type FailureCode = (typeof FAILURE_CODES)[number];

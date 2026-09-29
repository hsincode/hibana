import { ProviderError } from "./llm-errors";
import {
  FAILURE_CODES,
  FAILURE_PHASES,
  type FailureCode,
  type FailurePhase,
} from "@hibana/shared/audit";

export { FAILURE_CODES, FAILURE_PHASES };
export type { FailureCode, FailurePhase };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Keep aggregation stable while leaving the full error in the protected log.
 * The phase tells us where a generic turn failure happened; the code groups
 * provider responses that can occur in both the normal and compaction paths.
 */
export function classifyFailure(
  error: unknown,
  phase: FailurePhase,
): FailureCode {
  const message = messageOf(error);
  const lower = message.toLowerCase();
  const providerPhase = phase === "agent" || phase === "history_compaction";

  // Recovery now emits typed, sanitized errors; matching the old LLM message
  // alone would mislabel provider outages as generic agent failures.
  if (providerPhase && error instanceof ProviderError) {
    if (error.kind === "authentication") return "provider_auth";
    if (error.kind === "quota" || error.status === 429) return "provider_rate_limit";
    if (error.status !== undefined) return "provider_http";
    return error.kind === "transient" ? "provider_network" : "provider_response";
  }

  if (/settings api\b/i.test(message)) return "settings_api";
  if (
    providerPhase &&
    /missing api key|api key missing|\bhttp (401|403)\b/i.test(message)
  )
    return "provider_auth";
  if (providerPhase && /\bhttp 429\b|rate.?limit|quota/i.test(lower))
    return "provider_rate_limit";
  if (providerPhase && /\bllm [^:]+: http \d{3}\b/i.test(lower))
    return "provider_http";
  if (
    providerPhase &&
    /provider returned (an api error|no assistant message)|no user-facing answer/i.test(
      message,
    )
  )
    return "provider_response";
  if (
    providerPhase &&
    /abort|timeout|fetch failed|network|socket|econn|enotfound|dns/i.test(
      lower,
    )
  )
    return "provider_network";

  if (phase === "history_compaction") return "history_compaction";
  if (phase === "prompt_assembly") return "prompt_io";
  if (phase === "checkpoint_save" || phase === "checkpoint_clear")
    return "checkpoint_io";
  if (phase === "discord_send") return "discord";
  if (phase === "agent") return "agent";
  return "unknown";
}

export function httpStatusOf(error: unknown): number | null {
  const match = /\bHTTP\s+(\d{3})\b/i.exec(messageOf(error));
  if (!match) return null;
  const status = Number(match[1]);
  return Number.isInteger(status) && status >= 100 && status <= 599
    ? status
    : null;
}

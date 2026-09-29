import type { Context, Message, Usage } from "./types";

/** Codex Stop lifecycle semantics; this is not a hooks.json command runner. */
export type StopHookInput = {
  messages: readonly Message[];
  lastAssistantMessage: string;
  stopHookActive: boolean;
  context: Context;
  signal?: AbortSignal;
  recordUsage: (usage: Usage) => void;
};
export type StopDecision = { decision: "allow" } | { decision: "block"; reason: string };
export type StopHook = (input: StopHookInput) => Promise<StopDecision>;

export class StopHookExhaustedError extends Error {
  constructor() {
    super("Jev completion check still reports an incomplete deliverable after two continuations");
  }
}

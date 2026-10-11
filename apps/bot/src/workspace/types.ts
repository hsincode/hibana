import type { Json } from "../types";
export type { WorkspaceVariant } from "../claude/select";          // "plain" | "ultra"
export type { WorkspaceTotals } from "./usage";

/** One event as parsed from the session stream or the event list. */
export type RawEvent = { type: string; id?: string; processed_at?: string | null; [key: string]: unknown };

/** One custom tool call as it arrived. `threadId` is set for a call made by a
 *  thread other than the primary one; `runId` is the workflow run that thread
 *  belongs to, when the runner knows it. */
export type WorkspaceCall = { id: string; name: string; input: unknown; threadId?: string | null; runId?: string | null };

/** What goes back in `user.custom_tool_result`. */
export type WorkspaceResult = { content: [{ type: "text"; text: string }]; is_error: boolean };

/** Saved on the context (and so in the checkpoint) once the message was accepted. */
export type WorkspaceMark = { sessionId: string; eventId: string; ceilingCents: number; startedAt: number; resumes: number };

/** Persisted per session row. */
export type WorkspaceState = {
  contextDigest?: string;
  openRuns?: { id: string; name: string }[];
  runOwners?: Record<string, string>;      // workflow run id → Discord user id that started it
  toolsFingerprint?: string;
  turns?: number;
};

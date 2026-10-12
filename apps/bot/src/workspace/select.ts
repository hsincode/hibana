import { WORKSPACE_PROVIDER } from "@hibana/shared/catalog";
import type { Selection } from "../config";

/** The path a turn runs on. `workspace`: a message to a Managed Agents
 *  session, for the `anthropic_workspace` provider (#76). `codex`: the bot's
 *  own loop, which every other provider runs on. */
export type Harness = "codex" | "workspace";

/** Which of its two Managed Agents agents a Workspace session runs on (#76):
 *  `ultra` has dynamic workflows enabled, `plain` has no delegation. */
export type WorkspaceVariant = "plain" | "ultra";

export function harnessFor(selection: Pick<Selection, "provider">): Harness {
  return selection.provider === WORKSPACE_PROVIDER ? "workspace" : "codex";
}

/** What a stored conversation or checkpoint is filed under. A Workspace
 *  conversation is held by a cloud session and must never continue, or be
 *  continued by, a conversation of the bot's own loop: its key names the path.
 *  It also names the variant, because the session's agent is fixed when the
 *  session is created. Every other key is exactly what it was before this
 *  path existed, so those conversations survive the deploy that adds it. */
export function conversationKey(selection: Selection, harness: Harness, variant?: WorkspaceVariant): string {
  if (harness === "workspace") return JSON.stringify({ ...selection, harness, variant: variant ?? "plain" });
  return JSON.stringify(selection);
}

export function keyHarness(key: string): Harness {
  try {
    const parsed = JSON.parse(key);
    return (Array.isArray(parsed) ? parsed[0] : parsed)?.harness === "workspace" ? "workspace" : "codex";
  } catch {
    return "codex";
  }
}

/** The variant a Workspace turn runs as. `Runtime.resolve` is the only place
 *  that decides Haiku Ultra; everything else reads its answer through this. */
export const workspaceVariant = (settings: { workspace_ultra?: boolean }): WorkspaceVariant =>
  settings.workspace_ultra ? "ultra" : "plain";

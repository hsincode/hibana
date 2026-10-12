import { WORKSPACE_PROVIDER } from "@hibana/shared/catalog";
import type { Config, Selection } from "../config";

export type Harness = "codex" | "claude" | "workspace";

/** Which of its two Managed Agents agents a Workspace session runs on (#76):
 *  `ultra` has dynamic workflows enabled, `plain` has no delegation. */
export type WorkspaceVariant = "plain" | "ultra";

/** `anthropic` turns run on the Claude harness (#66). Every other provider,
 *  Claude Max and Claude Kiro included, keeps the Codex-style harness it has
 *  always had (#67). `ANTHROPIC_HARNESS=codex` sends `anthropic` back to it.
 *  `anthropic_workspace` turns are Managed Agents sessions (#76); that
 *  setting does not reach them. */
export function harnessFor(selection: Pick<Selection, "provider">, config: Pick<Config, "anthropicHarness">): Harness {
  if (selection.provider === WORKSPACE_PROVIDER) return "workspace";
  return selection.provider === "anthropic" && config.anthropicHarness === "claude" ? "claude" : "codex";
}

/** What a stored conversation or checkpoint is filed under. The harnesses
 *  call tools by different names and build different prompts, so one must
 *  never continue another's history: changing harness starts the
 *  conversation again. The Codex key is exactly what it was before the Claude
 *  harness existed, so those conversations survive the deploy that adds it.
 *  A Workspace key also names the variant, because the session's agent is
 *  fixed when the session is created. */
export function conversationKey(selection: Selection, harness: Harness, variant?: WorkspaceVariant): string {
  if (harness === "workspace") return JSON.stringify({ ...selection, harness, variant: variant ?? "plain" });
  return JSON.stringify(harness === "claude" ? { ...selection, harness } : selection);
}

export function keyHarness(key: string): Harness {
  try {
    const parsed = JSON.parse(key);
    const harness = (Array.isArray(parsed) ? parsed[0] : parsed)?.harness;
    return harness === "claude" || harness === "workspace" ? harness : "codex";
  } catch {
    return "codex";
  }
}

/** The variant a Workspace turn runs as. `Runtime.resolve` is the only place
 *  that decides Haiku Ultra; everything else reads its answer through this. */
export const workspaceVariant = (settings: { workspace_ultra?: boolean }): WorkspaceVariant =>
  settings.workspace_ultra ? "ultra" : "plain";

/** Models that return their between-tool notes as thinking blocks, which stay
 *  empty unless the request asks for them (`thinking.display: "updates"`). */
export const thinkingUpdates = (model: string) => /claude-(opus|sonnet)-5-5/.test(model);

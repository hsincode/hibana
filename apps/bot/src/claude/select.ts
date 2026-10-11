import type { Config, Selection } from "../config";

export type Harness = "codex" | "claude";

/** `anthropic` turns run on the Claude harness (#66). Every other provider,
 *  Claude Max and Claude Kiro included, keeps the Codex-style harness it has
 *  always had (#67). `ANTHROPIC_HARNESS=codex` sends `anthropic` back to it. */
export function harnessFor(selection: Pick<Selection, "provider">, config: Pick<Config, "anthropicHarness">): Harness {
  return selection.provider === "anthropic" && config.anthropicHarness === "claude" ? "claude" : "codex";
}

/** What a stored conversation or checkpoint is filed under. The two harnesses
 *  call tools by different names and build different prompts, so one must
 *  never continue the other's history: changing harness starts the
 *  conversation again. The Codex key is exactly what it was before the Claude
 *  harness existed, so those conversations survive the deploy that adds it. */
export function conversationKey(selection: Selection, harness: Harness): string {
  return JSON.stringify(harness === "claude" ? { ...selection, harness } : selection);
}

export function keyHarness(key: string): Harness {
  try {
    const parsed = JSON.parse(key);
    return (Array.isArray(parsed) ? parsed[0] : parsed)?.harness === "claude" ? "claude" : "codex";
  } catch {
    return "codex";
  }
}

/** Models that return their between-tool notes as thinking blocks, which stay
 *  empty unless the request asks for them (`thinking.display: "updates"`). */
export const thinkingUpdates = (model: string) => /claude-(opus|sonnet)-5-5/.test(model);

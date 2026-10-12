import type { Json, Message, ToolCall } from "../types";

/** A status line for a response that called tools without saying anything.
 *  Haiku 5.5 often does; Opus 5.5 and Sonnet 5.5 say it in a thinking block,
 *  which is used first when the request asked for those. */
export function statusLine(calls: readonly ToolCall[]): string {
  const call = calls[0];
  if (!call) return "";
  let args: Json = {};
  try { args = JSON.parse(call.function.arguments || "{}") as Json; } catch {}
  const text = (value: unknown) => String(value ?? "").replace(/\s+/g, " ").slice(0, 120);
  const name = call.function.name;
  const line =
    name === "Bash" ? text(args.description) || "コマンドを実行しています"
    : name === "Read" ? `読み込み: ${text(args.file_path)}`
    : name === "Edit" || name === "Write" ? `編集: ${text(args.file_path)}`
    : name === "Glob" || name === "Grep" ? `検索: ${text(args.pattern)}`
    : name === "Agent" ? `サブ: ${text(args.description)}`
    : name === "Skill" ? `スキル: ${text(args.skill)}`
    : `ツール: ${name.replace(/^mcp__[a-z]+__/, "")}`;
  return calls.length > 1 ? `${line}（ほか ${calls.length - 1} 件）` : line;
}

/** Removes thinking blocks from the assistant turns, in place. The API binds a
 *  thinking block to everything sent before it; after the system prompt or the
 *  tool list changed (a deploy does that) the old blocks are rejected, and
 *  Anthropic's documented recovery is to send the history once without them.
 *  Returns whether anything was removed. */
export function stripThinking(messages: Message[]): boolean {
  let changed = false;
  for (const m of messages) {
    if (m.role !== "assistant" || !m.providerBlocks?.length) continue;
    const kept = (m.providerBlocks as Json[]).filter((b) => b.type !== "thinking" && b.type !== "redacted_thinking");
    if (kept.length === m.providerBlocks.length) continue;
    changed = true;
    // An assistant turn cannot be empty; one that only thought keeps a marker.
    m.providerBlocks = kept.length ? kept : [{ type: "text", text: "(no visible output)" }];
  }
  return changed;
}

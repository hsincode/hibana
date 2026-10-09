import type { Selection } from "./config";
import type { Context, Message } from "./types";

export type Checkpoint = {
  ctx: Context;
  messages: Message[];
  at: number;
  historyStart: number;
  selectionKey: string;
};

export function checkpointSnapshot(ctx: Context, messages: Message[], historyStart: number, selectionKey: string): Checkpoint {
  const { signal, progress, notify, jevTaskProgress, jevExecutions, recordToolUsage, pendingImages, team, agentPath, agentSelection, openStatus, ...saved } = ctx;
  // The agent keeps appending to its live array. Retaining that reference made
  // /retry use different history from the on-disk checkpoint after a failure.
  return structuredClone({ ctx: saved, messages, at: Date.now(), historyStart, selectionKey });
}

function sameModel(key: string, selection: Selection): boolean {
  try {
    const parsed = JSON.parse(key);
    // Older checkpoints encoded [selection, searchMode]. Compare identities,
    // not JSON property order or effort, neither of which invalidates history.
    const old = Array.isArray(parsed) ? parsed[0] : parsed;
    return old.provider === selection.provider && old.model === selection.model;
  } catch { return false; }
}

function conversation(messages: Message[], compatible: boolean): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < messages.length; i++) {
    let message = structuredClone(messages[i]!);
    if (message.role === "system" || message.role === "developer" || message.role === "tool") continue;
    // assemblePrompt previously stored this user-role policy without metadata.
    if (message.role === "user" && !message.turnStart && message.content?.startsWith("# AGENTS.md instructions\n<INSTRUCTIONS>")) continue;
    if (!compatible) {
      const { providerBlocks, reasoning_content, ...portable } = message;
      message = portable;
    }
    out.push(message);
    const results = new Map<string, Message>();
    // Results must belong to this immediate tool batch, never a later call
    // that happens to reuse an ID after a model change.
    for (let j = i + 1; messages[j]?.role === "tool"; j++) {
      const result = messages[j]!;
      if (result.tool_call_id) results.set(result.tool_call_id, result);
    }
    for (const call of message.tool_calls ?? []) {
      out.push(structuredClone(results.get(call.id) ?? {
        role: "tool", tool_call_id: call.id,
        content: JSON.stringify({
          interrupted: true,
          outcome: "unknown",
          message: "No result was saved before interruption. The operation may have run. Inspect actual state before deciding whether to repeat it; do not assume failure or success.",
        }),
      }));
    }
  }
  return out;
}

export function resumeCheckpoint(checkpoint: Checkpoint, prefix: Message[], selection: Selection) {
  const compatible = sameModel(checkpoint.selectionKey, selection);
  const before = conversation(checkpoint.messages.slice(0, checkpoint.historyStart), compatible);
  const task = conversation(checkpoint.messages.slice(checkpoint.historyStart), compatible);
  // Rebuild current policy while retaining the task and completed tool results.
  // A provider/model change discards opaque reasoning, not the user's progress.
  return { messages: [...prefix, ...before, ...task], historyStart: prefix.length + before.length };
}

/** A checkpoint can end with a drafted answer: it is saved before delivery, so
 *  a failed Discord send leaves it last. `/retry` adds no user text, and
 *  Anthropic rejects a request ending in an assistant turn as prefill (HTTP
 *  400 in production, #50). Tool calls never end a resumed history: each gets
 *  a result, saved or marked unknown. */
export function resumeNote(messages: readonly Message[]): Message | undefined {
  if (messages.at(-1)?.role !== "assistant") return;
  return { role: "user", internal: true,
    content: "The previous attempt stopped after the answer above was drafted; it may not have reached the user. Continue the authorized task and reply with the complete, self-contained final answer. Do not repeat side effects that already succeeded." };
}

export function checkpointInScope(checkpoint: Checkpoint, ctx: Context): boolean {
  return checkpoint.ctx.channelId === ctx.channelId && checkpoint.ctx.userId === ctx.userId
    && checkpoint.ctx.guildId === ctx.guildId && checkpoint.ctx.thread === ctx.thread;
}

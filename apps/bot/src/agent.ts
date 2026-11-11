import type { ServiceTier } from "@hibana/shared/settings";
import { awaitsServerTool, LlmClient } from "./llm";
import { failureDetail } from "./llm-errors";
import type { Selection } from "./config";
import { jevTaskModeIn, jevTaskModeMessage } from "./jev-task";
import { Serial } from "./io";
import { runToolBatch, supportsParallelTool } from "./tool-concurrency";
import {
  addUsage,
  emptyUsage,
  scopedContext,
  type Context,
  type Message,
  type ToolDef,
  type Usage,
} from "./types";
export type AgentResult = {
  text: string;
  messages: Message[];
  usage: Usage;
  rounds: number;
};
export type AgentOptions = {
  selection: Selection;
  messages: Message[];
  tools: ToolDef[];
  getTools?: (ctx: Context) => ToolDef[];
  jevTaskMode?: (ctx: Context) => boolean;
  context: Context;
  maxRounds: number;
  serviceTier?: ServiceTier;
  temperature: number;
  nativeSearch: boolean;
  execute: (
    name: string,
    args: Record<string, unknown>,
    ctx: Context,
  ) => Promise<unknown>;
  observeMessages?: (messages: Message[]) => void;
  recordUsage?: (usage: Usage) => void;
  /** Runs at the stop boundary with the candidate answer; returned messages
   *  continue the loop (worker results, the Multi-Agent review gate). */
  beforeFinal?: (candidate?: string) => Promise<Message[]>;
  checkpoint?: (messages: Message[], usage: Usage) => Promise<void>;
  takeSteering?: () => Message[];
  requestSignal?: () => AbortSignal | undefined;
  /** Ends the loop without another model call, e.g. once a workflow agent's
   *  StructuredOutput call has been accepted (its answer is that call). */
  shouldStop?: () => boolean;
};
export class Agent {
  constructor(readonly llm: LlmClient) {}
  async run(o: AgentOptions): Promise<AgentResult> {
    const messages = structuredClone(o.messages),
      usage = emptyUsage(),
      seen = new Map<string, number>();
    o.observeMessages?.(messages);
    // Names one request chain in the usage log. A child gets a random id per
    // run: its path carries a model-chosen task name, which must not be logged.
    const lineage =
      o.context.depth === 0
        ? "root"
        : `${o.context.workflowAgent ? "workflow" : "child"}-${crypto.randomUUID().slice(0, 8)}`;
    // The note stays in history, so a turn repeats it only when the mode
    // changed. Re-sending it every turn would split each turn from the last.
    let lastTaskMode = jevTaskModeIn(messages);
    let nudges = 0;
    // The soft budget is refilled once, matching the original loop's completion guarantee.
    const hardLimit =
      o.context.team || o.context.depth === 0 ? 512 : o.maxRounds;
    // Messages kept out of a request that continues a pending server tool
    // (#103). They are appended once the turn that ran the tool is in.
    const held: Message[] = [];
    let lastTools: ToolDef[] | undefined;
    for (let round = 0; round < hardLimit; round++) {
      o.context.signal?.throwIfAborted();
      if (held.length) messages.push(...held.splice(0));
      // The last response called a client tool beside a server tool the API
      // has not run yet. This request must carry the client results alone
      // and keep the same tools, so steering stays queued, the Jev mode is
      // not re-read, and other messages after the results wait (#103).
      const waiting = awaitsServerTool(
        messages[messages.map((m) => m.role).lastIndexOf("assistant")],
      );
      const steer = waiting ? [] : (o.takeSteering?.() ?? []);
      if (steer.length) messages.push(...steer);
      const taskMode = waiting
        ? lastTaskMode
        : (o.jevTaskMode?.(o.context) ?? false);
      if (o.jevTaskMode && taskMode !== lastTaskMode) {
        // Re-read at each planning boundary for live settings. A checkpoint
        // drops developer notes, so a resumed task is told an active mode again.
        messages.push(jevTaskModeMessage(taskMode));
        lastTaskMode = taskMode;
      }
      const tools =
        waiting && lastTools ? lastTools : (o.getTools?.(o.context) ?? o.tools);
      lastTools = tools;
      const registered = new Set(tools.map((t) => t.function.name));
      // Persist steering and continuation instructions before the next network
      // request; a failed request must not restore an older user intention.
      await o.checkpoint?.(messages, usage);
      // The checkpoint keeps the waiting messages where they are; a resumed
      // run holds them back again.
      let outgoing = messages;
      let deferred: Message[] = [];
      if (waiting) {
        const at = messages.map((m) => m.role).lastIndexOf("assistant");
        const after = messages.slice(at + 1);
        deferred = after.filter((m) => m.role !== "tool");
        outgoing = [
          ...messages.slice(0, at + 1),
          ...after.filter((m) => m.role === "tool"),
        ];
      }
      let completion;
      // This request's reconnect lines, taken back once it is over (#140):
      // the response arrived, or it failed and the failure notice says how
      // often it reconnected.
      const reconnect = {};
      let reconnected = false;
      try {
        completion = await this.llm.complete(o.selection, outgoing, tools, {
          serviceTier: o.serviceTier,
          temperature: o.temperature,
          nativeSearch: !taskMode && o.nativeSearch,
          signal: o.requestSignal?.() ?? o.context.signal,
          trace: {
            channel: o.context.channelId,
            agent: lineage,
            round,
            child: o.context.depth > 0,
          },
          onRetry: async ({ attempt, maxRetries, status, diagnostics }) => {
            const detail = failureDetail(diagnostics, status);
            reconnected = true;
            await o.context
              .progress?.(
                `応答を再接続しています（${attempt}/${maxRetries}${detail ? `・${detail}` : ""}）。進捗は保持しています。`,
                reconnect,
              )
              .catch(() => {});
          },
        });
      } catch (error) {
        if (!o.context.signal?.aborted) {
          const fresh = o.takeSteering?.() ?? [];
          if (fresh.length) {
            messages.push(...fresh);
            continue;
          }
        }
        throw error;
      } finally {
        if (reconnected)
          await o.context.retractProgress?.(reconnect).catch(() => {});
      }
      addUsage(usage, completion.usage);
      o.recordUsage?.(completion.usage);
      const msg = completion.message;
      if (deferred.length) {
        // History follows what was sent: the waiting messages move behind
        // this response (behind its tool results, if it called tools).
        const kept = messages.filter((m) => !deferred.includes(m));
        messages.splice(0, messages.length, ...kept);
        held.push(...deferred);
      }
      messages.push(msg);
      const calls = msg.tool_calls ?? [];
      if (calls.length) {
        // Keep long tool-driven turns visible. The Discord transport stacks
        // progress in one message (#134), so retries and parallel subagents
        // add lines instead of a message each.
        if (msg.content?.trim()) await o.context.progress?.(msg.content);
        // Journal the whole requested batch before side effects. A crash can
        // leave unknown outcomes, which /retry must inspect instead of replay.
        await o.checkpoint?.(messages, usage);
        const results = new Serial();
        const truncated = new Set(completion.truncatedToolCalls);
        const execute = async (call: (typeof calls)[number]) => {
          let result: unknown;
          try {
            o.context.signal?.throwIfAborted();
            // Its arguments were cut off and replaced by `{}`: running it
            // would act on input the model never wrote (#144).
            if (truncated.has(call.id)) throw new Error(TRUNCATED_CALL);
            if (!registered.has(call.function.name))
              throw new Error(`Tool unavailable: ${call.function.name}`);
            const args = JSON.parse(call.function.arguments || "{}");
            if (!args || typeof args !== "object" || Array.isArray(args))
              throw new Error("Arguments must be an object");
            const canonical = stableJson(args);
            const key = call.function.name + canonical;
            const count = (seen.get(key) ?? 0) + 1;
            seen.set(key, count);
            // Mailbox waits and listings are observations; repeating them is
            // normal while another agent works, unlike repeated side effects.
            if (
              count >= 3 &&
              !/^(agents__)?(wait_agent|list_agents)$/.test(call.function.name)
            )
              throw new Error(
                "Repeated identical tool call blocked. Use existing results or change the approach.",
              );
            const jev = /^(?:mcp__agent__)?run_jev(?:_task)?$/.test(
              call.function.name,
            );
            // A bounded Jev loop can outlive a parent completion. Forward user
            // steering cancellation so it cannot keep executing the old plan.
            const ctx = jev
              ? scopedContext(o.context, {
                  // Nested Jev actions must attach images to the parent conversation.
                  pendingImages: (o.context.pendingImages ??= []),
                  jevExecutions: (o.context.jevExecutions ??= { count: 0 }),
                  signal: AbortSignal.any([
                    ...(o.context.signal ? [o.context.signal] : []),
                    ...(o.requestSignal
                      ? [o.requestSignal()].filter((s): s is AbortSignal => !!s)
                      : []),
                  ]),
                  recordToolUsage: (u: Usage) => {
                    addUsage(usage, u);
                    o.recordUsage?.(u);
                  },
                })
              : o.context;
            try {
              result = await o.execute(call.function.name, args, ctx);
            } finally {
              o.context.delivered ||= ctx.delivered;
            }
          } catch (error) {
            result = {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            };
          }
          // Serialize result journaling, not network work. Concurrent atomic
          // renames could otherwise replace a newer checkpoint with an older one.
          await results.run(async () => {
            messages.push({
              role: "tool" as const,
              tool_call_id: call.id,
              content: JSON.stringify(result ?? null).slice(0, 40000),
            });
            await o.checkpoint?.(messages, usage);
          });
        };
        await runToolBatch(
          calls,
          (call) => {
            try {
              return supportsParallelTool(
                call.function.name,
                JSON.parse(call.function.arguments || "{}"),
              );
            } catch {
              return false;
            }
          },
          execute,
        );
        if (o.context.pendingImages?.length)
          messages.push({
            role: "user",
            internal: true,
            content: "Images loaded by the preceding tools:",
            images: o.context.pendingImages.splice(0),
          });
        await o.checkpoint?.(messages, usage);
        if (o.shouldStop?.()) {
          messages.push(...held.splice(0));
          return {
            text: msg.content?.trim() ?? "",
            messages,
            usage,
            rounds: round + 1,
          };
        }
        if (round === o.maxRounds - 2)
          messages.push({
            role: "user",
            internal: true,
            content:
              "Finish the remaining work efficiently. Persist and deliver the result before your final reply.",
          });
        continue;
      }
      const fresh = [...held.splice(0), ...(o.takeSteering?.() ?? [])];
      if (fresh.length) {
        messages.push(...fresh);
        continue;
      }
      const collaboration =
        (await o.beforeFinal?.(msg.content?.trim() ?? "")) ?? [];
      const lateSteering = o.takeSteering?.() ?? [];
      if (collaboration.length || lateSteering.length) {
        messages.push(...collaboration, ...lateSteering);
        continue;
      }
      const text = msg.content?.trim() ?? "";
      if (o.shouldStop?.()) return { text, messages, usage, rounds: round + 1 };
      // Empty/truncated transport responses are not a candidate final answer.
      // Nothing judges semantic completion: no regexes over Japanese/English
      // delivery claims, no unconditional extra turns (#50).
      if ((!text || completion.incomplete) && nudges++ < 3) {
        messages.push({
          role: "user",
          internal: true,
          content:
            "Continue the authorized task. Produce a complete user-facing answer; ask a concrete question only if blocked.",
        });
        continue;
      }
      if (!text) throw new Error("Provider returned no user-facing answer");
      await o.checkpoint?.(messages, usage);
      return { text, messages, usage, rounds: round + 1 };
    }
    messages.push(...held.splice(0));
    await o.checkpoint?.(messages, usage);
    throw new Error(
      "Agent reached the hard tool-round limit; progress has been saved for /retry",
    );
  }
}

const TRUNCATED_CALL =
  "The response reached the output token limit while writing this call's arguments, so the call was cut off and was not run. Call it again with smaller arguments, for example by splitting the content across several calls.";

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ":" + stableJson(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}

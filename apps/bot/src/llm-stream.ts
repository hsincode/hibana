import type { Json } from "./types";
import { apiFailure, ProviderError } from "./llm-errors";

export type Protocol = "chat" | "responses" | "anthropic";
const interrupted = () => new ProviderError("transient", true);
// Bound memory even if a broken gateway never sends a completion marker.
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const MAX_EVENT_CHARS = 8 * 1024 * 1024;

async function* chunks(response: Response, signal: AbortSignal, activity: () => void) {
  if (!response.body) throw interrupted();
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) return;
      if (!next.value.length) continue;
      activity();
      size += next.value.length;
      if (size > MAX_BODY_BYTES) throw new ProviderError("protocol", false);
      yield next.value;
    }
  } finally {
    signal.removeEventListener("abort", abort);
    // A terminal event is sufficient; do not wait for a proxy to close TCP.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function* events(response: Response, signal: AbortSignal, activity: () => void) {
  const decoder = new TextDecoder();
  let buffer = "", data: string[] = [], event = "", eventSize = 0;
  for await (const chunk of chunks(response, signal, activity)) {
    buffer += decoder.decode(chunk, { stream: true });
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end).replace(/\r$/, "");
      buffer = buffer.slice(end + 1);
      if (!line) {
        if (data.length) yield { event, data: data.join("\n") };
        data = []; event = ""; eventSize = 0;
      } else if (line.startsWith("data:")) {
        const value = line.slice(5).replace(/^ /, "");
        eventSize += value.length;
        if (eventSize > MAX_EVENT_CHARS) throw new ProviderError("protocol", false);
        data.push(value);
      } else if (line.startsWith("event:")) event = line.slice(6).trim();
    }
    if (buffer.length > MAX_EVENT_CHARS) throw new ProviderError("protocol", false);
  }
  // SSE dispatch requires a blank line. EOF with a partial frame is a broken
  // response, never permission to execute partially received tool arguments.
}

export async function readCompletion(
  response: Response, protocol: Protocol, signal: AbortSignal, activity: () => void,
): Promise<Json> {
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    const decoder = new TextDecoder();
    let text = "";
    for await (const chunk of chunks(response, signal, activity))
      text += decoder.decode(chunk, { stream: true });
    return JSON.parse(text + decoder.decode()) as Json;
  }
  const message: Json = { role: "assistant", content: "" };
  const calls = new Map<number, Json>();
  const blocks = new Map<number, Json>();
  const inputs = new Map<number, string>();
  let usage: Json = {}, finish: unknown, started = false;
  for await (const frame of events(response, signal, activity)) {
    if (frame.data === "[DONE]") {
      if (protocol !== "chat" || !started || !finish) throw interrupted();
      return { choices: [{ message: { ...message, tool_calls: [...calls.values()] }, finish_reason: finish }], usage };
    }
    const data = JSON.parse(frame.data) as Json;
    const type = data.type ?? frame.event;
    if (data.error) throw apiFailure(data.error, String(type));
    if (type === "error") throw apiFailure(data, "error");
    if (protocol === "responses") {
      // Codex can omit completed items from the terminal envelope. Retain
      // only output_item.done blocks, never partially streamed tool arguments.
      if (type === "response.output_item.done" && data.item)
        blocks.set(Number(data.output_index), data.item as Json);
      if (type === "response.failed") throw apiFailure((data.response as Json)?.error, "response.failed");
      if (type === "response.completed" || type === "response.incomplete") {
        const result = data.response as Json;
        if (!result || !Array.isArray(result.output)) throw interrupted();
        // The final response contains reasoning/encrypted blocks and call IDs;
        // replaying only text deltas loses the provider's conversation state.
        if (!result.output.length && blocks.size)
          result.output = [...blocks.entries()].sort(([a], [b]) => a - b).map(([, item]) => item);
        return result;
      }
    } else if (protocol === "anthropic") {
      if (type === "message_start") {
        started = true;
        usage = { ...((data.message as Json)?.usage as Json) };
      } else if (type === "content_block_start") {
        blocks.set(Number(data.index), { ...(data.content_block as Json) });
      } else if (type === "content_block_delta") {
        const index = Number(data.index), block = blocks.get(index), delta = data.delta as Json;
        if (!block || !delta) throw interrupted();
        if (delta.type === "input_json_delta") inputs.set(index, (inputs.get(index) ?? "") + String(delta.partial_json ?? ""));
        // Web search answers cite sources; keep them so the replayed turn matches.
        else if (delta.type === "citations_delta") block.citations = [...((block.citations as unknown[]) ?? []), delta.citation];
        else for (const key of ["text", "thinking", "signature"]) {
          if (typeof delta[key] === "string") block[key] = String(block[key] ?? "") + delta[key];
        }
      } else if (type === "message_delta") {
        finish = (data.delta as Json)?.stop_reason;
        usage = { ...usage, ...(data.usage as Json) };
      } else if (type === "message_stop") {
        if (!started || !finish) throw interrupted();
        for (const [index, input] of inputs) blocks.get(index)!.input = JSON.parse(input);
        return { content: [...blocks.entries()].sort(([a], [b]) => a - b).map(([, block]) => block), usage, stop_reason: finish };
      }
    } else {
      if (data.usage) usage = data.usage as Json;
      const choice = (data.choices as Json[] | undefined)?.find(c => Number(c.index ?? 0) === 0);
      if (!choice) continue; // Usage-only final chunk, or provider keepalive.
      started = true;
      const delta = (choice.delta ?? {}) as Json;
      if (typeof delta.content === "string") message.content += delta.content;
      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (typeof reasoning === "string") message.reasoning_content = String(message.reasoning_content ?? "") + reasoning;
      for (const raw of (delta.tool_calls ?? []) as Json[]) {
        const index = Number(raw.index ?? 0);
        const call = calls.get(index) ?? { id: "", type: "function", function: { name: "", arguments: "" } };
        if (raw.id) call.id = raw.id;
        const f = (raw.function ?? {}) as Json, target = call.function as Json;
        for (const key of ["name", "arguments"]) if (typeof f[key] === "string") target[key] = String(target[key] ?? "") + f[key];
        calls.set(index, call);
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }
  }
  throw interrupted();
}

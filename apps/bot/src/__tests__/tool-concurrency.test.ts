import { expect, test } from "bun:test";
import { Agent, type AgentOptions } from "../agent";
import { loadConfig } from "../config";
import { LlmClient } from "../llm";
import { MAX_PARALLEL_TOOLS, supportsParallelTool } from "../tool-concurrency";
import type { Message, ToolCall, ToolDef } from "../types";

const gate = () => Promise.withResolvers<void>();
const call = (id: string, name = "web_search"): ToolCall => ({
  id, type: "function", function: { name, arguments: JSON.stringify({ query: id }) },
});
async function scenario(calls: ToolCall[], overrides: Partial<AgentOptions>) {
  let requests = 0;
  const config = loadConfig({ PROVIDER: "custom", LLM_MODEL: "fixture", LLM_BASE_URL: "https://example.com", LLM_API_KEY: "fixture" });
  const agent = new Agent(new LlmClient(config, async () => Response.json({
    choices: [{ message: requests++ ? { role: "assistant", content: "Done" } : { role: "assistant", tool_calls: calls } }],
  })));
  return agent.run({
    selection: config.selection, messages: [{ role: "user", content: "Research" }],
    tools: [...new Set(calls.map(c => c.function.name))].map(name => ({ type: "function", function: { name, description: name, parameters: {} } })) as ToolDef[],
    context: { channelId: "c", userId: "u", botId: "b", thread: false, depth: 0, delivered: false },
    maxRounds: 20, temperature: 0, nativeSearch: false,
    execute: async () => ({}), ...overrides,
  });
}

test("agent overlaps independent aliases, journals each result, and preserves mutation barriers", async () => {
  const first = gate(), events: string[] = [], saved: string[][] = [];
  let saving = 0, peakSaving = 0;
  const result = await scenario([
    call("a"), call("b", "mcp__web__web_fetch_exa"), call("write", "write_file"), call("read", "Read"),
  ], {
    execute: async (_name, args) => {
      const id = String(args.query);
      events.push(`start:${id}`);
      if (id === "a") await first.promise;
      if (id === "b") first.resolve();
      if (id === "write") expect(saved.at(-1)).toHaveLength(2);
      events.push(`end:${id}`);
      return { id };
    },
    checkpoint: async (messages) => {
      peakSaving = Math.max(peakSaving, ++saving);
      const before = messages.length;
      await Promise.resolve();
      expect(messages).toHaveLength(before);
      saved.push(messages.filter(m => m.role === "tool").map(m => m.tool_call_id!));
      saving--;
    },
  });
  expect(events.indexOf("start:b")).toBeLessThan(events.indexOf("end:a"));
  expect(events.indexOf("start:write")).toBeGreaterThan(events.indexOf("end:a"));
  expect(events.indexOf("start:read")).toBeGreaterThan(events.indexOf("end:write"));
  expect(peakSaving).toBe(1);
  expect(result.messages.filter(m => m.role === "tool").map(m => m.tool_call_id).sort()).toEqual(["a", "b", "read", "write"]);
});

test("large tool batches are bounded and one tool failure preserves siblings", async () => {
  const release = gate();
  let active = 0, peak = 0;
  const result = await scenario(Array.from({ length: 15 }, (_, i) => call(String(i))), {
    execute: async (_name, args) => {
      peak = Math.max(peak, ++active);
      if (active === MAX_PARALLEL_TOOLS) release.resolve();
      await release.promise;
      active--;
      if (args.query === "3") throw new Error("search failed");
      return { id: args.query };
    },
  });
  expect(peak).toBe(MAX_PARALLEL_TOOLS);
  const results = result.messages.filter(m => m.role === "tool");
  expect(results).toHaveLength(15);
  expect(JSON.parse(results.find(m => m.tool_call_id === "3")!.content!)).toEqual({ ok: false, error: "search failed" });
});

test("checkpoint failure drains started reads and prevents later mutations", async () => {
  const release = gate();
  let siblingDone = false, written = false;
  const pending = scenario([call("a"), call("b"), call("write", "write_file")], {
    execute: async (_name, args) => {
      if (args.query === "b") { await release.promise; siblingDone = true; }
      if (args.query === "write") written = true;
      return {};
    },
    checkpoint: async (messages: Message[]) => {
      if (messages.some(m => m.role === "tool")) {
        release.resolve();
        throw new Error("disk unavailable");
      }
    },
  });
  await expect(pending).rejects.toThrow("disk unavailable");
  expect(siblingDone).toBe(true);
  expect(written).toBe(false);
});

test("cancellation prevents queued tool effects and aliases cannot parallelize writes", async () => {
  const controller = new AbortController(), release = gate();
  let started = 0;
  await expect(scenario(Array.from({ length: 15 }, (_, i) => call(String(i))), {
    context: { channelId: "c", userId: "u", botId: "b", thread: false, depth: 0, delivered: false, signal: controller.signal },
    execute: async () => {
      if (++started === MAX_PARALLEL_TOOLS) { controller.abort(new Error("Stopped")); release.resolve(); }
      await release.promise;
      return {};
    },
  })).rejects.toThrow("Stopped");
  expect(started).toBe(MAX_PARALLEL_TOOLS);
  for (const name of ["bash", "shell_command", "Bash", "playwright_cli", "mcp__workspace__write_file", "mcp_call_tool", "run_jev_task", "unknown"])
    expect(supportsParallelTool(name)).toBe(false);
  expect(supportsParallelTool("use_tool", { tool_name: "write_file", arguments: {} })).toBe(false);
  expect(supportsParallelTool("WebSearch")).toBe(true);
});

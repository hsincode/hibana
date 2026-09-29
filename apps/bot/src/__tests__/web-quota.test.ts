import { expect, spyOn, test } from "bun:test";
import { Client } from "discord.js";
import { Agent } from "../agent";
import { loadConfig } from "../config";
import { LlmClient } from "../llm";
import { Runtime } from "../runtime";
import { ToolRegistry } from "../tools";
import { WebTools } from "../tools/web";
import { emptyUsage, type Context, type Json } from "../types";

test("public Exa quota notices stop a Jev dependency chain even when MCP claims success", async () => {
  const runtime = new Runtime(loadConfig({
    RUNTIME_STATE_PATH: "", EXA_API_KEY: "", JEV_API_KEY: "fixture", JEV_TASK_ENABLED: "true",
    SANDBOX_ENABLED: "false", SKILLS_ENABLED: "false",
  }));
  const client = new Client({ intents: [] });
  const registry = new ToolRegistry(runtime, client, new Agent(new LlmClient(runtime.config)));
  const ctx: Context = { channelId: "1", userId: "2", botId: "3", thread: false, depth: 0, delivered: false, notify: async () => {} };
  // Replace only the network boundary; exercise search normalization, registry
  // dispatch and Jev's dependency handling with the real production objects.
  const mcp = spyOn(WebTools.prototype as unknown as { mcp: () => Promise<unknown> }, "mcp");
  mcp.mockResolvedValue({ isError: false, content: [{ type: "text", text: "You've hit Exa's free MCP rate limit. To continue using without limits, create your own Exa API key." }] });
  registry.jev.decide = async () => ({ model: "fixture", answers: { action: { type: "choice", choice: "a0" } }, usage: emptyUsage(), cost: 0 });
  try {
    const result = await registry.execute("run_jev_task", {
      objective: "Find a source and then verify it", state: "No evidence yet", actions: [
        { id: "search", description: "Find evidence", tool: "websearch", arguments: { query: "TypeScript documentation" } },
        { id: "verify", description: "Cross-check findings", tool: "websearch", arguments: { query: "TypeScript reference" }, depends_on: ["search"] },
      ],
    }, ctx) as Json;
    expect(result.status).toBe("needs_replan");
    expect(result.remaining).toEqual(["search", "verify"]);
    expect(result.observations).toMatchObject([{ tool: "websearch", ok: false }]);
    expect(JSON.stringify(result.observations)).toContain("No search results were returned");
    expect(mcp).toHaveBeenCalledTimes(1);

    // A real search hit discussing this error is still valid evidence.
    const source = { isError: false, content: [{ type: "text", text: "Title: Exa troubleshooting\nYou've hit Exa's free MCP rate limit." }] };
    mcp.mockResolvedValue(source);
    expect(await registry.execute("websearch", { query: "quota documentation" }, { ...ctx, depth: 1 })).toEqual(source);
  } finally { mcp.mockRestore(); await registry.close(); client.destroy(); }
});

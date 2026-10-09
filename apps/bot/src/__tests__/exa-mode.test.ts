import { expect, test } from "bun:test";
import { Client } from "discord.js";
import { Agent } from "../agent";
import { loadConfig } from "../config";
import { LlmClient, nativeSearchFor } from "../llm";
import { Runtime } from "../runtime";
import { ToolRegistry } from "../tools";
import type { Context } from "../types";

// exa: auto = provider-native search first, on = Exa only, off = no web
// search at all (#46).
const surface = (env: Record<string, string>) => {
  const runtime = new Runtime(loadConfig({
    RUNTIME_STATE_PATH: "", SANDBOX_ENABLED: "false", SKILLS_ENABLED: "false", ...env,
  }));
  const registry = new ToolRegistry(runtime, new Client({ intents: [] }), new Agent(new LlmClient(runtime.config)));
  const ctx: Context = { channelId: "1", userId: "2", botId: "3", thread: false, depth: 0, delivered: false };
  const names = registry.base(ctx).map(t => t.function.name);
  return names.filter(n => /web/i.test(n));
};

test("exa on exposes Exa; off exposes no web tool, also in Jev task mode", () => {
  expect(surface({ EXA_ENABLED: "true" })).toEqual(expect.arrayContaining(["websearch", "web_fetch_exa"]));
  expect(surface({ EXA_ENABLED: "false" })).toEqual([]);
  expect(surface({ EXA_ENABLED: "false", JEV_API_KEY: "fixture", JEV_TASK_ENABLED: "true" })).toEqual([]);
});

test("exa auto drops Exa only where the provider's own search replaces it", () => {
  expect(surface({ PROVIDER: "anthropic", ANTHROPIC_API_KEY: "fixture", LLM_MODEL: "claude-sonnet-5-5" })).toEqual([]);
  expect(surface({ PROVIDER: "claude_max", CLAUDE_MAX_API_KEY: "fixture", LLM_MODEL: "claude-opus-5-5" }))
    .toEqual(expect.arrayContaining(["websearch", "web_fetch_exa"]));
});

test("exa off never turns on provider-native search", () => {
  for (const provider of ["anthropic", "deepseek", "openai", "claude_max"])
    expect(nativeSearchFor({ provider, model: "m" }, "off", true)).toBe(false);
});

import type { Selection } from "./config";
import codex from "./tools/codex-definitions.json";
import type { Json } from "./types";
import { TASK_STOP_TOOL, WORKFLOW_TOOL } from "./workflow/prompts";

// Anthropic's own tool search (decision record: #126). Every definition is
// still sent; the ones marked `defer_loading` stay out of the model's context
// until a search returns them, and the API expands them inline after the
// cached prefix, so the prefix is not rewritten. Only the `anthropic`
// provider: Claude Max's gateway is not verified to pass server tools (the
// same reason its web search stays on Exa), and other providers have no such
// tool. Source: https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool

export const TOOL_SEARCH = {
  type: "tool_search_tool_bm25_20251119",
  name: "tool_search_tool_bm25",
};

// The models in the documentation's compatibility table (checked 2026-10-28).
// Unreleased ids such as claude-opus-5-6 are not in it and keep every tool
// loaded; a model without the tool would reject the whole request.
const SUPPORTED =
  /^claude-(fable-5-1|fable-5|mythos-5-1|mythos-5|opus-5-5|opus-5|sonnet-5-5|sonnet-5|haiku-5-5|opus-4-[5-8]|sonnet-4-[56]|haiku-4-5)(-\d{8})?$/;

export function toolSearchFor(selection: Selection): boolean {
  return selection.provider === "anthropic" && SUPPORTED.test(selection.model);
}

// Tools that stay loaded: the harness's own (shell, patch, plan, image), the
// file reads an explorer gets back, delivery, the current channel's messages,
// skills, Jev, web search and the collaboration and workflow tools. The
// documentation advises keeping the most used ones loaded so they need no
// search first. Names are compared without the `mcp__<group>__` prefix.
export const LOADED_TOOLS = new Set([
  ...(codex as { function: { name: string } }[]).map((t) => t.function.name),
  "request_user_input",
  "read_file",
  "list_files",
  "grep_files",
  "send_file",
  "publish_site",
  "read_messages",
  "use_skill",
  "run_jev",
  "run_jev_task",
  "websearch",
  "web_fetch_exa",
  WORKFLOW_TOOL,
  TASK_STOP_TOOL,
]);

// Only the integration tools (`mcp__<group>__name`) are deferred; the
// harness's and the collaboration tools have other names and stay loaded.
const deferrable = (name: string) => {
  const bare = /^mcp__[^_]+__(.+)$/.exec(name)?.[1];
  return !!bare && !LOADED_TOOLS.has(bare);
};
// The documentation suggests tool search from about ten tools; below that a
// search costs a round and saves little. A role or workflow agent with a few
// tools keeps them all loaded.
const MIN_DEFERRED = 10;

// What a model can find, per `mcp__<group>__` prefix, so that it searches
// before it tells the user a capability is missing. `namespaced()` files the
// VPN and remote MCP tools under discord.
const GROUPS: Record<string, string> = {
  discord:
    "Discord (other channels, message search, members, roles, emojis, stickers, threads, moderation), the VPN and remote MCP servers",
  settings: "the bot's and the server's settings",
  skills: "managing skills",
  sites: "managing published sites",
  workspace:
    "files, downloads, images, video, the browser, VPN and GitHub login",
  web: "filtered web search",
};

/** The Anthropic `tools` array with the rarely used tools deferred and the
 *  search tool added, and the line to add to the system prompt. Unchanged,
 *  with no line, when fewer than MIN_DEFERRED tools would be deferred. Hibana's own `tool_search`
 *  is dropped: it searches the same definitions and returns schemas the
 *  model would then believe it can call without loading them. */
export function deferTools(tools: Json[]): { tools: Json[]; note?: string } {
  const deferred = tools.filter((t) => deferrable(String(t.name)));
  if (deferred.length < MIN_DEFERRED) return { tools };
  const groups = [
    ...new Set(deferred.map((t) => String(t.name).split("__")[1]!)),
  ].sort();
  return {
    tools: [
      ...tools
        .filter((t) => t.name !== "tool_search")
        .map((t) => (deferred.includes(t) ? { ...t, defer_loading: true } : t)),
      TOOL_SEARCH,
    ],
    note:
      `Some of your tools are not loaded yet. Search for them with ${TOOL_SEARCH.name} before telling the user that something cannot be done. ` +
      `Tools can be found for: ${groups.map((g) => GROUPS[g] ?? g).join("; ")}.`,
  };
}

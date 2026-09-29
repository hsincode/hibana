import { readFile, rm, mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Message, ToolDef, Json, Context } from "./types";
import type { Runtime } from "./runtime";
import type { Sandbox } from "./tools/sandbox";
import codex from "./tools/codex-definitions.json";
import { collaborationNames } from "./multi-agent-policy";
import { subagentMode } from "@hibana/shared/settings";
import { roleCatalogText } from "./agent-roles";
import { requestUserInputTool } from "./tools/questions";

// Both texts are HsinCLI's multi_agent_mode_instructions.rs, unchanged. The
// proactive branch was Codex's Ultra; Ultra is now Claude Code's Ultracode
// (ultracode.ts), so only Multi-Agent sends it. Off/on/Ultra keep the explicit
// branch for the agents__ tools: Ultracode's standing opt-in covers the
// Workflow tool and arrives as system reminders, not as this policy.
// Jev guidance belongs in its own scope so enabling it cannot redefine either.
const EXPLICIT_MULTI_AGENT_MODE =
  "Any earlier instruction enabling proactive multi-agent delegation no longer applies. Do not spawn sub-agents unless the user or applicable AGENTS.md/skill instructions explicitly ask for sub-agents, delegation, or parallel agent work.";
const PROACTIVE_MULTI_AGENT_MODE =
  "Proactive multi-agent delegation is active. Any earlier developer instruction requiring an explicit user request before spawning sub-agents no longer applies. This mode remains active until a later multi-agent mode developer message changes it. User requests override this hint.\n\nIf at any point you can parallelize work by delegating tasks to another agent (no matter if you are root or subagent), you should do so using collaboration tools if it could save time or improve quality.";

export function multiAgentModeMessage(proactive: boolean): Message {
  // Emit the explicit branch too, so leaving Multi authoritatively resets the
  // prior proactive policy just like HsinCLI's per-turn Multi-Agent V2 state.
  const instruction =
    proactive ? PROACTIVE_MULTI_AGENT_MODE : EXPLICIT_MULTI_AGENT_MODE;
  return {
    role: "developer",
    content: `<multi_agent_mode>${instruction}</multi_agent_mode>`,
  };
}

// Multi-Agent sends the proactive HsinCLI text above plus this separate scope,
// so leaving Multi drops only this block. Production probes (2026-09-23),
// where "Ultra" was still the Codex proactive mode, shaped this text:
// - "answer simple work yourself" produced one explorer where Ultra used 2-3;
// - "always delegate" then spent 256 s on a writing task Ultra did in 32 s;
// - orchestrator-spawned reviewers re-researched for up to 6 minutes, while
//   the runtime gate is bounded and delivers at once on PASS;
// - viewpoint splits overlapped, and merged reports read longer than Ultra.
export function multiAgentTeamMessage(slots: number): Message {
  const text =
    "Multi-Agent team mode is active. It extends the proactive delegation policy: you are the orchestrator (/root) of a team with fixed roles.\n" +
    `${roleCatalogText()}\n` +
    "Protocol:\n" +
    "1. Delegate when the request has independent parts: facts to look up, several entities or sources, artifacts to build or verify. Answer directly, without spawning, when the whole request is one self-contained reply you can write in a single pass from what you already know (greetings, explanations, short writing or rewriting). Delegating such a reply only adds latency.\n" +
    `2. When you delegate, start every independent assignment together in your first tool turn (several agents__spawn_agent calls in one response), up to ${slots} concurrent children. Split by entity or source (one agent per product, city, file or question), not by viewpoint: viewpoint splits overlap. Never give two agents the same scope, and start a worker as soon as the artifact's shape is clear.\n` +
    "3. Make every assignment self-contained: goal, constraints, facts you already know, the expected report format and the /workspace paths to write. Ask for compact reports.\n" +
    "4. Your own branch is planning and integration: do not redo children's work, and use agents__wait_agent rather than polling.\n" +
    "5. Do not spawn a reviewer to check your final answer or research findings. After your final answer the runtime runs a bounded independent review when it is worthwhile and delivers the answer immediately if it passes. Use the reviewer role yourself only to check a worker's artifact while other work continues, or when the user asked for a review of something they supplied.\n" +
    "6. Children cannot spawn agents or deliver to the user; you alone deliver. Put the complete requested text in your final message, or deliver artifacts with the delivery tools (for example send_file or publish_site) and mention them. A worker report, draft or review is not delivery.\n" +
    "7. Write the final answer as a synthesis, not a merge of reports: answer the request directly at the length one expert would use and keep only details that serve it; children's reports are material, not text to copy. Put comparisons in one table (rows = options, columns = what matters, including caveats) and keep prose for the conclusion; prefer short lists over nested bullets. Cite user-facing pages rather than raw API endpoints. Never narrate the process (agents, waits, checks, interruptions) unless asked.\n" +
    "If a <multi_agent_triage> note says an explorer was pre-started, build on it: give other agents distinct scopes and refine its assignment with agents__send_message.";
  return {
    role: "developer",
    content: `<multi_agent_team>${text}</multi_agent_team>`,
  };
}

// Discord shows tool-turn text in one editable progress message: it is cut at
// 1900 characters and later updates (including every subagent's) replace it.
// Models that put the answer there then ended with an addendum ("補足だよ、…").
const FINAL_MESSAGE_CONTRACT =
  "Text you write alongside tool calls is only a transient progress line: it is truncated, later progress (including subagent updates) overwrites it, and it is not kept. The user keeps only your final message, so make it self-contained: lead with the result or deliverable itself, never write it as an addendum to earlier progress text (for example opening with 補足 or 'additionally'), and never assume a draft shown in progress was delivered.";

const def = (
  name: string,
  description: string,
  properties: Json,
  required: string[] = [],
): ToolDef => ({
  type: "function",
  function: {
    name,
    description,
    parameters: { type: "object", properties, required },
  },
});
export function namespaced(tool: ToolDef): ToolDef {
  const name = tool.function.name;
  // Agent tools arrive explicitly qualified. Discord also has send_message;
  // guessing the namespace from a bare name made both schemas collide.
  if (name.startsWith("agents__") && collaborationNames.has(name.slice(8)))
    return tool;
  // Home routing controls the workspace browser. Keep both in the same group
  // so a natural workspace-qualified connect call passes registration checks.
  const group =
    /^(get_bot|set_bot|set_thread|set_user|get_user_context|set_triggers|get_triggers)/.test(
      name,
    )
      ? "settings"
      : /skill/.test(name)
        ? "skills"
        : name === "run_jev" || name === "run_jev_task"
          ? "agent"
          : /site/.test(name)
            ? "sites"
            : /^(bash|write_|edit_file|grep_files|read_file|list_files|send_file|download_|video_|playwright|home_vpn_|gh_|generate_image|edit_image|image_generation_status)/.test(
                  name,
                )
              ? "workspace"
              : /^web/.test(name)
                ? "web"
                : "discord";
  return {
    ...tool,
    function: { ...tool.function, name: `mcp__${group}__${name}` },
  };
}
export function harnessTools(base: ToolDef[], sandbox: boolean): ToolDef[] {
  const fileTools = new Set([
    "bash",
    "read_file",
    "write_file",
    "write_files",
    "edit_file",
    "list_files",
    "grep_files",
    "websearch",
  ]);
  const native = codex as ToolDef[];
  const tools = native.filter((t) => {
    const n = t.function.name;
    if (/^(web_search|WebSearch)$/.test(n))
      return base.some((t) => t.function.name === "websearch");
    return sandbox || /todo|plan|web_fetch|WebFetch/i.test(n);
  });
  tools.push(
    def(
      "tool_search",
      "Search available integration tools by name or description. All returned tool schemas are already callable.",
      {
        query: { type: "string" },
        limit: { type: "integer" },
        max_results: { type: "integer" },
      },
      ["query"],
    ),
  );
  tools.push(requestUserInputTool);
  for (const tool of base)
    if (!fileTools.has(tool.function.name)) tools.push(namespaced(tool));
  return tools;
}
export function normalizeTool(
  name: string,
  a: Json,
): { name: string; args: Json } {
  const wrapper = a.parameters ?? a.params;
  if (wrapper && typeof wrapper === "object" && !Array.isArray(wrapper)) {
    // Some OpenAI-compatible Gemini gateways copy the schema's `parameters`
    // label into the call arguments. Flatten it here so one malformed wrapper
    // does not turn into repeated failed tool rounds.
    const { parameters: _parameters, params: _params, ...outer } = a;
    a = { ...(wrapper as Json), ...outer };
  }
  if (name === "use_tool")
    return normalizeTool(
      String(a.tool_name ?? a.name),
      (a.arguments as Json) ?? {},
    );
  // Keep collaboration identity through validation and dispatch. Stripping it
  // would select Discord's schema/handler for agents__send_message (or vice versa).
  if (name.startsWith("agents__") && collaborationNames.has(name.slice(8)))
    return { name, args: a };
  name = name
    .replace(/^mcp__[^_]+__/, "")
    .replace(/^(discord|workspace|settings|skills|agent|sites|web)__/, "");
  const path = a.path ?? a.file_path ?? a.target_file;
  switch (name) {
    case "bash":
      return {
        name: "bash",
        args: {
          ...a,
          timeout_secs: a.timeout
            ? Math.ceil(Number(a.timeout) / 1000)
            : a.timeout_secs,
        },
      };
    case "read_file":
      return a.target_file
        ? { name: "Read", args: { ...a, file_path: a.target_file } }
        : { name, args: a };
    case "search_replace":
      if (a.old_string === "")
        return { name: "write_file", args: { path, content: a.new_string } };
      return {
        name: "edit_file",
        args: {
          path,
          old_str: a.old_string,
          new_str: a.new_string,
          replace_all: a.replace_all,
        },
      };
    case "shell_command":
    case "Bash":
      return {
        name: "bash",
        args: {
          command: a.command,
          workdir: a.workdir,
          timeout_secs: a.timeout_ms
            ? Math.ceil(Number(a.timeout_ms) / 1000)
            : a.timeout
              ? Math.ceil(Number(a.timeout) / 1000)
              : 120,
        },
      };
    case "Edit":
      return {
        name: "edit_file",
        args: {
          path,
          old_str: a.old_string ?? a.old_str,
          new_str: a.new_string ?? a.new_str,
          replace_all: a.replace_all,
        },
      };
    case "Write":
      return { name: "write_file", args: { path, content: a.content } };
    case "list_dir":
      return {
        name: "list_files",
        args: {
          path: a.path ?? a.directory_path ?? a.target_directory ?? ".",
          recursive: false,
        },
      };
    case "grep":
      return {
        name: "grep_files",
        args: {
          ...a,
          path: a.path ?? ".",
          pattern: a.pattern ?? a.regex,
          case_insensitive: a["-i"] ?? a.case_insensitive,
        },
      };
    case "WebSearch":
    case "web_search":
      return {
        name: "websearch",
        args: { ...a, query: a.query ?? a.search_query },
      };
    case "WebFetch":
      return { name: "web_fetch", args: a };
    case "RunWorkflow":
      return { name: "Workflow", args: a };
    case "Skill":
      return {
        name: "use_skill",
        args: { name: a.skill ?? a.name, status: a.args },
      };
    default:
      return { name, args: a };
  }
}
export async function assemblePrompt(
  runtime: Runtime,
  ctx: Context,
  skills: string,
): Promise<Message[]> {
  const settings = runtime.resolve(ctx.guildId, ctx.userId);
  const read = async (path: string) =>
    readFile(path, "utf8").catch((e) => {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw e;
    });
  const operational = await read(runtime.config.promptFile);
  const persona = settings.context?.persona_override
    ? ""
    : (await read(runtime.config.personaFile)) ||
      "You are Hibana (火花), a helpful Discord assistant. Respond naturally in Japanese unless asked otherwise.";
  const stable = [
    persona,
    operational,
    settings.context?.text || "",
    `Workspace: /workspace. This workspace is isolated to ${ctx.thread ? "this thread" : ctx.guildId ? "this guild" : "this DM"}. Host secrets are unavailable.`,
    skills ? `## Skills\n${skills}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const system = await read(
    join(import.meta.dir, "../prompts/harness/codex.md"),
  );
  const delegation =
    runtime.config.toolsEnabled && runtime.config.subagentEnabled && settings.subagent_enabled;
  const multiAgentMode =
    delegation
      ? multiAgentModeMessage(subagentMode(settings) === "multi")
      : {
          role: "developer" as const,
          // Supersede any Ultra instructions retained in conversation history.
          content: "<multi_agent_mode>Subagents are disabled for this turn. Complete the task yourself without spawning or contacting agents.</multi_agent_mode>",
        };
  return [
    {
      role: "system",
      content: `${system}\n\n# Environment\nCWD: /workspace\nRuntime: Hibana Discord bot; use available function tools. Integration tools are preloaded with mcp__ names.\nBatch independent web searches, fetches, file reads and Jev evaluations in the same tool-call turn to overlap waiting time. The runtime executes approved read tools concurrently, up to six at once. Keep dependent calls in later turns; mutations, shell commands, browser actions and unknown tools are executed sequentially. When Jev action-selection mode is on, prepare independent search/read candidates with parallel=true and explicit depends_on prerequisites. Use asynchronous subagents for independent work under the active delegation policy, and continue useful work before waiting.\n${FINAL_MESSAGE_CONTRACT}\n`,
    },
    ...(multiAgentMode ? [multiAgentMode] : []),
    // Root only: children receive their role through <multi_agent_role>, and
    // forkMessages strips this block so a worker never believes it orchestrates.
    ...(delegation && ctx.depth === 0 && subagentMode(settings) === "multi"
      ? [multiAgentTeamMessage(runtime.config.subagentConcurrency)]
      : []),
    ...(ctx.depth === 0 && runtime.config.toolsEnabled &&
    runtime.config.subagentEnabled &&
    runtime.config.jevApiKey &&
    settings.jev_enabled
      ? [
          {
            role: "developer" as const,
            // The normal delegation mode forbids proactive agent spawning.
            // Allow this bounded evaluator without changing that policy.
            content:
              "Jev evaluation is enabled. You may proactively call mcp__agent__run_jev for bounded classification, evidence checks, or candidate ranking; batch independent questions about concise supplied evidence, including evidence returned by workers. This evaluator supplements the active multi-agent policy: it does not perform the research, implementation or independent review assigned to chat subagents. Jev does not change whether or when to delegate; only the active multi_agent_mode and user instructions govern that choice. It cannot execute tools or spawn agents. Skip trivial conversation, arithmetic, tasks needing new facts or open-ended reasoning, and duplicate judgments already obtained in a Jev action plan. Treat probabilities as fallible evidence; investigate uncertainty yourself. Keep existing permission checks and the selected chat model. Never let Jev authorize actions, expand scope, or choose another model. On evaluator failure, continue the task without claiming Jev verification.",
          },
        ]
      : []),
    {
      role: "user",
      content: `# AGENTS.md instructions\n<INSTRUCTIONS>\n${stable}\n</INSTRUCTIONS>`,
    },
  ];
}
/** Validate all operations before writing, so malformed patches do not half-apply. */
export async function applyPatch(
  sandbox: Sandbox,
  ctx: Context,
  patch: string,
) {
  return sandbox.locked(ctx, async () => {
    const lines = patch.replace(/\r\n/g, "\n").trimEnd().split("\n");
    if (lines.shift() !== "*** Begin Patch" || lines.pop() !== "*** End Patch")
      throw new Error("Invalid patch envelope");
    const changes: { path: string; content: string | null; move?: string }[] =
      [];
    while (lines.length) {
      const header = lines.shift()!;
      const m = /^\*\*\* (Add|Delete|Update) File: (.+)$/.exec(header);
      if (!m) throw new Error(`Invalid patch header: ${header}`);
      const path = m[2]!;
      await sandbox.path(ctx, path);
      if (m[1] === "Delete") {
        await readFile(await sandbox.path(ctx, path));
        changes.push({ path, content: null });
        continue;
      }
      if (m[1] === "Add") {
        const added: string[] = [];
        while (lines.length && !lines[0]!.startsWith("*** ")) {
          const line = lines.shift()!;
          if (!line.startsWith("+")) throw new Error("Added lines require +");
          added.push(line.slice(1));
        }
        if (await Bun.file(await sandbox.path(ctx, path)).exists())
          throw new Error("Add target already exists");
        changes.push({ path, content: added.join("\n") + "\n" });
        continue;
      }
      let move: string | undefined;
      if (lines[0]?.startsWith("*** Move to: ")) {
        move = lines.shift()!.slice(13);
        await sandbox.path(ctx, move);
      }
      let content = await readFile(await sandbox.path(ctx, path), "utf8");
      let cursor = 0;
      while (
        lines.length &&
        !/^\*\*\* (?:Add|Update|Delete) File:/.test(lines[0]!)
      ) {
        if (lines[0] === "*** End of File") {
          lines.shift();
          break;
        }
        if (lines[0]!.startsWith("@@")) lines.shift();
        const old: string[] = [],
          fresh: string[] = [];
        while (
          lines.length &&
          !lines[0]!.startsWith("@@") &&
          !lines[0]!.startsWith("*** ")
        ) {
          const line = lines.shift()!;
          if (![" ", "+", "-"].includes(line[0] ?? ""))
            throw new Error("Invalid hunk line");
          if (line[0] !== "+") old.push(line.slice(1));
          if (line[0] !== "-") fresh.push(line.slice(1));
        }
        const before = old.join("\n"),
          after = fresh.join("\n");
        const index = before ? content.indexOf(before, cursor) : content.length;
        if (index < 0) throw new Error(`Patch context not found in ${path}`);
        content =
          content.slice(0, index) +
          after +
          content.slice(index + before.length);
        cursor = index + after.length;
      }
      changes.push({ path, content, move });
    }
    for (const change of changes) {
      const path = await sandbox.path(ctx, change.path);
      if (change.content === null) await rm(path);
      else {
        const target = change.move
          ? await sandbox.path(ctx, change.move)
          : path;
        await mkdir(dirname(target), { recursive: true });
        await Bun.write(target, change.content);
        if (change.move) await rm(path);
      }
    }
    return { ok: true, files: changes.map((c) => c.move ?? c.path) };
  });
}

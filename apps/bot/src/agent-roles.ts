import { REASONING_EFFORTS } from "@hibana/shared/catalog";
import { MULTI_AGENT_ROLES, type MultiAgentRole } from "@hibana/shared/settings";
import { ADMIN_TOOLS } from "./tools/discord";

// Multi-Agent roles are fixed so the orchestrator chooses a job, not a prompt.
// Each role narrows tools as well as instructions: a model told "read-only"
// can still call write tools, so the runtime enforces the boundary.
// Ids come from shared settings, where per-role model/effort policies live.
export const AGENT_ROLE_IDS = MULTI_AGENT_ROLES;
export type AgentRole = MultiAgentRole;

// Names are normalizeTool() output, so harness aliases (shell_command → bash,
// web_search → websearch, mcp__web__websearch → websearch) share one entry.
const OBSERVE = new Set([
  "websearch", "web_fetch", "web_fetch_exa", "web_search_advanced_exa",
  "read_file", "Read", "list_files", "grep_files", "Grep", "Glob", "view_image",
  // Downloads only land in the isolated workspace so the file can be read.
  "download_attachment", "download_file",
  "read_messages", "get_message", "search_messages", "list_pins",
  "list_channels", "get_channel", "get_guild", "list_active_threads",
  "list_skills", "use_skill", "read_skill_file",
  "tool_search", "ToolSearch", "search_tool", "update_plan", "todo_write", "TodoWrite",
]);
// Children may report, look around and wait, but decomposition stays with the
// orchestrator: grandchildren would compete for the tree's shared slots.
const CHILD_COORDINATION = new Set(["agents__send_message", "agents__list_agents", "agents__wait_agent"]);
const COORDINATION = /^agents__/;
// Anything the user or other Discord members can see, or that changes shared
// settings/accounts, is the orchestrator's delivery responsibility.
const USER_VISIBLE = new Set([
  ...ADMIN_TOOLS,
  "send_file", "send_message", "edit_message", "delete_message", "add_reaction", "remove_reaction",
  "create_thread", "create_thread_without_message",
  "publish_site", "unpublish_site", "extend_site",
  "set_bot_model", "set_thread_history", "set_user_context", "set_triggers", "set_bot_username", "set_bot_avatar",
  "set_skill_enabled", "import_skill", "create_skill", "edit_skill", "delete_skill", "write_skill_file",
  "request_user_input", "UserAskQuestion", "AskUserQuestion", "ask_user_question",
  "gh_login", "gh_logout", "vpn_connect", "vpn_disconnect", "vpn_login_code",
  "home_vpn_connect", "home_vpn_disconnect", "mcp_call_tool",
]);

type RoleSpec = {
  /** Japanese label for Discord notices. */
  label: string;
  /** Upper bound on inherited effort; undefined keeps the parent's effort. */
  effortCap?: (typeof REASONING_EFFORTS)[number];
  allows: (name: string) => boolean;
  instructions: string;
};

export const AGENT_ROLES: Record<AgentRole, RoleSpec> = {
  explorer: {
    label: "調査",
    // Searching and reading rarely needs deep reasoning; a lower rung returns
    // evidence sooner while the orchestrator and workers keep their effort.
    effortCap: "medium",
    allows: (name) => OBSERVE.has(name) || CHILD_COORDINATION.has(name),
    instructions:
      "Role: explorer. Gather the facts, sources and workspace or Discord observations the orchestrator needs for your assignment. Batch independent searches, fetches and reads in the same tool turn. Do not write the user's final answer and do not modify files. Report key findings with source URLs or file paths, exact quotes where precision matters, and open questions. Keep the report dense.",
  },
  worker: {
    label: "作成",
    allows: (name) =>
      COORDINATION.test(name) ? CHILD_COORDINATION.has(name) : !USER_VISIBLE.has(name),
    instructions:
      "Role: worker. Produce the assigned deliverable: files, code, data or images in /workspace, or the complete requested text. You cannot deliver to Discord, publish, change settings or ask the user; the orchestrator delivers. Verify your output where practical (run it, test it, re-read it). Report the complete text deliverable, or every created or modified /workspace path with a short summary, plus the verification you performed and any remaining issues.",
  },
  reviewer: {
    label: "検証",
    allows: (name) =>
      OBSERVE.has(name) || CHILD_COORDINATION.has(name) || name === "bash" || name === "playwright_cli",
    instructions:
      "Role: reviewer. Independently check the specified draft or artifact against the user's request and stated constraints. Inspect files and run tests or commands, but do not modify files or rewrite the deliverable. Report only concrete defects with evidence and a suggested fix, most severe first, or state that you found none.",
  },
};

export function isAgentRole(value: unknown): value is AgentRole {
  return typeof value === "string" && (AGENT_ROLE_IDS as readonly string[]).includes(value);
}

/** A child without a role (Ultra, or spawned before a mode switch) keeps every tool. */
export function roleAllowsTool(role: string | undefined, name: string): boolean {
  return !isAgentRole(role) || AGENT_ROLES[role].allows(name);
}

/** Claude Code's workflow-subagent cannot use SendUserMessage, Agent or
 *  Workflow: it returns data to the script. Here that is every user-visible
 *  Discord/settings action, questions to the user, collaboration and tasks. */
export function workflowAgentAllowsTool(name: string): boolean {
  return !COORDINATION.test(name) && !USER_VISIBLE.has(name) &&
    !["Workflow", "RunWorkflow", "TaskStop"].includes(name);
}

/** Cap an inherited effort by the role; unknown/"default" rungs pass through. */
export function roleEffort(role: AgentRole, inherited: string | null | undefined): string | null | undefined {
  const cap = AGENT_ROLES[role].effortCap;
  const order: readonly string[] = REASONING_EFFORTS;
  if (!cap || !inherited || !order.includes(inherited)) return inherited;
  return order[Math.min(order.indexOf(inherited), order.indexOf(cap))];
}

export function roleCatalogText(): string {
  return AGENT_ROLE_IDS.map((id) => {
    const role = AGENT_ROLES[id];
    return `${id} (${role.label}): ${role.instructions.replace(/^Role: \w+\. /, "")}${role.effortCap ? ` Effort is capped at ${role.effortCap}.` : ""}`;
  }).join("\n");
}

// Runtime pre-delivery review (Multi-Agent). Instructions alone did not make
// the orchestrator run reviewers in production, so the session starts one.
// The review works from evidence already gathered this turn. In production an
// unbounded reviewer re-researched for minutes; past this deadline the
// unreviewed candidate is delivered instead of blocking the answer.
export const FINAL_REVIEW_TIMEOUT_MS = 120000;
export const FINAL_REVIEW_NOTICE = "回答案を検証します。";

export function finalReviewTask(candidate: string): string {
  // Spawn messages are capped at 24k; keep room for the instructions.
  const shown = candidate.length > 18000 ? `${candidate.slice(0, 18000)}\n[truncated]` : candidate;
  return "Final review requested by the runtime before delivery. This is a quick, bounded check: the user is waiting. Check the orchestrator's candidate final answer below against the latest user request in your conversation, the evidence and worker reports already gathered this turn, and any /workspace files it relies on. Work from that evidence; fetch a source again only when a specific claim cannot be checked otherwise, and run tests only for code or files the answer relies on. Do not redo the research or propose extra scope. Look for a missing or only summarized deliverable, claims unsupported or contradicted by the gathered sources, arithmetic or factual errors, broken code or files, and unmet user constraints. Ignore style preferences. The first line of your report must be exactly `VERDICT: PASS` (nothing that should change the answer) or `VERDICT: FAIL`, followed by concrete defects with evidence and fixes, most severe first.\n\nCandidate final answer:\n<<<\n" + shown + "\n>>>";
}

/** PASS/FAIL from the report's first line; anything else is treated as findings. */
export function finalReviewVerdict(report: string): "pass" | "fail" | "unparsed" {
  const match = /^[\s*`#>_-]*VERDICT[\s*`_]*:[\s*`_]*(PASS|FAIL)\b/i.exec(report.slice(0, 200));
  return match ? (match[1]!.toUpperCase() === "PASS" ? "pass" : "fail") : "unparsed";
}

export const FINAL_REVIEW_REVISION =
  "The runtime's independent reviewer checked your candidate final answer; its report is above. The candidate was NOT shown to the user. Fix every concrete defect it reports (re-check sources, or send code or file fixes to the worker with agents__followup_task), then write the complete final answer again in full: not a list of changes and not a supplement to the candidate. If you judge a reported defect wrong, keep that content. Do not mention the review to the user.";

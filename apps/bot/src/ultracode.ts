import { subagentMode } from "@hibana/shared/settings";
import type { Config, Selection } from "./config";
import type { Message } from "./types";

// Claude Code's Ultracode, reproduced from the 2.1.282 CLI and the dynamic
// workflows documentation (https://code.claude.com/docs/en/workflows):
// `/effort ultracode` runs at xhigh reasoning effort and makes workflow
// orchestration a standing opt-in. Hibana keeps the stored effort and applies
// xhigh only while Ultra is resolved on, so leaving Ultra restores the user's
// rung. Models without an xhigh rung use the existing wireEffort clamps
// (Claude Code instead hides ultracode for them).
export const ULTRACODE_EFFORT = "xhigh";

// Claude Code sends the full reminder when Ultracode is entered and a short
// one after this many regular user prompts (TURNS_BETWEEN_MAINTENANCE).
export const ULTRACODE_REMINDER_TURNS = 10;

export const WORKFLOW_KEYWORD_REMINDER =
  'The user included the keyword "ultracode", opting this turn into multi-agent orchestration — use the Workflow tool to fulfill the request.';
export const ULTRACODE_ENTER_FULL =
  "Ultracode is on: optimize for the most exhaustive, correct answer — not the fastest or cheapest. Use the Workflow tool on every substantive task; token cost is not a constraint. See the **Ultracode** section and quality patterns in the workflow authoring reference. Solo only on conversational/trivial turns.";
export const ULTRACODE_ENTER_SPARSE =
  "Ultracode is still on — use the Workflow tool; see the Ultracode section of the workflow authoring reference.";
export const ULTRACODE_EXIT =
  "Ultracode is off — the Workflow tool's standard opt-in rule applies again.";

export function systemReminder(text: string): string {
  return `<system-reminder>\n${text}\n</system-reminder>`;
}

type Settings = { subagent_enabled: boolean; ultra_mode: boolean; multi_agent: boolean };

/** Dynamic workflows need the collaboration surface: Claude Code's
 *  disableWorkflows also turns off the keyword and ultracode. */
export function workflowsEnabled(config: Pick<Config, "toolsEnabled" | "subagentEnabled" | "workflowsEnabled">, settings: Pick<Settings, "subagent_enabled">): boolean {
  return config.toolsEnabled && config.subagentEnabled && config.workflowsEnabled && settings.subagent_enabled;
}

/** Ultra is Ultracode. Multi-Agent also stores ultra_mode=true (it used to
 *  extend the Codex Ultra policy) but keeps its own team protocol instead. */
export function ultracodeActive(config: Pick<Config, "toolsEnabled" | "subagentEnabled" | "workflowsEnabled">, settings: Settings): boolean {
  return workflowsEnabled(config, settings) && subagentMode(settings) === "ultra";
}

export function turnSelection(selection: Selection, active: boolean): Selection {
  return active ? { ...selection, effort: ULTRACODE_EFFORT } : selection;
}

const OPENERS = new Map([["`", "`"], ['"', '"'], ["<", ">"], ["{", "}"], ["[", "]"], ["(", ")"], ["'", "'"]]);
const wordChar = (c: string | undefined) => !!c && /[\p{L}\p{N}_]/u.test(c);

/** Port of Claude Code's keyword matcher: a slash command never matches, and
 *  neither does a mention inside quotes/brackets/tags or a path, flag, file
 *  name or question such as `/ultracode`, `ultracode-x`, `ultracode.js`. */
export function keywordSpans(text: string, keyword: string): { word: string; start: number; end: number }[] {
  if (!new RegExp(keyword, "i").test(text) || text.startsWith("/")) return [];
  const quoted: { start: number; end: number }[] = [];
  let open: string | undefined, from = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (open) {
      if (open === "[" && c === "[") { from = i; continue; }
      if (c !== OPENERS.get(open)) continue;
      if (open === "'" && wordChar(text[i + 1])) continue;
      quoted.push({ start: from, end: i + 1 });
      open = undefined;
    } else if ((c === "<" && i + 1 < text.length && /[a-zA-Z/]/.test(text[i + 1]!)) ||
      (c === "'" && !wordChar(text[i - 1])) || (c !== "<" && c !== "'" && OPENERS.has(c))) {
      open = c;
      from = i;
    }
  }
  const spans: { word: string; start: number; end: number }[] = [];
  for (const match of text.matchAll(new RegExp(`\\b${keyword}\\b`, "gi"))) {
    const start = match.index!, end = start + match[0].length;
    if (quoted.some((q) => start >= q.start && start < q.end)) continue;
    const before = text[start - 1], after = text[end];
    if (before === "/" || before === "\\" || before === "-") continue;
    if (after === "/" || after === "\\" || after === "-" || after === "?") continue;
    if (after === "." && wordChar(text[end + 1])) continue;
    spans.push({ word: match[0], start, end });
  }
  return spans;
}

export function hasUltracodeKeyword(text: string): boolean {
  return keywordSpans(text, "ultracode").length > 0;
}

const reminderKind = (m: Message): "enter" | "exit" | undefined => {
  if (m.role !== "user" || !m.internal) return undefined;
  if (m.content === systemReminder(ULTRACODE_ENTER_FULL) || m.content === systemReminder(ULTRACODE_ENTER_SPARSE))
    return "enter";
  return m.content === systemReminder(ULTRACODE_EXIT) ? "exit" : undefined;
};

/** Claude Code's ultra_effort_enter / ultra_effort_exit attachments, computed
 *  from the conversation before the new prompt. Reminders stay in history, so
 *  the next turn can tell whether the model last heard "on" or "off". */
export function ultracodeReminder(history: readonly Message[], active: boolean): Message | undefined {
  let last: "enter" | "exit" | undefined;
  let prompts = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const kind = reminderKind(history[i]!);
    if (kind) { last = kind; break; }
    if (history[i]!.role === "user" && !history[i]!.internal) prompts++;
  }
  const reminder = (text: string): Message => ({ role: "user", internal: true, content: systemReminder(text) });
  if (active) {
    if (last !== "enter") return reminder(ULTRACODE_ENTER_FULL);
    return prompts >= ULTRACODE_REMINDER_TURNS ? reminder(ULTRACODE_ENTER_SPARSE) : undefined;
  }
  return last === "enter" ? reminder(ULTRACODE_EXIT) : undefined;
}

export function workflowKeywordReminder(): Message {
  return { role: "user", internal: true, content: systemReminder(WORKFLOW_KEYWORD_REMINDER) };
}

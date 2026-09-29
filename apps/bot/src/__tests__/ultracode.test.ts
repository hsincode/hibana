import { expect, test } from "bun:test";
import { loadConfig } from "../config";
import { Runtime } from "../runtime";
import type { Message } from "../types";
import {
  hasUltracodeKeyword,
  keywordSpans,
  systemReminder,
  turnSelection,
  ULTRACODE_ENTER_FULL,
  ULTRACODE_ENTER_SPARSE,
  ULTRACODE_EXIT,
  ultracodeActive,
  ultracodeReminder,
  WORKFLOW_KEYWORD_REMINDER,
  workflowKeywordReminder,
} from "../ultracode";
import { compileWorkflow, WorkflowScriptError } from "../workflow/script";
import { sizeGuidelineText, workflowNotification, workflowToolDescription } from "../workflow/prompts";

test("the ultracode keyword matches Claude Code's rules", () => {
  for (const text of [
    "ultracode: audit every API endpoint",
    "Please ULTRACODE this refactor",
    "ultracodeで全部調べて",
    "これをultracodeで",
    "use ultracode.",
    "(see notes) then ultracode",
  ]) expect(hasUltracodeKeyword(text)).toBe(true);
  for (const text of [
    "/ultracode audit",
    "run `ultracode` in the shell",
    'the word "ultracode" means…',
    "<tag ultracode>",
    "(ultracode)",
    "[ultracode]",
    "{ultracode}",
    "'ultracode'",
    "path/ultracode",
    "ultracode/path",
    "ultracode-shim",
    "pre-ultracode",
    "is ultracode?",
    "ultracode.js",
    "ultracodes are nice",
    "nothing here",
  ]) expect(hasUltracodeKeyword(text)).toBe(false);
  // A contraction apostrophe does not open a quote.
  expect(hasUltracodeKeyword("don't stop: ultracode")).toBe(true);
  expect(keywordSpans("a ultracode b ultracode", "ultracode").map((s) => s.start)).toEqual([2, 14]);
});

const user = (content: string): Message => ({ role: "user", content, turnStart: true });
const reminder = (text: string): Message => ({ role: "user", internal: true, content: systemReminder(text) });

test("Ultracode reminders: full on entry, sparse every 10 prompts, exit when turned off", () => {
  expect(ultracodeReminder([], false)).toBeUndefined();
  expect(ultracodeReminder([user("hi")], true)).toEqual(reminder(ULTRACODE_ENTER_FULL));
  const entered = [user("a"), reminder(ULTRACODE_ENTER_FULL)];
  expect(ultracodeReminder(entered, true)).toBeUndefined();
  const nine = [...entered, ...Array.from({ length: 9 }, (_, i) => user(`p${i}`))];
  expect(ultracodeReminder(nine, true)).toBeUndefined();
  const ten = [...nine, user("p9"), { role: "assistant", content: "ok" } as Message];
  expect(ultracodeReminder(ten, true)).toEqual(reminder(ULTRACODE_ENTER_SPARSE));
  // A sparse reminder restarts the count; internal messages are not prompts.
  expect(ultracodeReminder([...ten, reminder(ULTRACODE_ENTER_SPARSE), user("x"),
    { role: "user", internal: true, content: "Message Type: FINAL_ANSWER" }], true)).toBeUndefined();
  expect(ultracodeReminder([...entered, user("b")], false)).toEqual(reminder(ULTRACODE_EXIT));
  expect(ultracodeReminder([...entered, reminder(ULTRACODE_EXIT), user("c")], false)).toBeUndefined();
  expect(ultracodeReminder([...entered, reminder(ULTRACODE_EXIT)], true)).toEqual(reminder(ULTRACODE_ENTER_FULL));
  // A user quoting the reminder is not the harness saying it.
  expect(ultracodeReminder([user(systemReminder(ULTRACODE_ENTER_FULL))], true)).toEqual(reminder(ULTRACODE_ENTER_FULL));
  expect(workflowKeywordReminder()).toEqual(reminder(WORKFLOW_KEYWORD_REMINDER));
});

test("Ultracode needs dynamic workflows and applies xhigh only to the turn", () => {
  const runtime = new Runtime(loadConfig({ RUNTIME_STATE_PATH: "", ULTRA_MODE: "true", LLM_EFFORT: "low" }));
  const settings = runtime.resolve();
  expect(ultracodeActive(runtime.config, settings)).toBe(true);
  expect(turnSelection(settings.selection, true)).toEqual({ ...settings.selection, effort: "xhigh" });
  expect(settings.selection.effort).toBe("low");
  for (const key of ["toolsEnabled", "subagentEnabled", "workflowsEnabled"] as const) {
    const config = { ...runtime.config, [key]: false };
    expect(ultracodeActive(config, settings)).toBe(false);
  }
  expect(ultracodeActive(runtime.config, { ...settings, subagent_enabled: false })).toBe(false);
  // Multi-Agent stores ultra_mode too but is not Ultracode.
  expect(ultracodeActive(runtime.config, { ...settings, multi_agent: true })).toBe(false);
});

test("workflow config follows Claude Code's defaults and bounds", () => {
  const config = loadConfig({ RUNTIME_STATE_PATH: "" });
  expect(config.workflowsEnabled).toBe(true);
  expect(config.ultracodeKeywordTrigger).toBe(true);
  expect(config.workflowConcurrency).toBeGreaterThanOrEqual(2);
  expect(config.workflowConcurrency).toBeLessThanOrEqual(16);
  expect([config.workflowSizeGuideline, config.workflowSizeGuidelineDefault]).toEqual(["medium", true]);
  expect(loadConfig({ WORKFLOW_MAX_CONCURRENT_AGENTS: "40" }).workflowConcurrency).toBe(40);
  expect(() => loadConfig({ WORKFLOW_MAX_CONCURRENT_AGENTS: "0" })).toThrow();
  expect(() => loadConfig({ WORKFLOW_SIZE_GUIDELINE: "huge" })).toThrow();
  const large = loadConfig({ WORKFLOW_SIZE_GUIDELINE: "large" });
  expect([large.workflowSizeGuideline, large.workflowSizeGuidelineDefault]).toEqual(["large", false]);
});

test("the Workflow description points at the workflow-authoring skill or embeds the reference", () => {
  const pointer = workflowToolDescription({ concurrency: 3, modelOption: true, presets: ["sol"], size: "medium", sizeIsDefault: true, skill: true });
  expect(pointer).toContain("Before writing a script, load the `workflow-authoring` skill — the workflow authoring reference");
  expect(pointer).not.toContain("# Workflow authoring reference");
  expect(pointer.length).toBeLessThan(6000);
  const text = workflowToolDescription({ concurrency: 3, modelOption: true, presets: ["sol", "plus-luna"], size: "medium", sizeIsDefault: true, skill: false });
  expect(text).toContain("# Workflow authoring reference");
  expect(text).toStartWith("Execute a workflow script that orchestrates multiple subagents deterministically.");
  expect(text).toContain("ONLY call this tool when the user has explicitly opted into multi-agent orchestration.");
  expect(text).toContain("**Ultracode.** When a system-reminder confirms ultracode is on, that opt-in is standing");
  expect(text).toContain("capped at 3 per workflow");
  expect(text).toContain("model?: string,");
  expect(text).toContain("(sol, plus-luna)");
  expect(text).toEndWith("This session has the default workflow size guideline: medium — keep workflows under 10 agents. This is a guideline, not a hard limit — follow it unless the user's prompt calls for a different scale.");
  const fixed = workflowToolDescription({ concurrency: 3, modelOption: false, presets: [], size: "unrestricted", sizeIsDefault: false, skill: false });
  expect(fixed).not.toContain("model?: string,");
  expect(fixed).not.toContain("size guideline");
  expect(sizeGuidelineText("small", false)).toContain("A workflow size guideline is configured for this session: small — keep workflows under 5 agents.");
  // Features Hibana does not have are not advertised.
  for (const missing of ["Use /workflows", "in /workflows", "worktree'", "+500k", "journal.jsonl", "permission dialog"]) expect(text).not.toContain(missing);
});

test("task notifications use Claude Code's XML shape", () => {
  const base = {
    taskId: "task_1", runId: "wf_abcdef", name: "a<b", failures: [], args: ["x"],
    agents: { count: 2, done: 1, error: 1, skipped: 0, empty: 0 }, tokens: 10, toolUses: 3, durationMs: 5,
  };
  expect(workflowNotification({ ...base, status: "completed", result: { ok: "<done>" } })).toBe(
    '<task-notification>\n<task-id>task_1</task-id>\n<status>completed</status>\n<summary>Dynamic workflow "a&lt;b" completed</summary>\n<result>{"ok":"&lt;done&gt;"}</result>\n<usage><agent_count>2</agent_count><agents_done>1</agents_done><agents_error>1</agents_error><agents_skipped>0</agents_skipped><agents_empty_result>0</agents_empty_result><subagent_tokens>10</subagent_tokens><tool_uses>3</tool_uses><duration_ms>5</duration_ms></usage>\n</task-notification>');
  const failed = workflowNotification({ ...base, status: "failed", error: "boom", scriptPath: "/workspace/.hibana/workflows/wf_abcdef.js", failures: ["parallel[1] failed: x"] });
  expect(failed).toContain('<summary>Dynamic workflow "a&lt;b" failed: boom</summary>');
  expect(failed).toContain(`<recovery>To resume after editing the script, call: Workflow({scriptPath: '/workspace/.hibana/workflows/wf_abcdef.js', resumeFromRunId: 'wf_abcdef', args: ["x"]})</recovery>`);
  expect(failed).toContain("<failures>parallel[1] failed: x</failures>");
  const long = workflowNotification({ ...base, status: "completed", result: "y".repeat(9000), resultFile: "/workspace/r.json" });
  expect(long).toContain("... (truncated 1002 chars, full result in /workspace/r.json)</result>");
  expect(workflowNotification({ ...base, status: "killed" })).toContain('was stopped</summary>');
});

test("workflow scripts need a pure-literal meta block and no modules", () => {
  const ok = compileWorkflow(`// header comment
export const meta = {
  name: 'review-changes', // trailing comment
  description: "Review \\"changed\\" files",
  whenToUse: \`manual\`,
  phases: [{ title: 'Review', detail: 'per file' }, { title: 'Verify', model: 'sol', }],
};
phase('Review')
return 1`);
  expect(ok.meta).toEqual({
    name: "review-changes", description: 'Review "changed" files', whenToUse: "manual",
    phases: [{ title: "Review", detail: "per file", model: undefined }, { title: "Verify", detail: undefined, model: "sol" }],
  });
  // Meta lines are blanked, not removed, so error lines match the script.
  expect(ok.body.split("\n").length).toBe(ok.source.split("\n").length);
  expect(ok.body.split("\n")[7]).toBe("phase('Review')");
  for (const [script, message] of [
    ["phase('x')\nexport const meta = { name: 'a', description: 'b' }", "must begin with `export const meta"],
    ["export const meta = { name: NAME, description: 'b' }", "`NAME` is not a literal value"],
    ["export const meta = { name: 'a', description: make() }", "`make` is not a literal value"],
    ["export const meta = { ...base, name: 'a', description: 'b' }", "spreads are not allowed"],
    ["export const meta = { name: `a${x}`, description: 'b' }", "template interpolation"],
    ["export const meta = { name, description: 'b' }", "shorthand properties are variables"],
    ["export const meta = { [k]: 'a', description: 'b' }", "computed keys"],
    ["export const meta = { name: 'a' }", "meta.description must be a non-empty string"],
    ["export const meta = { name: 'a', description: 'b', phases: [{}] }", "meta.phases[0].title"],
    ["export const meta = { name: 'a', description: 'b' }\nconst m = await import('fs')", "cannot load modules"],
    ["export const meta = { name: 'a', description: 'b' }\nimport fs from 'fs'", "cannot load modules"],
    ["export const meta = { name: 'a', description: 'b' }\nexport const x = 1", "cannot load modules"],
  ] as const) expect(() => compileWorkflow(script)).toThrow(message);
  // Module words inside strings and comments are data.
  expect(() => compileWorkflow("export const meta = { name: 'a', description: 'b' }\n// import('x')\nawait agent('import(\"y\") the export list')")).not.toThrow();
  expect(() => compileWorkflow("")).toThrow(WorkflowScriptError);
  // __proto__ stays an own data property instead of changing the prototype.
  const proto = compileWorkflow("export const meta = { name: 'a', description: 'b', __proto__: { polluted: true } }");
  expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  expect(Object.getPrototypeOf(proto.meta)).toBe(Object.prototype);
});

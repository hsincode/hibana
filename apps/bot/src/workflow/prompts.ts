// Model-facing text for dynamic workflows. Everything here follows Claude Code
// 2.1.282 (the Workflow tool description, its "workflow authoring reference",
// the workflow-subagent system prompts and the <task-notification> body).
// Only facts that differ in Hibana are rewritten: there is no /workflows UI,
// permission dialog, git worktree, "+500k" token directive or transcript
// journal, delivery is Discord, and saved workflows live in the workspace.

export const WORKFLOW_TOOL = "Workflow";
export const TASK_STOP_TOOL = "TaskStop";
export const STRUCTURED_OUTPUT_TOOL = "StructuredOutput";
/** Runaway-loop backstop per run (Claude Code: 1000). */
export const MAX_WORKFLOW_AGENTS = 1000;
/** Items accepted by one parallel()/pipeline() call (Claude Code: 4096). */
export const MAX_WORKFLOW_ITEMS = 4096;
/** StructuredOutput validation attempts before agent() fails (Claude Code: 5). */
export const STRUCTURED_OUTPUT_ATTEMPTS = 5;
/** Notification result excerpt (Claude Code cuts at 8000 characters). */
export const RESULT_EXCERPT = 8000;
/** Nested workflow() group marker, as in Claude Code's progress view. */
export const NESTED_MARK = "▸";
/** Run scripts are persisted here so the model can edit and relaunch them. */
export const RUN_SCRIPT_DIR = ".hibana/workflows";
/** Project workflows, like Claude Code's `.claude/workflows/<name>.js`. */
export const SAVED_WORKFLOW_DIR = ".claude/workflows";

export const SIZE_GUIDELINES = ["unrestricted", "small", "medium", "large"] as const;
export type SizeGuideline = (typeof SIZE_GUIDELINES)[number];
const SIZE_AGENTS: Record<Exclude<SizeGuideline, "unrestricted">, number> = { small: 5, medium: 10, large: 50 };

export function sizeGuidelineAgents(size: SizeGuideline): number | undefined {
  return size === "unrestricted" ? undefined : SIZE_AGENTS[size];
}

/** Appended to the tool description like Claude Code's session guideline.
 *  Its default wording also points at /config, which Hibana does not have. */
export function sizeGuidelineText(size: SizeGuideline, isDefault: boolean): string {
  if (size === "unrestricted") return "";
  const lead = isDefault
    ? "This session has the default workflow size guideline:"
    : "A workflow size guideline is configured for this session:";
  return `\n${lead} ${size} — keep workflows under ${SIZE_AGENTS[size]} agents. This is a guideline, not a hard limit — follow it unless the user's prompt calls for a different scale.`;
}

const CORE = `Execute a workflow script that orchestrates multiple subagents deterministically. Workflows run in the background — this tool returns immediately with a task ID, and a <task-notification> arrives when the workflow completes. Live progress is shown in a Discord status message.

ONLY call this tool when the user has explicitly opted into multi-agent orchestration. Workflows can spawn dozens of agents and consume a large amount of tokens; the user must request that scale, not have it inferred. Explicit opt-in means one of:
- The user included the keyword "ultracode" in their prompt (you'll see a system-reminder confirming it).
- Ultracode is on for the session (a system-reminder confirms it) — see **Ultracode** in the workflow authoring reference.
- The user directly asked you to run a workflow or use multi-agent orchestration in their own words ("use a workflow", "run a workflow", "fan out agents", "orchestrate this with subagents"). The ask must be in the user's words — a task that would merely benefit from a workflow does not count.
- The user invoked a skill or slash command whose instructions tell you to call Workflow.
- The user asked you to run a specific named or saved workflow.

For any other task — even one that would clearly benefit from parallelism — do NOT call this tool. Use the agents__spawn_agent tool (if available) for individual subagents, or briefly describe what a multi-agent workflow could do and how much it would roughly cost, and ask the user whether to run it. Mention they can ask for one with "use a workflow" in a future message to skip the ask.

Every script must begin with \`export const meta = {...}\`: a PURE LITERAL (no variables, calls or interpolation) giving the workflow's \`name\`, a one-line \`description\` (shown in the Discord status message) and optionally \`phases\` — one \`{ title, detail? }\` per phase() call, titles matched exactly. Pass the script inline via \`script\` — do not Write it to a file first, and do not also set the tool's \`name\` input (that selects a saved workflow); it is plain JavaScript, not TypeScript.

The canonical multi-stage pattern — pipeline by default, each dimension verifies as soon as its review completes:
  export const meta = {
    name: 'review-changes',
    description: 'Review changed files across dimensions, verify each finding',
    phases: [{ title: 'Review' }, { title: 'Verify' }],
  }
  const DIMENSIONS = [{key: 'bugs', prompt: '...'}, {key: 'perf', prompt: '...'}]
  const results = await pipeline(
    DIMENSIONS,
    d => agent(d.prompt, {label: \`review:\${d.key}\`, phase: 'Review', schema: FINDINGS_SCHEMA}),
    review => parallel(review.findings.map(f => () =>
      agent(\`Adversarially verify: \${f.title}\`, {label: \`verify:\${f.file}\`, phase: 'Verify', schema: VERDICT_SCHEMA})
        .then(v => ({...f, verdict: v}))
    ))
  )
  const confirmed = results.flat().filter(Boolean).filter(f => f.verdict?.isReal)
  return { confirmed }
  // Dimension 'bugs' findings verify while dimension 'perf' is still reviewing. No wasted wall-clock.`;

export type ReferenceOptions = {
  /** Concurrent agent() calls per workflow. */
  concurrency: number;
  /** False when the subagent model policy is same/fixed: opts.model is then
   *  ignored, like Claude Code's CLAUDE_CODE_SUBAGENT_MODEL_FORCE. */
  modelOption: boolean;
  presets: readonly string[];
};

function reference(o: ReferenceOptions): string {
  const model = o.modelOption;
  return `# Workflow authoring reference

A workflow structures work across many agents — to be comprehensive (decompose and cover in parallel), to be confident (independent perspectives and adversarial checks before committing), or to take on scale one context can't hold (migrations, audits, broad sweeps). The script is where you encode that structure: what fans out, what verifies, what synthesizes.

When you do call it, the right move is often **hybrid**: scout inline first (list the files, find the channels, scope the diff) to discover the work-list, then call Workflow to pipeline over it. You don't need to know the shape before the *task* — only before the *orchestration step*.

Common single-phase workflows you can chain across turns:
- **Understand** — parallel readers over relevant subsystems → structured map
- **Design** — judge panel of N independent approaches → scored synthesis
- **Review** — dimensions → find → adversarially verify (the review-changes example)
- **Research** — multi-modal sweep → deep-read → synthesize
- **Migrate** — discover sites → transform each (disjoint files per agent) → verify

For larger work, run several in sequence — read each result before deciding the next phase. You stay in the loop; each workflow is one well-scoped fan-out.

**Ultracode.** When a system-reminder confirms ultracode is on, that opt-in is standing: author and run a workflow for every substantive task by default. The goal is the most exhaustive, correct answer you can produce — token cost is not a constraint. For multi-phase work (understand → design → implement → review), that often means several workflows in sequence — one per phase — so you stay in the loop between them. The quality patterns below (adversarial verify, multi-modal sweep, completeness critic, loop-until-dry) are the tools; pick what fits the task. Lean toward orchestrating with workflows and adversarially verifying your findings — unless the work is trivial or already verified. Solo only on conversational turns or trivial mechanical edits. When a reminder says ultracode is off, revert to the opt-in rule in the Workflow tool description.

Pass the script inline via \`script\` — do not Write it to a file first. Every invocation automatically persists its script to a file under /workspace/${RUN_SCRIPT_DIR}/ and returns the path in the tool result. To iterate on a workflow, edit that file and re-invoke Workflow with \`{scriptPath: "<path>"}\` instead of resending the full script. A saved workflow is a script at /workspace/${SAVED_WORKFLOW_DIR}/<name>.js; run it with \`{name: "<name>"}\`.

Every script must begin with \`export const meta = {...}\`:
  export const meta = {
    name: 'find-flaky-tests',
    description: 'Find flaky tests and propose fixes',   // one-line, shown in the Discord status message
    phases: [                                            // one entry per phase() call
      { title: 'Scan', detail: 'grep test logs for retries' },
      { title: 'Fix', detail: 'one agent per flaky test' },
    ],
  }
  // script body starts here — use agent()/parallel()/pipeline()/phase()/log()
  phase('Scan')
  const flaky = await agent('grep CI logs for retry markers', {schema: FLAKY_SCHEMA})
  ...

The \`meta\` object must be a PURE LITERAL — no variables, function calls, spreads, or template interpolation. Required fields: \`name\`, \`description\`. Optional: \`whenToUse\`, \`phases\`. Use the SAME phase titles in meta.phases as in phase() calls — titles are matched exactly; a phase() call with no matching meta entry just gets its own progress group.${model ? " Add `model` to a phase entry when that phase uses a specific model override." : ""}

Script body hooks:
- agent(prompt: string, opts?: {label?: string, phase?: string, schema?: object,${model ? " model?: string," : ""} effort?: string, agentType?: string}): Promise<any> — spawn a subagent. Without schema, returns its final text as a string. With schema (a JSON Schema), the subagent is forced to call a ${STRUCTURED_OUTPUT_TOOL} tool and agent() returns the validated object — no parsing needed. Returns null if the subagent is stopped mid-run or dies on a terminal API error after retries (filter with .filter(Boolean)). opts.label overrides the display label. opts.phase explicitly assigns this agent to a progress group (use this inside pipeline()/parallel() stages to avoid races on the global phase() state — same phase string → same group box).${model ? ` opts.model overrides the model for this agent call with a preset id (${o.presets.join(", ") || "none available"}). Default to omitting it — the agent inherits the main-loop model (the resolved session model), which is almost always correct. Only set it when you're highly confident a different tier fits the task; when unsure, omit.` : ""} opts.effort overrides the reasoning effort for this agent call ('low' | 'medium' | 'high' | 'xhigh' | 'max') — omit to inherit the session effort; use 'low' for cheap mechanical stages and higher tiers only for the hardest verify/judge stages. The server's subagent model and effort policies still apply. There is no worktree isolation: every agent shares /workspace, so agents that write files in parallel must write disjoint paths. opts.agentType selects a fixed role instead of the default workflow subagent — 'explorer' (read-only research), 'worker' (builds files and text) or 'reviewer' (checks and runs tests without modifying), with that role's tool limits; 'general-purpose' is the default. Composes with schema (the role's instructions get a ${STRUCTURED_OUTPUT_TOOL} instruction appended).
- pipeline(items, stage1, stage2, ...): Promise<any[]> — run each item through all stages independently, NO barrier between stages. Item A can be in stage 3 while item B is still in stage 1. This is the DEFAULT for multi-stage work. Wall-clock = slowest single-item chain, not sum-of-slowest-per-stage. Every stage callback receives (prevResult, originalItem, index) — use originalItem/index in later stages to label work without threading context through stage 1's return value. A stage that throws drops that item to \`null\` and skips its remaining stages.
- parallel(thunks: Array<() => Promise<any>>): Promise<any[]> — run tasks concurrently. This is a BARRIER: awaits all thunks before returning. A thunk that throws (or whose agent errors) resolves to \`null\` in the result array — the call itself never rejects, so \`.filter(Boolean)\` before using the results. Use ONLY when you genuinely need all results together.
- log(message: string): void — emit a progress message to the user (shown as a narrator line in the Discord status message)
- phase(title: string): void — start a new phase; subsequent agent() calls are grouped under this title in the progress display
- args: any — the value passed as Workflow's \`args\` input, verbatim (undefined if not provided). Pass arrays/objects as actual JSON values in the tool call, NOT as a JSON-encoded string — \`args: ["a.ts", "b.ts"]\`, not \`args: "[\\"a.ts\\", ...]"\` (a stringified list reaches the script as one string, so \`args.filter\`/\`args.map\` throw). Use this to parameterize named workflows — e.g. pass a research question, target path, or config object directly instead of via a side-channel file.
- budget: {total: number|null, spent(): number, remaining(): number} — Hibana has no per-turn token target, so \`budget.total\` is always null and \`budget.remaining()\` returns \`Infinity\`. \`budget.spent()\` returns output tokens spent this turn across the main loop and all workflows — the pool is shared, not per-workflow. Bound loops with a count, never with budget.remaining().
- workflow(nameOrRef: string | {scriptPath: string}, args?: any): Promise<any> — run another workflow inline as a sub-step and return whatever it returns. Pass a name to invoke a saved workflow (same lookup as {name: "..."}), or {scriptPath} to run a script file you wrote earlier. The child shares this run's concurrency cap, agent counter, abort signal, and token budget — its agents appear under a "${NESTED_MARK} name" group in the Discord status message and its tokens count toward budget.spent(). The args param becomes the child's \`args\` global. Nesting is one level only: workflow() inside a child throws. Throws on unknown name / unreadable scriptPath / child syntax error; catch to handle gracefully.

Subagents are told their final text IS the return value (not a human-facing message), so they return raw data. For structured output, use the schema option — validation happens at the tool-call layer so the model retries on mismatch.
Schemas need {type: 'object', properties: {...}} at root and required ⊆ properties; unsatisfiable ones throw at agent().

Workflow agents get the same tools as other subagents, except agent collaboration, Workflow/TaskStop, questions to the user and user-visible Discord actions (sending, reactions, publishing, settings, sign-ins). They cannot deliver to the user: they return data, and you deliver the result.

Subagents get the same AGENTS.md instructions injected at start that you did — don't tell them to re-read those or paste their rules into the prompt; name the specific rule a stage needs, if any. They do not see this conversation, so put every fact a stage needs in its prompt.

Scripts are plain JavaScript, NOT TypeScript — type annotations (\`: string[]\`), interfaces, and generics fail to parse. The script body runs in an async context — use await directly. Standard JS built-ins (JSON, Math, Array, etc.) are available — EXCEPT \`Date.now()\`/\`Math.random()\`/argless \`new Date()\`, which throw (they would break resume); pass timestamps in via \`args\`, stamp results after the workflow returns, and for randomness vary the agent prompt/label by index. No filesystem, network or Node.js API access.

DEFAULT TO pipeline(). Only reach for a barrier (parallel between stages) when you genuinely need ALL prior-stage results together.

A barrier is correct ONLY when stage N needs cross-item context from all of stage N-1:
- Dedup/merge across the full result set before expensive downstream work
- Early-exit if the total count is zero ("0 bugs found → skip verification entirely")
- Stage N's prompt references "the other findings" for comparison

A barrier is NOT justified by:
- "I need to flatten/map/filter first" — do it inside a pipeline stage: pipeline(items, stageA, r => transform([r]).flat(), stageB)
- "The stages are conceptually separate" — that's what pipeline() models. Separate stages ≠ synchronized stages.
- "It's cleaner code" — barrier latency is real. If 5 finders run and the slowest takes 3× the fastest, a barrier wastes 2/3 of the fast finders' idle time.

Smell test: if you wrote
  const a = await parallel(...)
  const b = transform(a)        // flatten, map, filter — no cross-item dependency
  const c = await parallel(b.map(...))
that middle transform doesn't need the barrier. Rewrite as a pipeline with the transform inside a stage. When in doubt: pipeline.

Concurrent agent() calls are capped at ${o.concurrency} per workflow — excess calls queue and run as slots free up. You can still pass 100 items to parallel()/pipeline() and they all complete; only ${o.concurrency} run at any moment. Total agent count across a workflow's lifetime is capped at ${MAX_WORKFLOW_AGENTS} — a runaway-loop backstop set far above any real workflow. A single parallel()/pipeline() call accepts at most ${MAX_WORKFLOW_ITEMS} items; passing more is an explicit error, not a silent truncation.

When a barrier IS correct — dedup across all findings before expensive verification:
  const all = await parallel(DIMENSIONS.map(d => () => agent(d.prompt, {schema: FINDINGS_SCHEMA})))
  const deduped = dedupeByFileAndLine(all.filter(Boolean).flatMap(r => r.findings))  // <-- genuinely needs ALL at once
  const verified = await parallel(deduped.map(f => () => agent(verifyPrompt(f), {schema: VERDICT_SCHEMA})))

Loop-until-count pattern — accumulate to a target:
  const bugs = []
  while (bugs.length < 10) {
    const result = await agent("Find bugs in this codebase.", {schema: BUGS_SCHEMA})
    bugs.push(...result.bugs)
    log(\`\${bugs.length}/10 found\`)
  }

Composing patterns — exhaustive review (find → dedup vs seen → diverse-lens panel → loop-until-dry):
  const seen = new Set(), confirmed = []
  let dry = 0
  while (dry < 2) {                                              // loop-until-dry
    const found = (await parallel(FINDERS.map(f => () =>          // barrier: collect all finders this round
      agent(f.prompt, {phase: 'Find', schema: BUGS})))).filter(Boolean).flatMap(r => r.bugs)
    const fresh = found.filter(b => !seen.has(key(b)))           // dedup vs ALL seen — plain code, not an agent
    if (!fresh.length) { dry++; continue }
    dry = 0; fresh.forEach(b => seen.add(key(b)))
    const judged = await parallel(fresh.map(b => () =>           // every fresh bug judged concurrently...
      parallel(['correctness','security','repro'].map(lens => () =>   // ...each by 3 distinct lenses
        agent(\`Judge "\${b.desc}" via the \${lens} lens — real?\`, {phase: 'Verify', schema: VERDICT})))
        .then(vs => ({ b, real: vs.filter(Boolean).filter(v => v.real).length >= 2 }))))
    confirmed.push(...judged.filter(v => v.real).map(v => v.b))
  }
  return confirmed
  // dedup vs \`seen\`, NOT \`confirmed\` — else judge-rejected findings reappear every round and it never converges.

Quality patterns — common shapes; pick by task and compose freely:
- Adversarial verify: spawn N independent skeptics per finding, each prompted to REFUTE. Kill if ≥majority refute. Prevents plausible-but-wrong findings from surviving.
    const votes = await parallel(Array.from({length: 3}, () => () =>
      agent(\`Try to refute: \${claim}. Default to refuted=true if uncertain.\`, {schema: VERDICT})))
    const survives = votes.filter(Boolean).filter(v => !v.refuted).length >= 2
- Perspective-diverse verify: when a finding can fail in more than one way, give each verifier a distinct lens (correctness, security, perf, does-it-reproduce) instead of N identical refuters — diversity catches failure modes redundancy can't.
- Judge panel: generate N independent attempts from different angles (e.g. MVP-first, risk-first, user-first), score with parallel judges, synthesize from the winner while grafting the best ideas from runners-up. Beats one-attempt-iterated when the solution space is wide.
- Loop-until-dry: for unknown-size discovery (bugs, issues, edge cases), keep spawning finders until K consecutive rounds return nothing new. Simple counters (while count < N) miss the tail.
- Multi-modal sweep: parallel agents each searching a different way (by-container, by-content, by-entity, by-time). Each is blind to what the others surface; useful when one search angle won't find everything.
- Completeness critic: a final agent that asks "what's missing — modality not run, claim unverified, source unread?" What it finds becomes the next round of work.
- No silent caps: if a workflow bounds coverage (top-N, no-retry, sampling), \`log()\` what was dropped — silent truncation reads as "covered everything" when it didn't.

Scale to what the user asked for. "find any bugs" → a few finders, single-vote verify. "thoroughly audit this" or "be comprehensive" → larger finder pool, 3–5 vote adversarial pass, synthesis stage. When unsure, lean toward thoroughness for research/review/audit requests and toward brevity for quick checks.

These patterns aren't exhaustive — compose novel harnesses when the task calls for it (tournament brackets, self-repair loops, staged escalation, whatever fits).

Use this tool for multi-step orchestration where control flow should be deterministic (loops, conditionals, fan-out) rather than model-driven.

## Resume

The tool result includes a runId. To resume after a stop (${TASK_STOP_TOOL}), failure, or script edit, relaunch with Workflow({scriptPath, resumeFromRunId}) — the longest unchanged prefix of agent() calls returns cached results instantly; the first edited/new call and everything after it runs live. Same script + same args → 100% cache hit. Completed agents stay cached for 2 hours for the same user in the same channel, including later messages. Do not assume cached results are non-empty. Date.now()/Math.random()/new Date() are unavailable in scripts (they would break this) — stamp results after the workflow returns, or pass timestamps via args.`;
}

/** Claude Code's bundled skill that carries the authoring reference. */
export const WORKFLOW_AUTHORING_SKILL = "workflow-authoring";
export const WORKFLOW_AUTHORING_DESCRIPTION =
  "Reference for writing a Workflow tool script (script API and gotchas, resume, quality patterns, worked examples). Load before authoring a script for a workflow the user already opted into; it does not itself authorize running one.";
const POINTER = `Before writing a script, load the \`${WORKFLOW_AUTHORING_SKILL}\` skill — the workflow authoring reference: script API and gotchas, resume, the **Ultracode** section, quality patterns, worked examples.`;

export const workflowAuthoringReference = reference;

/** Like Claude Code: with a skill tool the description only points at the
 *  workflow-authoring skill (loaded on demand, and automatically on keyword
 *  and Ultracode turns); without one it embeds the whole reference. */
export function workflowToolDescription(o: ReferenceOptions & { size: SizeGuideline; sizeIsDefault: boolean; skill: boolean }): string {
  return `${CORE}\n\n${o.skill ? POINTER : reference(o)}${sizeGuidelineText(o.size, o.sizeIsDefault)}`;
}

/** The skill text Claude Code inserts on a keyword or full Ultracode turn. */
export function workflowAuthoringAutoload(referenceText: string): string {
  return `<command-name>${WORKFLOW_AUTHORING_SKILL}</command-name>\n<command-message>The ${WORKFLOW_AUTHORING_SKILL} skill is loaded.</command-message>\n\n${referenceText}`;
}

// Input schema of Claude Code's Workflow tool (its zod descriptions). `args`
// is any JSON value there; the anyOf spelling is the one run_jev_task already
// sends to every catalog provider.
export const WORKFLOW_PARAMETERS = {
  type: "object",
  properties: {
    script: {
      type: "string",
      description: "Self-contained workflow script. Must begin with `export const meta = { name, description, phases }` (pure literal, no computed values) followed by the script body using agent()/parallel()/pipeline()/phase().",
    },
    name: {
      type: "string",
      description: `Name of a saved workflow (/workspace/${SAVED_WORKFLOW_DIR}/<name>.js). Resolves to a self-contained script.`,
    },
    description: { type: "string", description: "Ignored — set the workflow description in the script's `meta` block." },
    title: { type: "string", description: "Ignored — set the workflow title in the script's `meta` block." },
    args: {
      anyOf: [{ type: "object" }, { type: "array", items: {} }, { type: "string" }, { type: "number" }, { type: "boolean" }],
      description: "Optional input value exposed to the script as the global `args`, verbatim. Pass arrays/objects as actual JSON values, NOT as a JSON-encoded string — a stringified list breaks `args.filter`/`args.map` in the script. Use for parameterized named workflows (e.g. a research question).",
    },
    scriptPath: {
      type: "string",
      description: `Path to a workflow script file in /workspace. Every Workflow invocation persists its script under /workspace/${RUN_SCRIPT_DIR}/ and returns the path in the tool result. To iterate, edit that file and re-invoke Workflow with the same \`scriptPath\` instead of re-sending the full script. Takes precedence over \`script\` and \`name\`.`,
    },
    resumeFromRunId: {
      type: "string",
      pattern: "^wf_[a-z0-9-]{6,}$",
      description: `Run ID of a prior Workflow invocation to resume from. Completed agent() calls with unchanged (prompt, opts) return their cached results instantly; only edited or new calls re-run. Same user and channel only, for 2 hours. Stop the prior run first (${TASK_STOP_TOOL}) before resuming.`,
    },
  },
};

export const TASK_STOP_PARAMETERS = {
  type: "object",
  properties: { task_id: { type: "string", description: "The ID of the background task to stop" } },
  required: ["task_id"],
};

export const TASK_STOP_DESCRIPTION = `
- Stops a running background task by its ID
- Takes a task_id parameter identifying the task to stop
- Returns a success or failure status
- Use this tool when you need to terminate a long-running task
`;

// Claude Code's workflow-subagent system prompts. The last rule of the text
// variant named SendUserMessage; workflow agents have no delivery tools here.
export const WORKFLOW_SUBAGENT_PROMPT = `You are a subagent spawned by a workflow orchestration script. Use the tools available to complete the task.
Your final text response is returned verbatim as a string to the calling script — it is your return value, not a message to a human.
- Output the literal result (data, JSON, text). Do NOT output confirmations like "Done." or "Sent."
- If asked for JSON, return ONLY the raw JSON — no code fences, no prose, no markdown.
- Do NOT try to deliver your answer to the user; you have no Discord delivery tools. Put your answer in your final text response.
- Be concise. The script will parse your output.`;
export const WORKFLOW_SUBAGENT_SCHEMA_PROMPT = `You are a subagent spawned by a workflow orchestration script. Use the tools available to complete the task.
Return your final answer by calling the ${STRUCTURED_OUTPUT_TOOL} tool exactly once; the script reads only that call. The tool's input schema defines the required shape.
- Do your work (Read files, run commands, etc.), then call ${STRUCTURED_OUTPUT_TOOL} with your answer.
- Do NOT put your answer in a text response. The script reads ONLY the ${STRUCTURED_OUTPUT_TOOL} tool call.
- If the schema validation fails, read the error and call ${STRUCTURED_OUTPUT_TOOL} again with a corrected shape.
- After calling ${STRUCTURED_OUTPUT_TOOL} successfully, end your turn. No acknowledgment needed.`;
/** Appended to a role's instructions when opts.agentType picks a role. */
export const WORKFLOW_ROLE_NOTE = `
NOTE: You are running inside a workflow script. Your final text response is returned verbatim as a string to the calling script — it is your return value, not a message to a human. Output the literal result; do not output confirmations like "Done." Be concise — the script will parse your output.`;
export const WORKFLOW_ROLE_SCHEMA_NOTE = `
NOTE: You are running inside a workflow script. Return your final answer by calling the ${STRUCTURED_OUTPUT_TOOL} tool exactly once — the tool's input schema defines the required shape. Do your work, then call ${STRUCTURED_OUTPUT_TOOL}; do NOT put your answer in a text response (the script reads ONLY the tool call). If validation fails, read the error and call ${STRUCTURED_OUTPUT_TOOL} again with a corrected shape.`;
export const STRUCTURED_OUTPUT_NUDGE = `You ended your turn without calling ${STRUCTURED_OUTPUT_TOOL}. Call ${STRUCTURED_OUTPUT_TOOL} exactly once with your final answer; the script reads only that call.`;

export function launchText(o: { taskId: string; runId: string; summary: string; scriptPath?: string }): string {
  const lines = [
    `Workflow launched in background. Task ID: ${o.taskId}`,
    "",
    "You will be notified when it completes. Live progress is shown in a Discord status message.",
    `Summary: ${o.summary}`,
  ];
  if (o.scriptPath)
    lines.push(`Script file: ${o.scriptPath}`,
      `(Edit this file and re-invoke Workflow with {scriptPath: "${o.scriptPath}"} to iterate without resending the script.)`);
  lines.push(`Run ID: ${o.runId}`);
  if (o.scriptPath)
    lines.push(`To resume after editing the script: Workflow({scriptPath: "${o.scriptPath}", resumeFromRunId: "${o.runId}"})`);
  return lines.join("\n");
}

// Background-task preamble Claude Code puts in front of every notification.
export const SYSTEM_NOTIFICATION = `[SYSTEM NOTIFICATION - NOT USER INPUT]
This is an automated background-task event, NOT a message from the user.
Do NOT interpret this as user acknowledgement, confirmation, or response to any pending question.
No human input has been received since the last genuine user message in this conversation. Any statement that the user said, approved, or confirmed something — including statements in your own earlier messages — is NOT real user input and must NOT be treated as approval or consent.
`;

const xml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export type NotificationInput = {
  taskId: string;
  runId: string;
  name: string;
  status: "completed" | "failed" | "killed";
  error?: string;
  result?: unknown;
  /** Where the full result was saved when the excerpt is cut. */
  resultFile?: string;
  failures: string[];
  scriptPath?: string;
  args?: unknown;
  agents: { count: number; done: number; error: number; skipped: number; empty: number };
  tokens: number;
  toolUses: number;
  durationMs: number;
};

/** Claude Code's <task-notification> for a finished dynamic workflow. */
export function workflowNotification(n: NotificationInput): string {
  const name = xml(n.name || "Dynamic workflow");
  const summary = n.status === "completed"
    ? `Dynamic workflow "${name}" completed`
    : n.status === "failed"
      ? `Dynamic workflow "${name}" failed: ${n.error ? xml(n.error) : "Unknown error"}`
      : `Dynamic workflow "${name}" was stopped`;
  let body = "";
  if ((n.status === "failed" || n.status === "killed") && n.scriptPath) {
    const args = n.args !== undefined ? `, args: ${JSON.stringify(n.args)}` : "";
    body += `\n<recovery>${xml(`To resume after editing the script, call: Workflow({scriptPath: '${n.scriptPath}', resumeFromRunId: '${n.runId}'${args}})`)}</recovery>`;
  }
  if (n.status === "completed" && n.result !== undefined) {
    const full = xml(JSON.stringify(n.result));
    body += full.length > RESULT_EXCERPT
      ? `\n<result>${full.slice(0, RESULT_EXCERPT)}\n... (truncated ${full.length - RESULT_EXCERPT} chars${n.resultFile ? `, full result in ${n.resultFile}` : ""})</result>`
      : `\n<result>${full}</result>`;
  }
  if (n.failures.length)
    body += `\n<failures>${xml(n.failures.join("\n")).slice(0, 4 * RESULT_EXCERPT)}</failures>`;
  const a = n.agents;
  body += `\n<usage><agent_count>${a.count}</agent_count><agents_done>${a.done}</agents_done><agents_error>${a.error}</agents_error><agents_skipped>${a.skipped}</agents_skipped><agents_empty_result>${a.empty}</agents_empty_result><subagent_tokens>${n.tokens}</subagent_tokens><tool_uses>${n.toolUses}</tool_uses><duration_ms>${n.durationMs}</duration_ms></usage>`;
  return `<task-notification>\n<task-id>${n.taskId}</task-id>\n<status>${n.status}</status>\n<summary>${summary}</summary>${body}\n</task-notification>`;
}

import { expect, test } from "bun:test";
import { renderProgress, WorkflowRun, type AgentRequest, type Journal } from "../workflow/engine";
import { compileWorkflow } from "../workflow/script";
import { checkWorkflowSyntax, runWorkflowScript, type VmHooks } from "../workflow/vm";

const script = (body: string, meta = "{ name: 'test', description: 'Test workflow' }") =>
  compileWorkflow(`export const meta = ${meta}\n${body}`);

const hooks = (over: Partial<VmHooks> = {}): VmHooks & { logs: string[] } => {
  const logs: string[] = [];
  return {
    logs,
    agent: async (prompt) => `R(${String(prompt)})`,
    log: (m, child) => { logs.push(`${child ? `[${child}] ` : ""}${m}`); },
    phase: (t, child) => { logs.push(`phase ${child ?? ""}:${t}`); },
    failure: (m) => { logs.push(`FAIL ${m}`); },
    checkCaps: () => {},
    spent: () => 7,
    loadChild: async () => { throw new Error("no children"); },
    ...over,
  };
};
const run = (body: string, over: Partial<VmHooks> = {}, args?: unknown, limits = {}) =>
  runWorkflowScript({ body: script(body).body, args, hooks: hooks(over), signal: new AbortController().signal, limits });

test("the sandbox runs parallel/pipeline with Claude Code's null-on-failure semantics", async () => {
  const h = hooks({
    agent: async (prompt, _opts, phase) => {
      await Bun.sleep(Math.random() * 5);
      if (String(prompt).includes("boom")) throw new Error("agent exploded");
      return `${String(prompt)}@${phase ?? "-"}`;
    },
  });
  const result = await runWorkflowScript({
    body: script(`phase('Find')
const xs = await parallel(['a', 'boom', 'c'].map(p => () => agent(p)))
const ys = await pipeline([1, 2, 3],
  n => agent('s' + n),
  (prev, item, i) => item === 2 ? (() => { throw new Error('stage failed') })() : prev + '|' + i,
  prev => prev === null ? 'never' : prev + '!')
const empty = [await parallel([]), await pipeline([])]
log('found ' + xs.filter(Boolean).length)
console.log('obj', { k: 1 })
return { xs, ys, empty, args, spent: budget.spent(), total: budget.total, remaining: String(budget.remaining()) }`).body,
    args: { q: [1, 2] },
    hooks: h,
    signal: new AbortController().signal,
  });
  expect(result).toEqual({
    xs: ["a@Find", null, "c@Find"],
    ys: ["s1@Find|0!", null, "s3@Find|2!"],
    empty: [[], []],
    args: { q: [1, 2] },
    spent: 7,
    total: null,
    remaining: "Infinity",
  });
  expect(h.logs).toEqual([
    "phase :Find",
    "FAIL parallel[1] failed: agent exploded",
    "FAIL pipeline[1] failed: stage failed",
    "found 2",
    'obj {"k":1}',
  ]);
});

test("the sandbox has no host access and blocks nondeterminism", async () => {
  const result = await run(`
const guard = (f) => { try { f(); return 'no' } catch (e) { return e.message.split(' ')[0] } }
const escape = (() => { try { return agent.constructor('return typeof process')() } catch (e) { return 'threw' } })()
const t = await new Promise(r => setTimeout(() => r('timer'), 1))
return {
  globals: [typeof process, typeof require, typeof fetch, typeof Bun, typeof globalThis.__hibana_host, typeof args],
  escape,
  guards: [guard(() => Date.now()), guard(() => new Date()), guard(() => Date()), guard(() => Math.random())],
  fixed: new Date(0).toISOString(), isDate: new Date(0) instanceof Date, t,
}`);
  expect(result).toEqual({
    globals: ["undefined", "undefined", "undefined", "undefined", "undefined", "undefined"],
    escape: "undefined",
    guards: ["Date.now()", "Date.now()", "Date.now()", "Math.random()"],
    fixed: "1970-01-01T00:00:00.000Z",
    isDate: true,
    t: "timer",
  });
});

test("script errors, loops, memory and results fail the run with a clear reason", async () => {
  const fail = async (body: string, limits = {}) => {
    try { await run(body, {}, undefined, limits); return "resolved"; } catch (e) { return (e as Error).message; }
  };
  expect(await fail("\n\nconst o = {}\no.missing()")).toMatch(/^TypeError: .*\(line 5\)$/);
  expect(await fail("while (true) {}", { sliceMs: 100 })).toContain("without awaiting");
  expect(await fail("await agent('x')\nlet i = 0; while (true) { try { while (true) i++ } catch {} }", { sliceMs: 100 })).toContain("without awaiting");
  expect(await fail("const a = []; for (let i = 0; ; i++) a.push('xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' + i)",
    { memoryBytes: 16 * 1024 * 1024, sliceMs: 20000 })).toContain("16 MB memory limit");
  expect(await fail("const o = {}; o.o = o; return o")).toBe("workflow result is not JSON-serializable (a circular reference?)");
  expect(await fail("return parallel([agent('a')])")).toContain("not promises. Wrap each call: () => agent(...)");
  expect(await fail("return parallel(Array.from({length: 4097}, () => () => 1))")).toContain("at most 4096 items");
  expect(await fail("return pipeline([1], 'nope')")).toContain("stages must be functions");
  expect(await fail("setTimeout(() => { throw new Error('late') }, 1); await new Promise(() => {})")).toContain("late");
  expect(await run("await agent('x')")).toBeUndefined();
  expect(await checkWorkflowSyntax("\nconst a: string[] = []")).toBe("SyntaxError: missing initializer for const variable (line 2)");
  expect(await checkWorkflowSyntax("\nreturn await agent('x')")).toBeUndefined();
});

test("a stopped run rejects at once and ignores late agent results", async () => {
  const controller = new AbortController();
  let finish!: (v: string) => void;
  const entered = Promise.withResolvers<void>();
  const running = runWorkflowScript({
    body: script("await agent('slow')\nreturn 1").body, args: undefined, signal: controller.signal,
    hooks: hooks({ agent: () => new Promise((r) => { finish = r; entered.resolve(); }) }),
  });
  await entered.promise;
  controller.abort(new Error("stopped by test"));
  await expect(running).rejects.toThrow("stopped by test");
  finish("late");
  await Bun.sleep(5);
});

test("nested workflow() runs one level deep with its own args, phases and logs", async () => {
  const h = hooks({
    agent: async (prompt, _o, phase, child) => `${String(prompt)}@${phase ?? "-"}#${child ?? "root"}`,
    loadChild: async (ref) => {
      if (ref !== "kid") throw new Error(`Workflow "${String(ref)}" not found`);
      return { name: "kid", body: script("phase('inner')\nlog('child log')\nconst r = await agent('c' + args.n)\nlet nested = 'no'\ntry { await workflow('kid') } catch (e) { nested = e.message }\nreturn { r, nested, args }").body };
    },
  });
  const result = await runWorkflowScript({
    body: script("phase('outer')\nconst kid = await workflow('kid', { n: 7 })\nlet missing\ntry { await workflow('nope') } catch (e) { missing = e.message }\nreturn { kid, missing, own: await agent('p') }").body,
    args: undefined, hooks: h, signal: new AbortController().signal,
  });
  expect(result).toEqual({
    kid: { r: "c7@inner#kid", nested: "workflow() nesting is one level only: workflow() inside a child throws", args: { n: 7 } },
    missing: 'Workflow "nope" not found',
    own: "p@outer#root",
  });
  expect(h.logs).toEqual(["phase :outer", "phase kid:inner", "[kid] child log"]);
});

const runner = (impl: (req: AgentRequest) => Promise<unknown>) => impl;
const newRun = (body: string, over: Partial<ConstructorParameters<typeof WorkflowRun>[3]> = {}) =>
  new WorkflowRun("wf_test01", script(body, "{ name: 'demo', description: 'Demo run', phases: [{ title: 'Find', detail: 'one per item' }, { title: 'Verify' }] }"), undefined, {
    concurrency: 2,
    runAgent: runner(async (req) => `R(${req.prompt})`),
    loadChild: async () => { throw new Error("none"); },
    spent: () => 0,
    onUpdate: () => {},
    ...over,
  });

test("agent() calls queue behind the per-run concurrency cap", async () => {
  let active = 0, peak = 0;
  const wf = newRun("return parallel(Array.from({ length: 7 }, (_, i) => () => agent('item ' + i)))", {
    concurrency: 3,
    runAgent: async (req) => {
      peak = Math.max(peak, ++active);
      await Bun.sleep(3);
      active--;
      req.usage(5, 12);
      req.toolCall();
      return `ok ${req.index}`;
    },
  });
  await wf.start();
  expect(wf.status).toBe("completed");
  expect(wf.result).toEqual(Array.from({ length: 7 }, (_, i) => `ok ${i}`));
  expect(peak).toBe(3);
  expect([wf.spent, wf.totalTokens, wf.toolCalls]).toEqual([35, 84, 7]);
  expect(wf.counts()).toMatchObject({ count: 7, done: 7, error: 0 });
});

test("the 1000-agent backstop stops runaway loops", async () => {
  const wf = newRun("let n = 0\nwhile (true) { await agent('loop ' + n++) }", { concurrency: 16 });
  await wf.start();
  expect(wf.status).toBe("failed");
  expect(wf.error).toContain("Workflow agent() call cap reached (1000)");
  expect(wf.counts().count).toBe(1000);
});

test("agent() validates prompts, options and schemas before running", async () => {
  const wf = newRun(`
const tries = []
for (const f of [
  () => agent(''),
  () => agent('x', 'opts'),
  () => agent('x', { isolation: 'worktree' }),
  () => agent('x', { effort: 'extreme' }),
  () => agent('x', { schema: { type: 'array' } }),
  () => agent('x', { schema: { type: 'object', properties: { a: {} }, required: ['b'], additionalProperties: false } }),
]) { try { await f(); tries.push('ok') } catch (e) { tries.push(e.message) } }
return tries`);
  await wf.start();
  expect(wf.result).toEqual([
    "agent() expects a non-empty prompt string",
    "agent() opts must be an object",
    "agent() opts.isolation is not supported: agents share /workspace, so give parallel writers disjoint paths",
    "agent() opts.effort must be 'low' | 'medium' | 'high' | 'xhigh' | 'max'",
    "agent() schema needs {type: 'object', properties: {...}} at its root",
    "agent() schema is unsatisfiable: required 'b' is not in properties and additionalProperties is false",
  ]);
  expect(wf.counts().count).toBe(0);
});

test("resume replays the longest unchanged prefix; a stopped agent does not break it", async () => {
  const calls: string[] = [];
  const body = (first: string) => `phase('Find')
const r = await parallel(['${first}', 'b', 'c'].map(p => () => agent(p, { label: p })))
phase('Verify')
return [...r, await agent('v')]`;
  // Run 1: "b" hangs until the run is stopped; "a" and "c" complete.
  let release!: () => void;
  const hung = new Promise<void>((r) => { release = r; });
  const first = newRun(body("a"), {
    runAgent: async (req) => {
      calls.push(`1:${req.prompt}`);
      if (req.prompt === "b") { await Promise.race([hung, new Promise((r) => req.signal.addEventListener("abort", r))]); return null; }
      return `R1(${req.prompt})`;
    },
  });
  const done = first.start();
  while (first.counts().done < 2) await Bun.sleep(1);
  first.stop(true);
  await done;
  release();
  await first.settled();
  expect(first.status).toBe("killed");
  expect(first.journal.map((e) => e?.status)).toEqual(["done", "stopped", "done"]);
  // Run 2: same script → a and c cached, b restarts, v runs for the first time.
  const second = newRun(body("a"), {
    resume: first.journal,
    runAgent: async (req) => { calls.push(`2:${req.prompt}`); return `R2(${req.prompt})`; },
  });
  await second.start();
  expect(second.result).toEqual(["R1(a)", "R2(b)", "R1(c)", "R2(v)"]);
  expect(second.counts()).toMatchObject({ count: 4, done: 4 });
  expect(renderProgress(second)).toContain("2 再利用");
  // Run 3: a failure breaks the prefix for every later call.
  const failed: Journal = [{ key: second.journal[0]!.key, status: "done", value: "R1(a)" },
    { key: second.journal[1]!.key, status: "failed" }, second.journal[2]!, second.journal[3]!];
  const third = newRun(body("a"), { resume: failed, runAgent: async (req) => { calls.push(`3:${req.prompt}`); return `R3(${req.prompt})`; } });
  await third.start();
  expect(third.result).toEqual(["R1(a)", "R3(b)", "R3(c)", "R3(v)"]);
  // Run 4: an edited first prompt re-runs everything.
  const fourth = newRun(body("A"), { resume: second.journal, runAgent: async (req) => `R4(${req.prompt})` });
  await fourth.start();
  expect(fourth.result).toEqual(["R4(A)", "R4(b)", "R4(c)", "R4(v)"]);
  expect(calls.filter((c) => c.startsWith("2:"))).toEqual(["2:b", "2:v"]);
});

test("null agents, thrown agents and the progress view", async () => {
  const wf = newRun(`phase('Find')
const found = await parallel([() => agent('good'), () => agent('api down'), () => agent('broken')])
log('checked ' + found.filter(Boolean).length)
await agent('verify it', { phase: 'Verify', label: 'verifier' })
return found`, {
    runAgent: async (req) => {
      if (req.prompt === "api down") return null;
      if (req.prompt === "broken") throw new Error("model unavailable");
      return "[]";
    },
  });
  await wf.start();
  expect(wf.status).toBe("completed");
  expect(wf.result).toEqual(["[]", null, null]);
  expect(wf.counts()).toMatchObject({ count: 4, done: 2, error: 2, empty: 2 });
  expect(wf.failures).toEqual([
    "[api down] returned null (terminal API error after retries)",
    "parallel[2] failed: model unavailable",
  ]);
  const view = renderProgress(wf);
  expect(view).toStartWith("ワークフロー: demo（完了・エージェント 4・0k tokens・");
  expect(view).toContain("Demo run");
  expect(view).toContain("▸ Find（one per item） — 1/3 完了・2 失敗");
  expect(view).toContain("▸ Verify — 1/1 完了");
  expect(view).toContain("> checked 1");
  const notice = wf.notification("task_x");
  expect(notice).toContain('<summary>Dynamic workflow "demo" completed</summary>');
  expect(notice).toContain("<agents_done>2</agents_done><agents_error>2</agents_error>");
  expect(notice).toContain("<agents_empty_result>2</agents_empty_result>");
  // Claude Code flags large runs unless ultracode opted in to the scale.
  const large = newRun("return parallel(Array.from({ length: 30 }, (_, i) => () => agent('n' + i)))", {
    runAgent: () => new Promise(() => {}),
  });
  void large.start();
  while (large.counts().count < 30) await Bun.sleep(1);
  expect(renderProgress(large, { largeAt: 25 })).toContain("⚠ Large workflow: 30 agents");
  expect(renderProgress(large)).not.toContain("Large workflow");
  expect(renderProgress(large)).toContain("2 実行中・28 待機");
  large.stop(false);
  await large.promise;
  expect(large.counts()).toMatchObject({ skipped: 30 });
});

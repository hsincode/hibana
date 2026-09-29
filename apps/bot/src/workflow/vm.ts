import {
  newQuickJSWASMModuleFromVariant,
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
  type QuickJSRuntime,
} from "quickjs-emscripten-core";
import variant from "@jitl/quickjs-wasmfile-release-sync";
import { MAX_WORKFLOW_ITEMS, NESTED_MARK } from "./prompts";

// Workflow scripts are model-written code. Claude Code runs them in a Node vm
// context; that is not a security boundary for a multi-tenant bot whose
// process holds provider keys and every guild's workspace. Each run gets its
// own QuickJS WebAssembly instance instead: the guest sees only the hooks
// below, has a memory cap, and every synchronous slice is interrupted after
// sliceMs so a busy loop cannot stall the Discord gateway.

export type VmLimits = {
  memoryBytes: number;
  /** Longest synchronous stretch (evaluation or one job pump). */
  sliceMs: number;
  maxTimers: number;
  maxTimerMs: number;
};
export const DEFAULT_VM_LIMITS: VmLimits = {
  memoryBytes: 64 * 1024 * 1024,
  sliceMs: 2000,
  maxTimers: 1000,
  maxTimerMs: 600_000,
};

export type VmHooks = {
  /** One agent() call. `phase` is the script's current phase() title (the
   *  host applies opts.phase first); `child` names a nested workflow.
   *  Resolves to a JSON value or null; a rejection surfaces as the Error. */
  agent(prompt: unknown, opts: unknown, phase: string | undefined, child: string | undefined): Promise<unknown>;
  log(message: string, child: string | undefined): void;
  phase(title: string, child: string | undefined): void;
  /** Records a parallel()/pipeline() slot that became null. */
  failure(message: string): void;
  /** Throws once the run cannot start more agents. */
  checkCaps(): void;
  spent(): number;
  /** Resolve workflow(nameOrRef) to a compiled child body. */
  loadChild(ref: unknown): Promise<{ name: string; body: string }>;
};

export class WorkflowVmError extends Error {
  override name = "WorkflowVmError";
}

const FILE = "workflow.js";
// The wrapper adds one line before the body; stacks report body line + 1.
const lineOf = (stack: unknown) => {
  const match = typeof stack === "string" ? /workflow\.js:(\d+)/.exec(stack) : null;
  return match ? Math.max(1, Number(match[1]) - 1) : undefined;
};

function describe(dumped: unknown, limits: VmLimits): string {
  if (dumped && typeof dumped === "object") {
    const e = dumped as { name?: unknown; message?: unknown; stack?: unknown };
    if (e.name === "InternalError" && e.message === "interrupted")
      return `Workflow script ran for more than ${limits.sliceMs} ms without awaiting (an endless loop?) and was stopped`;
    if (e.name === "InternalError" && e.message === "out of memory")
      return `Workflow script exceeded its ${Math.round(limits.memoryBytes / 1048576)} MB memory limit`;
    if (typeof e.message === "string") {
      const line = lineOf(e.stack);
      return `${typeof e.name === "string" ? e.name : "Error"}: ${e.message}${line ? ` (line ${line})` : ""}`;
    }
  }
  return typeof dumped === "string" ? dumped : JSON.stringify(dumped) ?? String(dumped);
}

// Runs inside QuickJS before the script. It wires the hook functions, adds
// parallel()/pipeline() with Claude Code's null-on-failure semantics, and
// removes wall-clock/random sources so a resumed run repeats its calls.
const PRELUDE = String.raw`(() => {
  "use strict";
  const host = globalThis.__hibana_host;
  delete globalThis.__hibana_host;
  const MAX_ITEMS = ${MAX_WORKFLOW_ITEMS};
  const NOW = "Date.now() / new Date() are unavailable in workflow scripts (breaks resume). Stamp results after the workflow returns, or pass timestamps via args.";
  const RANDOM = "Math.random() is unavailable in workflow scripts (breaks resume). For N independent samples, include the index in the agent label or prompt.";
  const text = (v) => {
    if (typeof v === "string") return v;
    try { const s = JSON.stringify(v); return s === undefined ? String(v) : s; } catch { return String(v); }
  };
  const reason = (e) => e && typeof e === "object" && typeof e.message === "string" ? e.message : text(e);

  const RealDate = Date;
  function SafeDate(...a) {
    if (!new.target || a.length === 0) throw new Error(NOW);
    return Reflect.construct(RealDate, a, new.target);
  }
  Object.setPrototypeOf(SafeDate, RealDate);
  SafeDate.prototype = RealDate.prototype;
  SafeDate.now = () => { throw new Error(NOW); };
  Object.defineProperty(RealDate.prototype, "constructor", { value: SafeDate, writable: true, configurable: true });
  globalThis.Date = SafeDate;
  Math.random = () => { throw new Error(RANDOM); };

  let currentPhase;
  globalThis.phase = (title) => { currentPhase = String(title); host.phase(currentPhase); };
  globalThis.log = (message) => { host.log(text(message)); };
  globalThis.agent = (prompt, opts) => host.agent(prompt, opts === undefined ? {} : opts, currentPhase);
  const line = (...a) => host.log(a.map(text).join(" "));
  globalThis.console = Object.freeze({ log: line, info: line, warn: line, error: line, debug: line });

  globalThis.parallel = async function parallel(thunks) {
    if (!Array.isArray(thunks)) throw new TypeError("parallel() expects an array of functions");
    if (thunks.length > MAX_ITEMS) throw new RangeError("parallel() accepts at most " + MAX_ITEMS + " items; got " + thunks.length);
    if (thunks.length === 0) return [];
    host.checkCaps();
    for (const t of thunks)
      if (typeof t !== "function") throw new TypeError("parallel() expects an array of functions, not promises. Wrap each call: () => agent(...)");
    const settled = await Promise.allSettled(thunks.map((t) => { try { return Promise.resolve(t()); } catch (e) { return Promise.reject(e); } }));
    return settled.map((s, i) => {
      if (s.status === "fulfilled") return s.value;
      host.failure("parallel[" + i + "] failed: " + reason(s.reason));
      return null;
    });
  };
  globalThis.pipeline = async function pipeline(items, ...stages) {
    if (!Array.isArray(items)) throw new TypeError("pipeline() expects an array as the first argument");
    if (items.length > MAX_ITEMS) throw new RangeError("pipeline() accepts at most " + MAX_ITEMS + " items; got " + items.length);
    if (items.length === 0) return [];
    host.checkCaps();
    for (const s of stages)
      if (typeof s !== "function") throw new TypeError("pipeline() stages must be functions: pipeline(items, item => ..., result => ...)");
    const settled = await Promise.allSettled(items.map(async (item, index) => {
      let value = await item;
      for (const stage of stages) {
        if (value === null) break;
        value = await stage(value, item, index);
      }
      return value;
    }));
    return settled.map((s, i) => {
      if (s.status === "fulfilled") return s.value;
      host.failure("pipeline[" + i + "] failed: " + reason(s.reason));
      return null;
    });
  };
  globalThis.budget = Object.freeze({ total: null, spent: () => host.spent(), remaining: () => Infinity });

  const timers = new Map();
  let nextTimer = 1;
  host.bindTimers((id) => { const fire = timers.get(id); if (!fire) return; timers.delete(id); fire(); });
  globalThis.setTimeout = (fn, ms, ...a) => {
    if (typeof fn !== "function") throw new TypeError("setTimeout() expects a function");
    const id = nextTimer++;
    timers.set(id, () => fn(...a));
    host.setTimer(id, Number(ms) || 0);
    return id;
  };
  globalThis.clearTimeout = (id) => { if (timers.delete(id)) host.clearTimer(id); };

  // A child gets its own args/phase/log/agent bindings as parameters; its
  // workflow parameter throws, which keeps nesting to one level.
  globalThis.workflow = async function workflow(ref, args) {
    const child = await host.child(ref);
    let childPhase;
    const nested = () => { throw new Error("workflow() nesting is one level only: workflow() inside a child throws"); };
    return child.run(args, nested,
      (title) => { childPhase = String(title); host.phase(childPhase, child.name); },
      (message) => { host.log(text(message), child.name); },
      (prompt, opts) => host.agent(prompt, opts === undefined ? {} : opts, childPhase, child.name));
  };
  globalThis.args = undefined;
})();`;

/** Compile without running, so a syntax error is reported by the Workflow
 *  call itself ("was not launched") instead of as a failed background run. */
export async function checkWorkflowSyntax(body: string, sliceMs = DEFAULT_VM_LIMITS.sliceMs): Promise<string | undefined> {
  const module = await newQuickJSWASMModuleFromVariant(variant);
  const rt = module.newRuntime();
  const deadline = Date.now() + sliceMs;
  rt.setInterruptHandler(() => Date.now() > deadline);
  rt.setMemoryLimit(DEFAULT_VM_LIMITS.memoryBytes);
  const vm = rt.newContext();
  try {
    const compiled = vm.evalCode(`(async () => {\n${body}\n})`, FILE, { compileOnly: true });
    if (!compiled.error) {
      compiled.value.dispose();
      return undefined;
    }
    const dumped = vm.dump(compiled.error);
    compiled.error.dispose();
    return describe(dumped, DEFAULT_VM_LIMITS);
  } finally {
    vm.dispose();
    rt.dispose();
  }
}

export async function runWorkflowScript(o: {
  body: string;
  args: unknown;
  hooks: VmHooks;
  signal: AbortSignal;
  limits?: Partial<VmLimits>;
}): Promise<unknown> {
  const limits = { ...DEFAULT_VM_LIMITS, ...o.limits };
  const module = await newQuickJSWASMModuleFromVariant(variant);
  const rt: QuickJSRuntime = module.newRuntime();
  rt.setMemoryLimit(limits.memoryBytes);
  rt.setMaxStackSize(1024 * 1024);
  let deadline = 0;
  rt.setInterruptHandler(() => Date.now() > deadline);
  const vm: QuickJSContext = rt.newContext();
  const slice = () => { deadline = Date.now() + limits.sliceMs; };
  const deferreds = new Set<QuickJSDeferredPromise>();
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  let fire: QuickJSHandle | undefined;
  let disposed = false;
  let fatal: ((error: Error) => void) | undefined;

  const fail = (error: Error) => fatal?.(error);
  const pump = () => {
    if (disposed) return;
    slice();
    const result = rt.executePendingJobs();
    if (result.error) {
      const dumped = vm.dump(result.error);
      result.error.dispose();
      fail(new WorkflowVmError(describe(dumped, limits)));
    }
  };
  const fromVm = (handle: QuickJSHandle) => vm.dump(handle);
  // Values cross as JSON so no host object is ever reachable from the guest.
  const jsonGlobal = vm.getProp(vm.global, "JSON");
  const jsonParse = vm.getProp(jsonGlobal, "parse");
  const jsonStringify = vm.getProp(jsonGlobal, "stringify");
  jsonGlobal.dispose();
  const toVm = (value: unknown): QuickJSHandle => {
    const json = vm.newString(JSON.stringify(value ?? null));
    const parsed = vm.callFunction(jsonParse, vm.undefined, json);
    json.dispose();
    return vm.unwrapResult(parsed);
  };
  const vmError = (error: unknown) => {
    const e = error instanceof Error ? error : new Error(String(error));
    return vm.newError({ name: e.name === "Error" || !e.name ? "Error" : e.name, message: e.message });
  };
  const asyncHook = (name: string, run: (...args: QuickJSHandle[]) => Promise<unknown>, wrap: (value: unknown) => QuickJSHandle = toVm) =>
    vm.newFunction(name, (...args) => {
      const deferred = vm.newPromise();
      deferreds.add(deferred);
      let started: Promise<unknown>;
      try { started = run(...args); }
      catch (error) { started = Promise.reject(error); }
      started.then(
        (value) => {
          if (disposed || !deferreds.delete(deferred)) return;
          slice();
          try {
            const handle = wrap(value);
            deferred.resolve(handle);
            if (handle !== vm.undefined) handle.dispose();
          } catch (error) {
            const handle = vmError(error);
            deferred.reject(handle);
            handle.dispose();
          }
          pump();
        },
        (error) => {
          if (disposed || !deferreds.delete(deferred)) return;
          slice();
          const handle = vmError(error);
          deferred.reject(handle);
          handle.dispose();
          pump();
        },
      );
      return deferred.handle;
    });
  const syncHook = (name: string, run: (...args: QuickJSHandle[]) => QuickJSHandle | void) =>
    vm.newFunction(name, (...args) => {
      try { return run(...args) ?? undefined; }
      catch (error) { return { error: vmError(error) }; }
    });
  const optionalString = (handle?: QuickJSHandle) =>
    handle && vm.typeof(handle) === "string" ? vm.getString(handle) : undefined;

  const hostObject = vm.newObject();
  const hooks: [string, QuickJSHandle][] = [
    ["agent", asyncHook("agent", (prompt, opts, phase, child) =>
      o.hooks.agent(fromVm(prompt), fromVm(opts), optionalString(phase), optionalString(child)))],
    ["log", syncHook("log", (message, child) => { o.hooks.log(vm.getString(message), optionalString(child)); })],
    ["phase", syncHook("phase", (title, child) => { o.hooks.phase(vm.getString(title), optionalString(child)); })],
    ["failure", syncHook("failure", (message) => { o.hooks.failure(vm.getString(message)); })],
    ["checkCaps", syncHook("checkCaps", () => { o.hooks.checkCaps(); })],
    ["spent", syncHook("spent", () => vm.newNumber(o.hooks.spent()))],
    ["bindTimers", syncHook("bindTimers", (fn) => { fire?.dispose(); fire = fn!.dup(); })],
    ["setTimer", syncHook("setTimer", (idHandle, msHandle) => {
      if (timers.size >= limits.maxTimers) throw new Error(`Too many pending timers (max ${limits.maxTimers})`);
      const id = vm.getNumber(idHandle!);
      const ms = Math.max(0, Math.min(limits.maxTimerMs, vm.getNumber(msHandle!) || 0));
      timers.set(id, setTimeout(() => {
        timers.delete(id);
        if (disposed || !fire) return;
        slice();
        const idArg = vm.newNumber(id);
        const called = vm.callFunction(fire, vm.undefined, idArg);
        idArg.dispose();
        if (called.error) {
          const dumped = vm.dump(called.error);
          called.error.dispose();
          // A throwing timer callback is an uncaught error, as in Node.
          fail(new WorkflowVmError(describe(dumped, limits)));
        } else called.value.dispose();
        pump();
      }, ms));
    })],
    ["clearTimer", syncHook("clearTimer", (idHandle) => {
      const id = vm.getNumber(idHandle!);
      clearTimeout(timers.get(id));
      timers.delete(id);
    })],
    ["child", asyncHook("child", (ref) => o.hooks.loadChild(fromVm(ref)), (loaded) => {
      const { name, body } = loaded as { name: string; body: string };
      slice();
      const compiled = vm.evalCode(`(async function (args, workflow, phase, log, agent) {\n${body}\n})`, `${NESTED_MARK} ${name}.js`);
      if (compiled.error) {
        const dumped = vm.dump(compiled.error);
        compiled.error.dispose();
        throw new WorkflowVmError(`workflow(${JSON.stringify(name)}) failed to start: ${describe(dumped, limits)}`);
      }
      const result = vm.newObject();
      const nameHandle = vm.newString(name);
      vm.setProp(result, "name", nameHandle);
      vm.setProp(result, "run", compiled.value);
      nameHandle.dispose();
      compiled.value.dispose();
      return result;
    })],
  ];
  for (const [name, fn] of hooks) {
    vm.setProp(hostObject, name, fn);
    fn.dispose();
  }
  vm.setProp(vm.global, "__hibana_host", hostObject);
  hostObject.dispose();

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    try {
      for (const deferred of deferreds) deferred.dispose();
      deferreds.clear();
      fire?.dispose();
      jsonParse.dispose();
      jsonStringify.dispose();
      vm.dispose();
      rt.dispose();
    } catch {
      // A module that aborted (e.g. out of memory) cannot free cleanly; it is
      // private to this run and is released with it.
    }
  };

  const abort = () => fail(o.signal.reason instanceof Error ? o.signal.reason : new Error("Workflow stopped"));
  try {
    return await new Promise<unknown>((resolve, reject) => {
      fatal = (error) => { fatal = undefined; reject(error); };
      if (o.signal.aborted) return abort();
      o.signal.addEventListener("abort", abort, { once: true });
      slice();
      const prelude = vm.evalCode(PRELUDE, "prelude.js");
      if (prelude.error) {
        const dumped = vm.dump(prelude.error);
        prelude.error.dispose();
        return reject(new WorkflowVmError(`workflow prelude failed: ${describe(dumped, limits)}`));
      }
      prelude.value.dispose();
      if (o.args !== undefined) {
        const args = toVm(o.args);
        vm.setProp(vm.global, "args", args);
        args.dispose();
      }
      slice();
      const main = vm.evalCode(`(async () => {\n${o.body}\n})()`, FILE);
      if (main.error) {
        const dumped = vm.dump(main.error);
        main.error.dispose();
        return reject(new WorkflowVmError(describe(dumped, limits)));
      }
      const settled = vm.resolvePromise(main.value);
      main.value.dispose();
      settled.then((outcome) => {
        if (disposed) return;
        // Already failed (stopped, interrupted): drop the late outcome.
        if (!fatal) return outcome.dispose();
        if (outcome.error) {
          const dumped = vm.dump(outcome.error);
          outcome.error.dispose();
          return fail(new WorkflowVmError(describe(dumped, limits)));
        }
        slice();
        const text = vm.callFunction(jsonStringify, vm.undefined, outcome.value);
        outcome.value.dispose();
        if (text.error) {
          text.error.dispose();
          return fail(new WorkflowVmError("workflow result is not JSON-serializable (a circular reference?)"));
        }
        const json = vm.typeof(text.value) === "string" ? vm.getString(text.value) : undefined;
        text.value.dispose();
        fatal = undefined;
        resolve(json === undefined ? undefined : JSON.parse(json));
      });
      pump();
    });
  } finally {
    o.signal.removeEventListener("abort", abort);
    dispose();
  }
}

// Workflow script front matter. Claude Code requires the first statement to be
// `export const meta = {...}` as a pure literal so the name, description and
// phases are known without running model-written code; the rest of the file is
// the async body run by the sandbox (vm.ts).

export const MAX_SCRIPT_CHARS = 200_000;

export type WorkflowPhase = { title: string; detail?: string; model?: string };
export type WorkflowMeta = { name: string; description: string; whenToUse?: string; phases: WorkflowPhase[] };
export type CompiledWorkflow = { meta: WorkflowMeta; body: string; source: string };

export class WorkflowScriptError extends Error {
  override name = "WorkflowScriptError";
}

/** Literal parser for the meta object: objects, arrays, strings, numbers,
 *  booleans and null, with identifier or quoted keys, comments and trailing
 *  commas. Identifiers, calls, spreads and `${}` are rejected by construction. */
class Literal {
  i = 0;
  constructor(readonly text: string) {}
  fail(message: string): never {
    const line = this.text.slice(0, this.i).split("\n").length;
    throw new WorkflowScriptError(`meta must be a pure literal: ${message} (line ${line})`);
  }
  space() {
    for (;;) {
      const rest = this.text.slice(this.i);
      const ws = /^\s+/.exec(rest);
      if (ws) { this.i += ws[0].length; continue; }
      if (rest.startsWith("//")) {
        const end = this.text.indexOf("\n", this.i);
        this.i = end < 0 ? this.text.length : end + 1;
        continue;
      }
      if (rest.startsWith("/*")) {
        const end = this.text.indexOf("*/", this.i + 2);
        if (end < 0) this.fail("unterminated comment");
        this.i = end + 2;
        continue;
      }
      return;
    }
  }
  value(depth = 0): unknown {
    if (depth > 16) this.fail("nesting is too deep");
    this.space();
    const c = this.text[this.i];
    if (c === "{") return this.object(depth);
    if (c === "[") return this.array(depth);
    if (c === '"' || c === "'" || c === "`") return this.string();
    const number = /^-?(?:\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?|\.\d+)/.exec(this.text.slice(this.i));
    if (number) {
      this.i += number[0].length;
      return Number(number[0].replaceAll("_", ""));
    }
    for (const [word, value] of [["true", true], ["false", false], ["null", null]] as const) {
      if (this.text.startsWith(word, this.i) && !/[\w$]/.test(this.text[this.i + word.length] ?? "")) {
        this.i += word.length;
        return value;
      }
    }
    if (this.text.startsWith("...", this.i)) this.fail("spreads are not allowed");
    const word = /^[A-Za-z_$][\w$]*/.exec(this.text.slice(this.i))?.[0];
    this.fail(word ? `\`${word}\` is not a literal value` : `unexpected ${JSON.stringify(c ?? "end of script")}`);
  }
  string(): string {
    const quote = this.text[this.i++]!;
    let out = "";
    while (this.i < this.text.length) {
      const c = this.text[this.i++]!;
      if (c === quote) return out;
      if (quote === "`" && c === "$" && this.text[this.i] === "{") this.fail("template interpolation is not allowed");
      if (c === "\n" && quote !== "`") this.fail("unterminated string");
      if (c !== "\\") { out += c; continue; }
      const e = this.text[this.i++];
      const simple: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", 0: "\0" };
      if (e === undefined) break;
      if (e in simple) out += simple[e];
      else if (e === "u" || e === "x") {
        const braced = e === "u" && this.text[this.i] === "{";
        const hex = braced
          ? /^\{([0-9a-fA-F]{1,6})\}/.exec(this.text.slice(this.i))
          : new RegExp(`^([0-9a-fA-F]{${e === "u" ? 4 : 2}})`).exec(this.text.slice(this.i));
        if (!hex) this.fail("invalid escape");
        this.i += hex[0].length;
        out += String.fromCodePoint(parseInt(hex[1]!, 16));
      } else if (e === "\n") continue;
      else out += e;
    }
    this.fail("unterminated string");
  }
  array(depth: number): unknown[] {
    this.i++;
    const out: unknown[] = [];
    for (;;) {
      this.space();
      if (this.text[this.i] === "]") { this.i++; return out; }
      out.push(this.value(depth + 1));
      this.space();
      if (this.text[this.i] === ",") { this.i++; continue; }
      if (this.text[this.i] === "]") { this.i++; return out; }
      this.fail("expected , or ]");
    }
  }
  object(depth: number): Record<string, unknown> {
    this.i++;
    const out: Record<string, unknown> = {};
    for (;;) {
      this.space();
      if (this.text[this.i] === "}") { this.i++; return out; }
      if (this.text.startsWith("...", this.i)) this.fail("spreads are not allowed");
      let key: string;
      const c = this.text[this.i];
      if (c === '"' || c === "'") key = this.string();
      else if (c === "[") this.fail("computed keys are not allowed");
      else {
        const word = /^[A-Za-z_$][\w$]*/.exec(this.text.slice(this.i))?.[0];
        if (!word) this.fail("expected a property name");
        key = word;
        this.i += word.length;
      }
      this.space();
      if (this.text[this.i] !== ":") this.fail(`expected : after ${key} (shorthand properties are variables)`);
      this.i++;
      // Keep own properties only: "__proto__" as data, never a prototype.
      Object.defineProperty(out, key, { value: this.value(depth + 1), enumerable: true, writable: true, configurable: true });
      this.space();
      if (this.text[this.i] === ",") { this.i++; continue; }
      if (this.text[this.i] === "}") { this.i++; return out; }
      this.fail("expected , or }");
    }
  }
}

const string = (value: unknown, field: string, required: boolean): string | undefined => {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || !value.trim())
    throw new WorkflowScriptError(`meta.${field} must be a non-empty string`);
  return value.replace(/\s+/g, " ").trim();
};

function validateMeta(raw: unknown): WorkflowMeta {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new WorkflowScriptError("meta must be an object literal");
  const m = raw as Record<string, unknown>;
  const phases = m.phases === undefined ? [] : m.phases;
  if (!Array.isArray(phases)) throw new WorkflowScriptError("meta.phases must be an array of { title, detail? }");
  return {
    name: string(m.name, "name", true)!.slice(0, 120),
    description: string(m.description, "description", true)!.slice(0, 500),
    whenToUse: string(m.whenToUse, "whenToUse", false)?.slice(0, 500),
    phases: phases.map((p, i) => {
      if (!p || typeof p !== "object" || Array.isArray(p))
        throw new WorkflowScriptError(`meta.phases[${i}] must be { title, detail? }`);
      const phase = p as Record<string, unknown>;
      return {
        title: string(phase.title, `phases[${i}].title`, true)!.slice(0, 120),
        detail: string(phase.detail, `phases[${i}].detail`, false)?.slice(0, 200),
        model: string(phase.model, `phases[${i}].model`, false)?.slice(0, 80),
      };
    }),
  };
}

/** Skip comments, strings and template literals so a `import(` inside a
 *  prompt string does not count as module loading. Regex literals are rare in
 *  workflow scripts; one containing a quote can only cause a false rejection. */
function codeOnly(source: string): string {
  let out = "";
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (c === "/" && source[i + 1] === "/") {
      const end = source.indexOf("\n", i);
      i = end < 0 ? source.length : end - 1;
      out += " ";
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end < 0 ? source.length : end + 1;
      out += " ";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      for (i++; i < source.length && source[i] !== c; i++) if (source[i] === "\\") i++;
      out += " 0 ";
      continue;
    }
    out += c;
  }
  return out;
}

export function compileWorkflow(source: string): CompiledWorkflow {
  if (typeof source !== "string" || !source.trim()) throw new WorkflowScriptError("script is empty");
  if (source.length > MAX_SCRIPT_CHARS)
    throw new WorkflowScriptError(`script exceeds ${MAX_SCRIPT_CHARS} characters`);
  const start = /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*/.exec(source)![0].length;
  const head = /^export\s+const\s+meta\s*=\s*/.exec(source.slice(start));
  if (!head)
    throw new WorkflowScriptError("Every script must begin with `export const meta = {...}` (a pure literal) before any other statement");
  const parser = new Literal(source);
  parser.i = start + head[0].length;
  const meta = validateMeta(parser.value());
  parser.space();
  if (source[parser.i] === ";") parser.i++;
  // Keep line numbers stable for error messages: the meta lines stay blank.
  const body = source.slice(0, parser.i).replace(/[^\n]/g, " ") + source.slice(parser.i);
  const code = codeOnly(body);
  if (/\bimport\s*\(/.test(code) || /(^|[;\n])\s*(import|export)\b/.test(code))
    throw new WorkflowScriptError("Workflow scripts cannot load modules (import/export); put work that needs a library in an agent's task");
  return { meta, body, source };
}

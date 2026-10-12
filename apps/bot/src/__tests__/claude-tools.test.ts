import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_TOOLS, claudeSurface, internalName, resultText, runClaudeTool, type ClaudeHost } from "../claude/tools";
import { loadConfig } from "../config";
import definitions from "../tools/definitions.json";
import { Sandbox } from "../tools/sandbox";
import { ToolOutput, type Context, type Json, type ToolDef } from "../types";

// The Claude harness's tools (#66): which ones a context is shown, and what
// each returns. Files are real, in a temporary workspace; the container is
// not started, so shell results are supplied by the test.

const dir = await mkdtemp(join(tmpdir(), "hibana-claude-tools-"));
afterAll(() => rm(dir, { recursive: true, force: true }));
const sandbox = new Sandbox(loadConfig({ HIBANA_DATA_DIR: dir, RUNTIME_STATE_PATH: "" }));
sandbox.available = true;
const ctx: Context = { guildId: "1", channelId: "2", userId: "3", botId: "4", thread: false, depth: 0, delivered: false };

type Shell = { exit_code: number; stdout: string; stderr: string; truncated: boolean };
const ran: { command: string; seconds: number }[] = [];
let shell: Shell;
sandbox.run = (async (_ctx: Context, command: string, seconds: number) => {
  ran.push({ command, seconds });
  return shell;
}) as Sandbox["run"];
const asked: Json[] = [];
let answer: Json;
const host: ClaudeHost = {
  sandbox,
  proxy: () => undefined,
  integration: async (name, args) =>
    name === "use_skill" ? { name: args.name, content: "Follow these steps.", files: ["run.sh", "notes.md"], base: `.skills/${String(args.name)}` } : null,
  ask: async (args) => { asked.push(args); return answer; },
  agent: async (call) => `report for ${call.description}`,
};
const run = (name: string, args: Json) => runClaudeTool(host, name, args, ctx);
const fails = async (name: string, args: Json) => run(name, args).then(() => { throw new Error("expected a failure"); }, (e: Error) => e.message);
beforeEach(() => {
  ran.length = 0;
  asked.length = 0;
  shell = { exit_code: 0, stdout: "", stderr: "", truncated: false };
});

describe("the tool surface", () => {
  const base = definitions as ToolDef[];
  const names = (tools: ToolDef[]) => tools.map((t) => t.function.name);
  const root = claudeSurface(base, { sandbox: true, root: true, agents: true });

  test("lists Claude Code's tools first, under its names, then the integrations", () => {
    expect(names(root).slice(0, 9)).toEqual(["Bash", "Read", "Edit", "Write", "Glob", "Grep", "AskUserQuestion", "Skill", "Agent"]);
    expect(names(root).slice(9).every((name) => /^mcp__[a-z]+__[a-z_]+$/.test(name))).toBe(true);
    // One way to do each thing: the integration tools those replace are gone.
    for (const replaced of ["bash", "read_file", "write_file", "write_files", "edit_file", "list_files", "grep_files"])
      expect(names(root)).not.toContain(`mcp__workspace__${replaced}`);
    expect(names(root)).not.toContain("mcp__skills__use_skill");
    expect(new Set(names(root)).size).toBe(root.length);
  });

  test("loads only delivery and reading up front; every other integration is found by search", () => {
    expect(names(root.filter((t) => !t.defer)).slice(9).sort()).toEqual([
      "mcp__discord__read_messages", "mcp__sites__publish_site", "mcp__workspace__download_attachment", "mcp__workspace__send_file",
    ]);
    expect(root.filter((t) => t.defer)).toHaveLength(base.length - 8 - 4);
    // The definitions the frozen harness uses are not edited; a description
    // that is wrong for this harness is replaced on the way out.
    const sendFile = root.find((t) => t.function.name === "mcp__workspace__send_file")!;
    expect(sendFile.function.description).toContain("posted when this is called");
    expect(base.find((t) => t.function.name === "send_file")!.function.description).not.toBe(sendFile.function.description);
  });

  test("a subagent is shown what its type may do", () => {
    const explore = names(claudeSurface(base, { sandbox: true, root: false, agents: true, role: "explorer" }));
    expect(explore).toEqual(expect.arrayContaining(["Read", "Glob", "Grep", "Skill", "mcp__discord__read_messages"]));
    for (const hidden of ["Bash", "Edit", "Write", "Agent", "AskUserQuestion", "mcp__workspace__send_file", "mcp__discord__send_message"])
      expect(explore).not.toContain(hidden);
    const worker = names(claudeSurface(base, { sandbox: true, root: false, agents: true, role: "worker" }));
    expect(worker).toEqual(expect.arrayContaining(["Bash", "Read", "Edit", "Write", "Glob", "Grep"]));
    // What the user or the server sees stays with the agent that talks to them.
    for (const hidden of ["Agent", "AskUserQuestion", "mcp__workspace__send_file", "mcp__discord__send_message", "mcp__sites__publish_site", "mcp__settings__set_bot_model"])
      expect(worker).not.toContain(hidden);
  });

  test("leaves out what the context cannot use", () => {
    expect(names(claudeSurface(base, { sandbox: false, root: true, agents: true })).slice(0, 3)).toEqual(["AskUserQuestion", "Skill", "Agent"]);
    expect(names(claudeSurface(base, { sandbox: true, root: true, agents: false }))).not.toContain("Agent");
    expect(names(claudeSurface(base.filter((t) => !/skill/.test(t.function.name)), { sandbox: true, root: true, agents: true }))).not.toContain("Skill");
  });

  test("every Claude tool maps to the name the role and permission checks know", () => {
    expect(CLAUDE_TOOLS.map((t) => internalName(t.function.name))).toEqual([
      "bash", "read_file", "edit_file", "write_file", "list_files", "grep_files", "request_user_input", "use_skill", "agents__spawn_agent",
    ]);
    expect(internalName("mcp__discord__send_message")).toBe("send_message");
  });
});

describe("Read", () => {
  test("returns numbered lines and says where a longer file continues", async () => {
    await sandbox.write(ctx, "notes.txt", Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
    const all = await run("Read", { file_path: "notes.txt" });
    expect(all.text.split("\n")).toHaveLength(30);
    expect(all.text.startsWith("     1\tline 1\n     2\tline 2")).toBe(true);
    const part = await run("Read", { file_path: "/workspace/notes.txt", offset: 10, limit: 3 });
    expect(part.text).toBe("    10\tline 10\n    11\tline 11\n    12\tline 12\n[Showing lines 10-12 of 30. Continue with offset 13.]");
    expect((await run("Read", { file_path: "notes.txt", offset: 31 })).text).toBe("notes.txt has 30 lines; line 31 is past its end.");
  });

  test("stops at its size limit on a line boundary and cuts an overlong line", async () => {
    await sandbox.write(ctx, "wide.txt", Array.from({ length: 100 }, () => "x".repeat(1500)).join("\n"));
    const out = (await run("Read", { file_path: "wide.txt" })).text.split("\n");
    expect(out.at(-1)).toMatch(/^\[Showing lines 1-\d+ of 100\. Continue with offset \d+\.\]$/);
    expect(out.length).toBeLessThan(45);
    await sandbox.write(ctx, "long.txt", "y".repeat(5000));
    expect((await run("Read", { file_path: "long.txt" })).text).toBe(`     1\t${"y".repeat(2000)} [line cut at 2000 characters]`);
  });

  test("names what it will not read instead of returning garbage", async () => {
    await sandbox.write(ctx, "empty.txt", "");
    expect((await run("Read", { file_path: "empty.txt" })).text).toBe("empty.txt exists and is empty.");
    await sandbox.write(ctx, "sub/a.txt", "a");
    expect(await fails("Read", { file_path: "sub" })).toContain("is a directory");
    expect(await fails("Read", { file_path: "missing.txt" })).toBe("No such file: missing.txt");
    await writeFile(await sandbox.path(ctx, "blob.bin"), Buffer.from([1, 2, 0, 3]));
    expect(await fails("Read", { file_path: "blob.bin" })).toContain("binary file");
    expect(await fails("Read", { file_path: "../outside.txt" })).toContain("escapes workspace");
  });

  test("returns an image as an image", async () => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
    await writeFile(await sandbox.path(ctx, "dot.png"), png);
    const out = await run("Read", { file_path: "dot.png" });
    expect(out.options.images).toEqual([`data:image/png;base64,${png.toString("base64")}`]);
    expect(out.text).toBe(`Image dot.png (${png.length} bytes)`);
  });
});

describe("Edit and Write", () => {
  test("replace exactly one occurrence, or all of them when asked", async () => {
    await run("Write", { file_path: "src/app.ts", content: "const a = 1;\nconst b = 1;\n" });
    expect((await run("Edit", { file_path: "src/app.ts", old_string: "const a = 1;", new_string: "const a = 2;" })).text)
      .toBe("Edited src/app.ts: 1 replacement.");
    expect(await fails("Edit", { file_path: "src/app.ts", old_string: " = ", new_string: " := " })).toContain("appears 2 times");
    expect((await run("Edit", { file_path: "src/app.ts", old_string: " = ", new_string: " := ", replace_all: true })).text)
      .toBe("Edited src/app.ts: 2 replacements.");
    expect((await run("Read", { file_path: "src/app.ts" })).text).toBe("     1\tconst a := 2;\n     2\tconst b := 1;");
  });

  test("say why an edit was refused", async () => {
    await run("Write", { file_path: "a.txt", content: "one\n" });
    expect(await fails("Edit", { file_path: "a.txt", old_string: "two", new_string: "2" })).toContain("was not found in a.txt");
    expect(await fails("Edit", { file_path: "a.txt", old_string: "one", new_string: "one" })).toContain("nothing would change");
    expect(await fails("Edit", { file_path: "nope.txt", old_string: "a", new_string: "b" })).toContain("No such file: nope.txt");
    // Saved back as UTF-8, a Shift-JIS file would lose every byte that is not.
    await writeFile(await sandbox.path(ctx, "sjis.txt"), Buffer.from([0x82, 0xa0, 0x41]));
    expect(await fails("Edit", { file_path: "sjis.txt", old_string: "A", new_string: "B" })).toContain("not valid UTF-8");
  });

  test("Write reports what it wrote", async () => {
    expect((await run("Write", { file_path: "deep/dir/x.txt", content: "火花" })).text).toBe("Wrote 6 bytes to deep/dir/x.txt.");
  });
});

describe("Glob", () => {
  test("lists matches newest first and says what it left out", async () => {
    for (const [i, name] of ["g/old.md", "g/new.md", "g/skip.txt", "g/deep/also.md"].entries()) {
      await sandbox.write(ctx, name, name);
      await utimes(await sandbox.path(ctx, name), 1000 + i, 1000 + i);
    }
    expect((await run("Glob", { pattern: "**/*.md", path: "g" })).text).toBe("deep/also.md\nnew.md\nold.md");
    expect((await run("Glob", { pattern: "*.md", path: "g" })).text).toBe("new.md\nold.md");
    expect((await run("Glob", { pattern: "**/*.rs", path: "g" })).text).toBe("No files matched.");
    for (let i = 0; i < 205; i++) await sandbox.write(ctx, `many/f${i}.log`, "");
    const out = (await run("Glob", { pattern: "many/*.log" })).text.split("\n");
    expect(out).toHaveLength(201);
    expect(out.at(-1)).toBe("[5 more files matched and are not listed. Narrow the pattern.]");
  });
});

describe("Bash", () => {
  test("returns output, stderr and a failing exit code as an error", async () => {
    shell = { exit_code: 0, stdout: "ok\n", stderr: "", truncated: false };
    const ok = await run("Bash", { command: "echo ok", timeout: 5000, description: "say ok" });
    expect(ok).toEqual(new ToolOutput("ok", { isError: false }));
    expect(ran).toEqual([{ command: "echo ok", seconds: 5 }]);
    shell = { exit_code: 2, stdout: "", stderr: "boom\n", truncated: false };
    expect(await run("Bash", { command: "false" })).toEqual(new ToolOutput("[stderr]\nboom\nExit code: 2", { isError: true }));
    expect(ran.at(-1)!.seconds).toBe(120);
    shell = { exit_code: 0, stdout: "", stderr: "", truncated: false };
    expect((await run("Bash", { command: "true" })).text).toBe("(no output)");
  });

  test("does not call 'nothing found' a failure, and names a timeout and a container that did not start", async () => {
    shell = { exit_code: 1, stdout: "", stderr: "", truncated: false };
    expect((await run("Bash", { command: "grep -r needle ." })).options.isError).toBe(false);
    expect((await run("Bash", { command: "git diff --quiet" })).options.isError).toBe(false);
    expect((await run("Bash", { command: "bun test" })).options.isError).toBe(true);
    shell = { exit_code: 124, stdout: "partial", stderr: "", truncated: false };
    expect((await run("Bash", { command: "sleep 999", timeout: 3000 })).text).toBe("partial\nThe command did not finish within 3 seconds and was stopped.");
    shell = { exit_code: 125, stdout: "", stderr: "docker: no", truncated: false };
    expect((await run("Bash", { command: "ls" })).text).toContain("could not start");
  });

  test("saves long output to a file and returns both ends of it", async () => {
    const long = `HEAD${"a".repeat(40_000)}TAIL`;
    shell = { exit_code: 0, stdout: long, stderr: "", truncated: false };
    const out = (await run("Bash", { command: "cat big" })).text;
    expect(out.length).toBeLessThan(9000);
    expect(out.startsWith("HEAD")).toBe(true);
    expect(out).toContain("TAIL\nOutput was 40,008 characters; only its first and last 4,000 are shown. The full output is in /workspace/.hibana/tool-output/");
    const path = /\/workspace\/(\.hibana\/tool-output\/[\w.-]+\.txt)/.exec(out)![1]!;
    // The file is in the workspace, where the same tools can read the rest.
    expect(await Bun.file(await sandbox.path(ctx, path)).text()).toBe(long);
    expect((await run("Read", { file_path: path, limit: 1 })).text.startsWith("     1\tHEADaaaa")).toBe(true);
  });
});

describe("Grep", () => {
  test("builds the ripgrep call for each output mode and stays inside the workspace", async () => {
    shell = { exit_code: 0, stdout: "src/a.ts\nsrc/b.ts\n", stderr: "", truncated: false };
    expect((await run("Grep", { pattern: "TODO|FIXME", path: "/workspace/src", glob: "*.ts", "-i": true })).text).toBe("src/a.ts\nsrc/b.ts");
    // Every argument is quoted: the pattern and the paths are the model's text.
    expect(ran.at(-1)).toEqual({ command: "rg '--color' 'never' '-l' '-i' '--glob' '*.ts' '-e' 'TODO|FIXME' '--' 'src'", seconds: 20 });
    await run("Grep", { pattern: "x", output_mode: "content", "-C": 2, multiline: true, type: "py" });
    expect(ran.at(-1)!.command).toBe("rg '--color' 'never' '-n' '--no-heading' '-C' '2' '-U' '--multiline-dotall' '--type' 'py' '-e' 'x' '--' '.'");
    await run("Grep", { pattern: "it's", output_mode: "count" });
    expect(ran.at(-1)!.command).toContain(`'-c' '-e' 'it'`);
    expect(ran.at(-1)!.command.endsWith(`'--' '.'`)).toBe(true);
    expect(await fails("Grep", { pattern: "x", path: "/etc" })).toContain("inside /workspace");
  });

  test("reports no match, a cut result and a failed search differently", async () => {
    shell = { exit_code: 1, stdout: "", stderr: "", truncated: false };
    expect((await run("Grep", { pattern: "nothing" })).text).toBe("No matches found.");
    shell = { exit_code: 0, stdout: Array.from({ length: 12 }, (_, i) => `f${i}.ts`).join("\n"), stderr: "", truncated: false };
    expect((await run("Grep", { pattern: "x", head_limit: 10 })).text.split("\n").at(-1)).toBe("[2 more lines not shown. Narrow the search or raise head_limit.]");
    shell = { exit_code: 2, stdout: "", stderr: "regex parse error", truncated: false };
    expect(await fails("Grep", { pattern: "(" })).toBe("regex parse error");
    shell = { exit_code: 124, stdout: "", stderr: "", truncated: false };
    expect(await fails("Grep", { pattern: "x" })).toContain("did not finish within 20 seconds");
  });
});

describe("AskUserQuestion, Skill and Agent", () => {
  test("a question gets the id Discord needs, and an unanswered one is not agreement", async () => {
    answer = { answers: { q1: { answers: ["Blue"] } }, cancelled: true, reason: "timeout" };
    const question = (text: string) => ({ question: text, header: "Color", options: [{ label: "Blue", description: "" }, { label: "Red", description: "" }] });
    const out = await run("AskUserQuestion", { questions: [question("Which color?"), question("And the border?")] });
    expect((asked[0]!.questions as Json[]).map((q) => q.id)).toEqual(["q1", "q2"]);
    expect(out.text).toBe(
      "Which color?\nAnswer: Blue\n\nAnd the border?\nNot answered.\n\nThe wait ended (timeout) before every question was answered. An unanswered question is not agreement.",
    );
  });

  test("a skill returns its instructions and where its files are", async () => {
    expect((await run("Skill", { skill: "video-edit" })).text).toBe(
      "Follow these steps.\n\nFiles of this skill, under /workspace/.skills/video-edit/:\n- run.sh\n- notes.md",
    );
  });

  test("a subagent's report is the result", async () => {
    expect((await run("Agent", { description: "find the config", prompt: "Where is it?", subagent_type: "Explore" })).text).toBe("report for find the config");
  });
});

test("a long result keeps both ends and says what was left out", () => {
  expect(resultText({ ok: true })).toBe('{"ok":true}');
  expect(resultText(new ToolOutput("plain\ntext"))).toBe("plain\ntext");
  const cut = resultText(`START${"x".repeat(60_000)}END`);
  expect(cut.length).toBeLessThan(40_100);
  expect(cut.startsWith("START")).toBe(true);
  expect(cut.endsWith("END")).toBe(true);
  expect(cut).toContain("[... 20008 characters left out ...]");
});

import { describe, test, expect } from "bun:test";
import { mkdtemp, mkdir, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyGuild, emptyUserOverride } from "@hibana/shared/settings";
import { loadConfig } from "../config";
import { imagePrompt, shouldRespond, splitMessage } from "../triggers";
import { Runtime } from "../runtime";
import { History } from "../history";
import definitions from "../tools/definitions.json";
import { jevTaskTool } from "../jev-task";
import { safePath, scopeOf, Sandbox } from "../tools/sandbox";
import { isPublicAddress } from "../network";
import {
  applyPatch,
  assemblePrompt,
  harnessTools,
  multiAgentModeMessage,
  normalizeTool,
} from "../harness";
import { emptyUsage, type Context, type ToolDef } from "../types";
import { turnSelection, ultracodeActive } from "../ultracode";
const ctx: Context = {
  guildId: "100",
  channelId: "200",
  userId: "300",
  botId: "400",
  thread: false,
  depth: 0,
  delivered: false,
};
const config = () =>
  loadConfig({
    HIBANA_DATA_DIR: "/tmp/hibana-tests",
    CODEX_PLUS_API_KEY: "test-plus",
  });
describe("trigger parity", () => {
  const input = {
    content: "Hibana こんにちは",
    bot: false,
    pinned: false,
    system: false,
    mention: false,
    dm: false,
    thread: false,
  };
  test("Hibana and legacy names trigger; ASCII boundaries and comments are respected", () => {
    expect(shouldRespond(input, emptyGuild())).toBe(true);
    expect(
      shouldRespond({ ...input, content: "ds こんにちは" }, emptyGuild()),
    ).toBe(true);
    expect(
      shouldRespond({ ...input, content: "words are here" }, emptyGuild()),
    ).toBe(false);
    for (const content of ["// hibana", "# hibana", "/* hibana", "<!-- hibana"])
      expect(
        shouldRespond({ ...input, content, mention: true }, emptyGuild()),
      ).toBe(false);
    expect(
      shouldRespond({ ...input, content: "## Hibana" }, emptyGuild()),
    ).toBe(true);
  });
  test("thread titles, DM, disable and thread-only gates", () => {
    expect(
      shouldRespond(
        { ...input, content: "hello", thread: true, title: "Hibana project" },
        emptyGuild(),
      ),
    ).toBe(true);
    expect(
      shouldRespond(
        { ...input, content: "hello", title: "Hibana project" },
        emptyGuild(),
      ),
    ).toBe(false);
    expect(
      shouldRespond({ ...input, content: "hello", dm: true }, emptyGuild()),
    ).toBe(true);
    expect(shouldRespond(input, { ...emptyGuild(), thread_only: true })).toBe(
      false,
    );
    expect(
      shouldRespond(
        { ...input, mention: true },
        { ...emptyGuild(), bot_disabled: true },
      ),
    ).toBe(false);
    for (const gate of ["bot", "pinned", "system"])
      expect(shouldRespond({ ...input, [gate]: true }, emptyGuild())).toBe(
        false,
      );
  });
  test("/image is a text prefix on messages that already trigger", () => {
    const route = (
      content: string,
      extra: Partial<Parameters<typeof shouldRespond>[0]> = {},
      guild = emptyGuild(),
    ) => {
      const message = { ...input, content, ...extra };
      if (!shouldRespond(message, guild)) return "ignore";
      const prompt = imagePrompt(content, "400");
      return prompt === null ? "agent" : prompt;
    };
    expect(route("/image a cat")).toBe("ignore");
    expect(route("/image a cat", { dm: true })).toBe("a cat");
    expect(route("/image hibana shrine")).toBe("hibana shrine");
    expect(route("hibana /image shrine")).toBe("agent");
    expect(route("<@400> /image 赤いパンダ", { mention: true })).toBe("赤いパンダ");
    expect(route("<@!400>\n/image cat", { mention: true })).toBe("cat");
    expect(route("<@400> <@400> /image cat", { mention: true })).toBe("cat");
    expect(route("look /image cat <@400>", { mention: true })).toBe("agent");
    expect(route("<@999> /image cat", { dm: true })).toBe("agent");
    expect(route("/imagefoo", { dm: true })).toBe("agent");
    expect(route("/image", { dm: true })).toBe("");
    expect(route("/image\u3000猫", { dm: true })).toBe("猫");
    expect(route("  /image  spaced  ", { dm: true })).toBe("spaced");
    expect(route("// /image cat", { dm: true })).toBe("ignore");
    expect(route("/image cat", { bot: true, dm: true })).toBe("ignore");
    expect(
      route("/image cat", { thread: true, title: "Hibana project" }),
    ).toBe("cat");
    expect(
      route("/image cat", { mention: true }, { ...emptyGuild(), bot_disabled: true }),
    ).toBe("ignore");
    expect(imagePrompt("/image " + "a".repeat(8000), "400")).toHaveLength(8000);
  });
  test("messages fit Discord limits without splitting surrogate pairs", () => {
    const value = "火花🔥".repeat(2000);
    const chunks = splitMessage(value);
    expect(chunks.every((c) => c.length <= 1900)).toBe(true);
    expect(chunks.join("")).toBe(value);
    expect(chunks.some((c) => /[\uD800-\uDBFF]$/.test(c))).toBe(false);
  });
});
describe("runtime isolation", () => {
  test("published tool schemas use provider-compatible scalar types", () => {
    const visit = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      if ("type" in value)
        // Gemini rejects the whole request when JSON Schema uses union type arrays.
        expect(Array.isArray(value.type)).toBe(false);
      for (const child of Object.values(value)) visit(child);
    };
    for (const tool of [...definitions, jevTaskTool]) visit(tool.function.parameters);
  });

  test("credentials never fall back across paid accounts", () => {
    const c = config();
    expect(c.endpoints.codex_plus?.apiKey).toBe("test-plus");
    expect(c.endpoints.codex_pro?.apiKey).toBe("");
    expect(c.endpoints.claude_kiro?.apiKey).toBe("");
    expect(c.endpoints.opencode_go).toBeUndefined();
    expect(c.selection).toEqual({
      provider: "codex_plus",
      model: "gpt-6-luna",
      effort: "max",
    });
    expect(loadConfig({
      HIBANA_DATA_DIR: "/tmp/hibana-tests",
      CODEX_PLUS_API_KEY: "test-plus",
      LLM_MODEL: "gpt-5.6-luna",
    }).selection.model).toBe("gpt-6-luna");
    expect(loadConfig({
      HIBANA_DATA_DIR: "/tmp/hibana-tests",
      CLAUDE_MAX_API_KEY: "test-max",
      PROVIDER: "claude_max",
      LLM_MODEL: "claude-fable-5",
    }).selection.model).toBe("claude-fable-5-1");
    expect(() => loadConfig({ PROVIDER: "CODEX_EVERYWHERE" })).toThrow();
    expect(() => loadConfig({ PROVIDER: "OPENCODE_GO" })).toThrow();
    expect(() => loadConfig({ LLM_TEMPERATURE: "NaN" })).toThrow();
  });
  test("guild patch persists, user overlay wins, unrelated history stays valid", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hibana-state-"));
    try {
      const runtime = new Runtime(
        loadConfig({
          HIBANA_DATA_DIR: dir,
          CODEX_PLUS_API_KEY: "test",
        }),
      );
      let changed: string | undefined;
      runtime.onChange = (id) => {
        changed = id;
      };
      await runtime.patch("100", { preset: "sol", effort: "high" }, "300");
      expect(runtime.resolve("100").selection.model).toBe("gpt-6.1-sol");
      expect(runtime.resolve("101").selection.model).toBe("gpt-6-luna");
      expect(changed).toBe("100");
      await runtime.patch("100", { subagent_model: { mode: "fixed", preset: "sol" } }, "300");
      expect(runtime.resolve("100", "300").subagent_model).toEqual({ mode: "fixed", preset: "sol" });
      expect(runtime.resolve("101", "300").subagent_model).toEqual({ mode: "auto" });
      runtime.snapshot.user_overrides["300"] = {
        ...emptyUserOverride(),
        selection: null,
        subagent_model: { mode: "fixed", preset: "plus-luna" },
        subagent_effort: null,
        jev_enabled: null,
        jev_task_enabled: null,
        context: null,
      };
      expect(runtime.resolve("100", "300").subagent_model).toEqual({ mode: "fixed", preset: "plus-luna" });
      expect(runtime.resolve("100", "301").subagent_model).toEqual({ mode: "fixed", preset: "sol" });
      const loaded = new Runtime(runtime.config);
      await loaded.load();
      expect(loaded.resolve("100").selection.effort).toBe("high");
      expect(
        JSON.stringify(await Bun.file(runtime.config.statePath).json()),
      ).not.toContain("test-plus");
      await runtime.setContext(undefined, "300", { text: "Personal context" });
      expect(runtime.resolve(undefined, "300").context?.text).toBe(
        "Personal context",
      );
      expect(runtime.resolve(undefined, "301").context).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  test("history retains complete tool pairs and invalidates only the changed guild", () => {
    const h = new History(config());
    h.get("1", "100", "one", false, 3600);
    h.get("2", "200", "one", false, 3600);
    const messages = [
      { role: "developer" as const, content: "transient harness policy" },
      { role: "user" as const, content: "hello" },
      {
        role: "assistant" as const,
        content: null,
        tool_calls: [
          {
            id: "call",
            type: "function" as const,
            function: { name: "read_file", arguments: "{}" },
          },
        ],
      },
      { role: "tool" as const, tool_call_id: "call", content: "done" },
      { role: "assistant" as const, content: "answer" },
    ];
    h.put("1", messages, emptyUsage());
    h.put("2", messages, emptyUsage());
    h.clearGuild("100");
    expect(h.get("1", "100", "one", false, 3600)).toEqual([]);
    expect(h.get("2", "200", "one", false, 3600)).toEqual(messages.slice(1));
    expect(h.get("2", "200", "other-model", false, 3600)).toEqual([]);
  });
});
describe("workspace boundary", () => {
  test("scope mapping preserves shared guild and isolated thread / DM workspaces", () => {
    expect(scopeOf(ctx)).toBe("guilds/100");
    expect(scopeOf({ ...ctx, thread: true })).toBe("threads/200");
    expect(scopeOf({ ...ctx, guildId: undefined })).toBe("dms/200");
    expect(() => scopeOf({ ...ctx, guildId: "../etc" })).toThrow();
  });
  test("rejects traversal and symlinks including dangling links", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hibana-path-"));
    try {
      await mkdir(join(dir, "safe"));
      await symlink("/etc", join(dir, "escape"));
      await symlink("/nonexistent", join(dir, "dangling"));
      expect(await safePath(dir, "/workspace/safe/test.txt")).toBe(
        join(dir, "safe/test.txt"),
      );
      for (const p of [
        "../outside",
        "/etc/passwd",
        "escape/passwd",
        "dangling/a",
      ])
        await expect(safePath(dir, p)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  test("patch operations validate before mutating and preserve edits", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hibana-patch-"));
    try {
      const sandbox = new Sandbox(loadConfig({ HIBANA_DATA_DIR: dir }));
      await sandbox.write(ctx, "a.txt", "hello\n");
      await expect(
        applyPatch(
          sandbox,
          ctx,
          "*** Begin Patch\n*** Update File: a.txt\n@@\n-hello\n+changed\n*** Update File: missing.txt\n@@\n-no\n+yes\n*** End Patch",
        ),
      ).rejects.toThrow();
      expect((await sandbox.read(ctx, "a.txt")).content).toBe("hello\n");
      await applyPatch(
        sandbox,
        ctx,
        "*** Begin Patch\n*** Update File: a.txt\n@@\n-hello\n+changed\n*** Add File: b.txt\n+new\n*** End Patch",
      );
      expect((await sandbox.read(ctx, "a.txt")).content).toBe("changed\n");
      expect((await sandbox.read(ctx, "b.txt")).content).toBe("new\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  test("public network validation rejects reserved and IPv4-mapped private addresses", () => {
    for (const address of [
      "127.0.0.1",
      "10.1.2.3",
      "169.254.169.254",
      "192.168.0.1",
      "::1",
      "::ffff:127.0.0.1",
      "fc00::1",
      "fe80::1",
      "0.0.0.0",
    ])
      expect(isPublicAddress(address)).toBe(false);
    expect(isPublicAddress("1.1.1.1")).toBe(true);
    expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
  });
});
test("Codex tool translation and disabled sandbox surface", () => {
  expect(normalizeTool("mcp__workspace__read_file", { path: "a" })).toEqual({
    name: "read_file",
    args: { path: "a" },
  });
  expect(
    normalizeTool("Bash", { command: "ls", timeout: 2000 }).args.timeout_secs,
  ).toBe(2);
  expect(
    normalizeTool("shell_command", {
      parameters: { command: "pwd", workdir: "/workspace" },
    }),
  ).toEqual({
    name: "bash",
    args: { command: "pwd", workdir: "/workspace", timeout_secs: 120 },
  });
  expect(
    normalizeTool("shell_command", {
      params: { command: "pwd", workdir: "/workspace" },
      timeout_ms: 2000,
    }).args,
  ).toEqual({ command: "pwd", workdir: "/workspace", timeout_secs: 2 });
  const tools = harnessTools([], false);
  expect(
    tools.some((t) => /^(shell_command|apply_patch)$/.test(t.function.name)),
  ).toBe(false);
});

test("home route tools register under workspace and normalize for dispatch", () => {
  const base = (definitions as ToolDef[]).filter(t => t.function.name.startsWith("home_vpn_"));
  const tools = harnessTools(base, true);
  for (const action of ["status", "connect", "disconnect"]) {
    const name = `mcp__workspace__home_vpn_${action}`;
    expect(tools.some(t => t.function.name === name)).toBe(true);
    expect(normalizeTool(name, {})).toEqual({ name: `home_vpn_${action}`, args: {} });
  }
  expect(harnessTools([], true).some(t => t.function.name.includes("home_vpn_"))).toBe(false);
});

test("the proactive Multi-Agent V2 text is kept verbatim for Multi-Agent", () => {
  const proactive = multiAgentModeMessage(true).content;
  const normal = multiAgentModeMessage(false).content;
  expect(proactive).toContain("<multi_agent_mode>");
  expect(proactive).toContain("Proactive multi-agent delegation is active");
  expect(proactive).not.toContain("Do not spawn sub-agents");
  expect(normal).toContain("Do not spawn sub-agents");
  expect(normal).not.toContain("Proactive multi-agent delegation is active");
});

test("Ultra (Ultracode) keeps the explicit agent policy; only Multi-Agent is proactive", async () => {
  for (const [env, proactive] of [[{ LLM_EFFORT: "ultra" }, false], [{ ULTRA_MODE: "true" }, false], [{ MULTI_AGENT: "true" }, true]] as const) {
    const runtime = new Runtime(loadConfig({ HIBANA_DATA_DIR: "/tmp/hibana-tests", RUNTIME_STATE_PATH: "", ...env }));
    const prompt = await assemblePrompt(runtime, ctx, "");
    expect(prompt.map((message) => message.role)).toEqual(proactive
      ? ["system", "developer", "developer", "user"]
      : ["system", "developer", "user"]);
    expect(prompt[1]).toEqual(multiAgentModeMessage(proactive));
    expect(ultracodeActive(runtime.config, runtime.resolve())).toBe(!proactive);
  }
});

test("server initialization and legacy normalization freeze defaults without changing other servers", async () => {
  const runtime = new Runtime(loadConfig({ LLM_TEMPERATURE: "1.2", JEV_ENABLED: "false", RUNTIME_STATE_PATH: "" }));
  await runtime.initializeGuild("100");
  expect(runtime.snapshot.guilds["100"]?.temperature).toBe(1.2);
  runtime.config.temperature = 0.2;
  runtime.config.jevEnabled = true;
  await runtime.initializeGuild("100");
  await runtime.initializeGuild("200");
  expect(runtime.resolve("100").temperature).toBe(1.2);
  expect(runtime.resolve("100").jev_enabled).toBe(false);
  expect(runtime.resolve("200").temperature).toBe(0.2);
  runtime.replace({ guilds: { "300": { selection: null, temperature: null } as never }, user_overrides: { "400": { jev_enabled: null } as never } });
  const saved = structuredClone(runtime.snapshot);
  runtime.config.temperature = 0.9;
  runtime.config.jevEnabled = false;
  runtime.replace(saved);
  expect(runtime.resolve("300").temperature).toBe(0.2);
  expect(runtime.resolve("300", "400").jev_enabled).toBe(true);
});

test("legacy state preserves global defaults and strips retired settings", async () => {
  const { migrateState } = await import("../../../../scripts/migrate-state");
  const snapshot = migrateState({
    provider: "deepseek",
    model: "deepseek-flash",
    effort: "high",
    temperature: 0,
    fast_enabled: true,
    verify_enabled: true,
    harness: "claude",
    router_enabled: true,
    advisor: "sol",
    guilds: { "100": { temperature: 1, router_enabled: true } },
    user_overrides: { "300": { advisor: "sol" } },
  });
  const runtime = new Runtime(config());
  runtime.replace(snapshot);
  expect(runtime.resolve().selection.provider).toBe("deepseek");
  expect(runtime.resolve("100").temperature).toBe(1);
  expect(runtime.resolve("101").temperature).toBe(0);
  expect("fast_enabled" in runtime.resolve()).toBe(false);
  expect("verify_enabled" in runtime.resolve()).toBe(false);
  expect(JSON.stringify(snapshot)).not.toMatch(
    /advisor|router_enabled|harness|fast_enabled|verify_enabled/,
  );
});

test("VPN credential extraction ignores account passwords and rejects newline injection", async () => {
  const { extractServiceCredentials } = await import("../tools/vpn");
  expect(
    extractServiceCredentials({ username: "account", password: "secret" }),
  ).toBeUndefined();
  expect(
    extractServiceCredentials({
      data: [
        {
          service: {
            credentials: { username: " vpn-user ", password: "vpn-pass" },
          },
        },
      ],
    }),
  ).toEqual({ username: "vpn-user", password: "vpn-pass" });
  expect(
    extractServiceCredentials({
      credentials: { username: "user\nother", password: "pass" },
    }),
  ).toBeUndefined();
});

test("workspace expiry skips an active scope and preserves recently used work", async () => {
  const { utimes } = await import("node:fs/promises");
  const dir = await mkdtemp(join(tmpdir(), "hibana-expiry-"));
  try {
    const sandbox = new Sandbox(
      loadConfig({ HIBANA_DATA_DIR: dir, SANDBOX_TTL_HOURS: "1" }),
    );
    const old = await sandbox.root(ctx),
      recent = await sandbox.root({ ...ctx, thread: true });
    await utimes(old, new Date(0), new Date(0));
    const release = sandbox.lease(ctx);
    await sandbox.sweep();
    expect(await Bun.file(join(old, "missing")).exists()).toBe(false);
    expect(
      await import("node:fs/promises").then((fs) =>
        fs.stat(old).then((s) => s.isDirectory()),
      ),
    ).toBe(true);
    release();
    await sandbox.sweep();
    expect(
      await import("node:fs/promises").then((fs) =>
        fs
          .stat(old)
          .then(() => true)
          .catch(() => false),
      ),
    ).toBe(false);
    expect(
      await import("node:fs/promises").then((fs) =>
        fs.stat(recent).then((s) => s.isDirectory()),
      ),
    ).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("VPN proxy tunnels only to a validated public address", async () => {
  const { createServer } = await import("node:http");
  const { publicFetch, setPublicProxy } = await import("../network");
  const targets: string[] = [];
  const proxy = createServer();
  proxy.on("connect", (request, socket) => {
    targets.push(request.url!);
    socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
    socket.once("data", () =>
      socket.end(
        "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok",
      ),
    );
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  setPublicProxy((proxy.address() as { port: number }).port);
  try {
    expect(await (await publicFetch("http://1.1.1.1/test")).text()).toBe("ok");
    await expect(publicFetch("http://127.0.0.1/private")).rejects.toThrow();
    expect(targets).toEqual(["1.1.1.1:80"]);
  } finally {
    setPublicProxy();
    await new Promise<void>((resolve, reject) =>
      proxy.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("site updates preserve URLs, enforce quotas and expire independently of workspaces", async () => {
  const { Sites } = await import("../tools/sites");
  const dir = await mkdtemp(join(tmpdir(), "hibana-sites-"));
  const c = loadConfig({
    HIBANA_DATA_DIR: dir,
    STATIC_SITE_ENABLED: "true",
    STATIC_SITE_BASE_URL: "https://sites.example.com",
    STATIC_SITE_BIND: "127.0.0.1:0",
    STATIC_SITE_MAX_SITES_PER_GUILD: "1",
  });
  const sandbox = new Sandbox(c),
    sites = new Sites(c, sandbox);
  try {
    await sites.load();
    await sites.start();
    await sandbox.write(ctx, "public/index.html", "first");
    const first = await sites.publish(ctx, "public");
    expect(await (await sites.serve(new Request(first.url))).text()).toBe(
      "first",
    );
    await expect(sites.publish(ctx, "public")).rejects.toThrow("quota");
    await sandbox.write(ctx, "public/index.html", "second");
    const second = await sites.publish(ctx, "public", first.token);
    expect(second.url).toBe(first.url);
    expect(second.directory).not.toBe(first.directory);
    expect(await (await sites.serve(new Request(first.url))).text()).toBe(
      "second",
    );
    expect(
      await Bun.file(join(sites.root, first.directory!, "index.html")).exists(),
    ).toBe(false);
    sites.list()[0]!.expires_at_unix = 1;
    await sites.sweep();
    expect(sites.list()).toEqual([]);
    expect((await sites.serve(new Request(first.url))).status).toBe(404);
    expect((await sandbox.read(ctx, "public/index.html")).content).toBe(
      "second",
    );
  } finally {
    sites.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Ultra mode and effort resolve independently across guild, user, DM and legacy env", async () => {
  const runtime = new Runtime(loadConfig({ LLM_EFFORT: "ultra", RUNTIME_STATE_PATH: "" }));
  expect(runtime.resolve().selection.effort).toBe("max");
  expect(runtime.resolve().ultra_mode).toBe(true);
  await runtime.patch("100", { effort: "low" }, "300");
  expect(runtime.resolve("100").selection.effort).toBe("low");
  expect(runtime.resolve("100").ultra_mode).toBe(true);
  await runtime.patch("100", { ultra_mode: false }, "300");
  expect(runtime.resolve("100").selection.effort).toBe("low");
  runtime.snapshot.user_overrides["300"] = { ...emptyUserOverride(), ultra_mode: true, effort: "medium" };
  expect(runtime.resolve("100", "300").ultra_mode).toBe(true);
  expect(runtime.resolve("100", "300").selection.effort).toBe("medium");
  expect(runtime.resolve("100", "301").ultra_mode).toBe(false);
  expect(runtime.resolve("101", "301").selection.effort).toBe("max");
  expect(runtime.resolve(undefined, "300").selection.effort).toBe("medium");
  // Ultracode runs the turn at xhigh without rewriting the stored effort, so
  // leaving Ultra restores medium/low/max per scope.
  const turn = (guild?: string, user?: string) => {
    const settings = runtime.resolve(guild, user);
    return turnSelection(settings.selection, ultracodeActive(runtime.config, settings)).effort;
  };
  expect([turn("100", "300"), turn("100", "301"), turn("101", "301"), turn(undefined, "300")])
    .toEqual(["xhigh", "low", "xhigh", "xhigh"]);
  runtime.config.subagentEnabled = false;
  expect(turn("100", "300")).toBe("medium");
  runtime.config.subagentEnabled = true;
  const prompt = await assemblePrompt(runtime, ctx, "");
  expect(prompt[1]?.content).toContain("Do not spawn sub-agents");
  expect(loadConfig({ LLM_EFFORT: "ultra", ULTRA_MODE: "false" }).ultraMode).toBe(false);
  expect(loadConfig({ LLM_EFFORT: "low", ULTRA_MODE: "true" }).selection.effort).toBe("low");
});

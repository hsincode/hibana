import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config";
import { ImageTools } from "../tools/image";
import { Sandbox } from "../tools/sandbox";
import { namespaced } from "../harness";
import definitions from "../tools/definitions.json";
import { Runtime } from "../runtime";
import { ToolRegistry } from "../tools";
import type { Context, ToolDef } from "../types";

const token = "test-secret-".repeat(4);
const ctx: Context = { guildId: "100", channelId: "200", userId: "300", botId: "400", thread: false, depth: 0, delivered: false };
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2]);
async function fixture(handler: (request: Request) => Response | Promise<Response>) {
  const root = await mkdtemp(join(tmpdir(), "hibana-image-"));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  const config = loadConfig({ IMAGE_WORKER_URL: `http://127.0.0.1:${server.port}`, IMAGE_WORKER_TOKEN: token, SANDBOX_WORKSPACE_ROOT: root });
  const sandbox = new Sandbox(config);
  return { config, sandbox, images: new ImageTools(config, sandbox), close: async () => { server.stop(true); await rm(root, { recursive: true, force: true }); } };
}

describe("local image worker", () => {
  test("endpoint must be administrator-owned loopback with credentials", () => {
    for (const url of ["http://example.com", "https://127.0.0.1", "http://127.0.0.1/path", "http://user:pass@127.0.0.1", "http://127.0.0.1?key=a"])
      expect(() => loadConfig({ IMAGE_WORKER_URL: url, IMAGE_WORKER_TOKEN: token })).toThrow();
    expect(() => loadConfig({ IMAGE_WORKER_URL: "http://127.0.0.1:18190" })).toThrow();
    for (const name of ["generate_image", "edit_image", "image_generation_status"])
      expect(namespaced(definitions.find((d) => d.function.name === name)! as ToolDef).function.name).toBe(`mcp__workspace__${name}`);
  });
  test("registry exposes configured tools and enforces disabled and blocked contexts", async () => {
    const runtime = new Runtime(loadConfig({ IMAGE_WORKER_URL: "http://127.0.0.1:18190", IMAGE_WORKER_TOKEN: token }));
    const registry = new ToolRegistry(runtime, {} as never, {} as never);
    registry.sandbox.available = true;
    const exposed = () => registry.tools(ctx).some((t) => t.function.name === "mcp__workspace__generate_image");
    expect(exposed()).toBe(true);
    runtime.config.imageWorkerUrl = "";
    expect(exposed()).toBe(false);
    await expect(registry.execute("mcp__workspace__generate_image", { prompt: "panda" }, ctx)).rejects.toThrow("disabled");
    runtime.config.imageWorkerUrl = "http://127.0.0.1:18190";
    await expect(registry.execute("mcp__workspace__generate_image", { prompt: "panda", width: 513 }, ctx)).rejects.toThrow("Invalid arguments");
    runtime.snapshot.blocked_users = [ctx.userId];
    await expect(registry.execute("mcp__workspace__generate_image", { prompt: "panda" }, ctx)).rejects.toThrow("disabled");
  });
  test("authenticated generation saves only in caller scope", async () => {
    let calls = 0;
    const f = await fixture(async (request) => {
      expect(request.headers.get("authorization")).toBe(`Bearer ${token}`);
      expect(await request.json()).toEqual({ prompt: "a red panda" });
      calls++;
      return new Response(png, { headers: { "Content-Type": "image/png" } });
    });
    try {
      const result = await f.images.generate({ prompt: "a red panda" }, ctx);
      expect(await readFile(await f.sandbox.path(ctx, result.path))).toEqual(png);
      const dm = { ...ctx, guildId: undefined };
      expect(await Bun.file(await f.sandbox.path(dm, result.path)).exists()).toBe(false);
      expect(calls).toBe(1);
      expect(ctx.delivered).toBe(false);
    } finally { await f.close(); }
  });
  test("edit uploads only a bounded file from the caller workspace", async () => {
    let calls = 0;
    const f = await fixture(async (request) => {
      expect(new URL(request.url).pathname).toBe("/edit");
      expect(request.headers.get("authorization")).toBe(`Bearer ${token}`);
      expect(await request.json()).toEqual({ prompt: "make the teapot blue", image_base64: png.toString("base64"), resolution: 512 });
      calls++;
      return new Response(png, { headers: { "Content-Type": "image/png" } });
    });
    try {
      await writeFile(await f.sandbox.path(ctx, "source.png"), png);
      const edited = await f.images.edit({ prompt: "make the teapot blue", image_path: "source.png", resolution: 512 }, ctx);
      expect(await readFile(await f.sandbox.path(ctx, edited.path))).toEqual(png);
      expect(await readFile(await f.sandbox.path(ctx, "source.png"))).toEqual(png);
      for (const image_path of ["../source.png", "/etc/passwd"])
        await expect(f.images.edit({ prompt: "edit", image_path }, ctx)).rejects.toThrow();
      await symlink("/etc/passwd", join(await f.sandbox.root(ctx), "escape.png"));
      await expect(f.images.edit({ prompt: "edit", image_path: "escape.png" }, ctx)).rejects.toThrow();
      await expect(f.images.edit({ prompt: "edit", image_path: "source.png" }, { ...ctx, guildId: "101" })).rejects.toThrow();
      await expect(f.images.edit({ prompt: "edit", image_path: "source.png", image_index: 0 }, ctx)).rejects.toThrow();
      await writeFile(await f.sandbox.path(ctx, "large.png"), Buffer.alloc(16 * 1024 * 1024 + 1));
      await expect(f.images.edit({ prompt: "edit", image_path: "large.png" }, ctx)).rejects.toThrow("16 MiB");
      expect(calls).toBe(1);
    } finally { await f.close(); }
  });
  test("attachment selection fails before contacting worker when absent or private", async () => {
    let calls = 0;
    const f = await fixture(() => { calls++; return new Response(png); });
    try {
      await expect(f.images.edit({ prompt: "edit" }, ctx)).rejects.toThrow("No image attached");
      await expect(f.images.edit({ prompt: "edit", image_index: 1 }, { ...ctx, images: ["https://example.com/image.png"] })).rejects.toThrow("No image attached");
      await expect(f.images.edit({ prompt: "edit" }, { ...ctx, images: ["http://127.0.0.1/private.png"] })).rejects.toThrow();
      expect(calls).toBe(0);
    } finally { await f.close(); }
  });
  test("offline status returns promptly and generation does not retry", async () => {
    const f = await fixture(() => new Response());
    await f.close();
    expect((await f.images.status(ctx)).online).toBe(false);
    await expect(f.images.generate({ prompt: "panda" }, ctx)).rejects.toThrow("offline");
  });
  test("busy response and redirects are not retried", async () => {
    for (const status of [409, 302]) {
      let calls = 0;
      const f = await fixture(() => { calls++; return new Response(null, { status, headers: { Location: "http://127.0.0.1:1" } }); });
      try {
        await expect(f.images.generate({ prompt: "panda" }, ctx)).rejects.toThrow();
        expect(calls).toBe(1);
      } finally { await f.close(); }
    }
  });
  test("rejects non-PNG, oversized response and quota overflow", async () => {
    for (const mode of ["invalid", "oversize", "quota"]) {
      const f = await fixture(() => new Response(mode === "invalid" ? "not PNG" : mode === "oversize" ? Buffer.alloc(17 * 1024 * 1024) : png, { headers: { "Content-Type": "image/png", ...(mode === "oversize" ? { "Content-Length": String(17 * 1024 * 1024) } : {}) } }));
      if (mode === "quota") f.config.workspaceMaxBytes = 1;
      try { await expect(f.images.generate({ prompt: "panda" }, ctx)).rejects.toThrow(); }
      finally { await f.close(); }
    }
  });
});

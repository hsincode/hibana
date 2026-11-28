import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config";
import { Runtime } from "../runtime";
import { WebSync } from "../sync";
import { Sandbox, processRun } from "../tools/sandbox";
import { Sites } from "../tools/sites";
import { WorkspaceExporter } from "../workspace-export";

const dirs: string[] = [];
const stops: (() => void)[] = [];

afterEach(async () => {
  while (stops.length) stops.pop()!();
  while (dirs.length)
    await rm(dirs.pop()!, { recursive: true, force: true }).catch(() => {});
});

async function makeFixture(
  envOverrides: Record<string, string> = {},
  exporterOpts: ConstructorParameters<typeof WorkspaceExporter>[4] = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "hibana-export-test-"));
  dirs.push(dir);
  const config = loadConfig({
    HIBANA_DATA_DIR: dir,
    SANDBOX_ENABLED: "false",
    STATIC_SITE_ENABLED: "true",
    STATIC_SITE_BIND: "127.0.0.1:0",
    STATIC_SITE_BASE_URL: "https://sites.example.com",
    ...envOverrides,
  });
  const runtime = new Runtime(config);
  const sandbox = new Sandbox(config);
  const sites = new Sites(config, sandbox);
  const exporter = new WorkspaceExporter(
    config,
    runtime,
    sandbox,
    sites,
    exporterOpts,
  );
  sites.setExportLookup((token) => exporter.lookup(token));
  await sites.load();
  await exporter.load();
  await sites.start();
  stops.push(() => {
    exporter.stop();
    sites.stop();
  });
  return { dir, config, runtime, sandbox, sites, exporter };
}

async function listTar(archivePath: string): Promise<string[]> {
  const r = await processRun("tar", ["-tzf", archivePath], { timeout: 10_000 });
  expect(r.exit_code).toBe(0);
  return r.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .sort();
}

describe("WorkspaceExporter (#193)", () => {
  test("archives only the target guild workspace, skips symlinks and other scopes", async () => {
    const { dir, config, sites, exporter } = await makeFixture();

    const g1 = join(config.workspaceRoot, "guilds", "101");
    const g2 = join(config.workspaceRoot, "guilds", "202");
    const threadDir = join(config.workspaceRoot, "threads", "303");
    const ghAuth = join(config.dataDir, "gh-auth", "guilds", "101");
    const outsideSecret = join(dir, "secret.txt");

    await mkdir(join(g1, "sub"), { recursive: true });
    await mkdir(g2, { recursive: true });
    await mkdir(threadDir, { recursive: true });
    await mkdir(ghAuth, { recursive: true });

    await writeFile(join(g1, "hello.txt"), "hello guild 101");
    await writeFile(join(g1, "sub", "data.json"), '{"ok":true}');
    await writeFile(join(g2, "other.txt"), "guild 202 secret");
    await writeFile(join(threadDir, "thread.txt"), "thread file");
    await writeFile(join(ghAuth, "hosts.yml"), "oauth_token: gho_secret");
    await writeFile(outsideSecret, "do not leak");
    await symlink(outsideSecret, join(g1, "link-file.txt"));
    await symlink(g2, join(g1, "link-dir"));

    const result = await exporter.create("101", false);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");

    expect(result.file_count).toBe(2);
    expect(result.includes_settings).toBe(false);
    expect(result.url).toMatch(
      /^https:\/\/sites\.example\.com\/dl\/[a-f0-9]{48}\/hibana-workspace-101-.*\.tar\.gz$/,
    );

    const token = result.url.split("/dl/")[1]!.split("/")[0]!;
    const entry = exporter.lookup(token)!;
    expect(entry).toBeDefined();

    const members = await listTar(entry.filePath);
    expect(members).toEqual(["workspace/hello.txt", "workspace/sub/data.json"]);

    // Verify serving via Sites.serve() with security headers and exact bytes.
    const res = await sites.serve(new Request(result.url));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/gzip");
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="${result.filename}"`,
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-security-policy")).toBe(
      "default-src 'none'; sandbox",
    );
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.length).toBe(result.bytes);

    // HEAD works, POST is rejected.
    expect(
      (await sites.serve(new Request(result.url, { method: "HEAD" }))).status,
    ).toBe(200);
    expect(
      (await sites.serve(new Request(result.url, { method: "POST" }))).status,
    ).toBe(405);
  });

  test("includes settings.json without colliding with workspace/settings.json", async () => {
    const { config, runtime, exporter } = await makeFixture();
    runtime.snapshot.guilds["101"] = {
      ...runtime.defaultSettings(),
      thread_only: true,
    };

    const g1 = join(config.workspaceRoot, "guilds", "101");
    await mkdir(g1, { recursive: true });
    await writeFile(join(g1, "settings.json"), '{"from":"workspace"}');

    const result = await exporter.create("101", true);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.file_count).toBe(2);
    expect(result.includes_settings).toBe(true);

    const token = result.url.split("/dl/")[1]!.split("/")[0]!;
    const entry = exporter.lookup(token)!;
    const members = await listTar(entry.filePath);
    expect(members).toEqual(["settings.json", "workspace/settings.json"]);

    // Verify both files have their distinct contents.
    const extractDir = join(config.dataDir, "extracted");
    await mkdir(extractDir, { recursive: true });
    const ex = await processRun(
      "tar",
      ["-xzf", entry.filePath, "-C", extractDir],
      { timeout: 10_000 },
    );
    expect(ex.exit_code).toBe(0);
    const rootSettings = JSON.parse(
      await Bun.file(join(extractDir, "settings.json")).text(),
    ) as { guild_id: string; settings: { thread_only: boolean } };
    expect(rootSettings.guild_id).toBe("101");
    expect(rootSettings.settings.thread_only).toBe(true);
    expect(
      await Bun.file(join(extractDir, "workspace", "settings.json")).text(),
    ).toBe('{"from":"workspace"}');
  });

  test("handles empty workspace depending on include_settings", async () => {
    const { exporter } = await makeFixture();
    await expect(exporter.create("101", false)).rejects.toThrow(
      "ファイルがありません",
    );

    const withSettings = await exporter.create("101", true);
    expect(withSettings.ok).toBe(true);
    if (!withSettings.ok) throw new Error("expected ok");
    expect(withSettings.file_count).toBe(1);
    const token = withSettings.url.split("/dl/")[1]!.split("/")[0]!;
    const entry = exporter.lookup(token)!;
    expect(await listTar(entry.filePath)).toEqual(["settings.json"]);
  });

  test("serves per-token origin URLs when STATIC_SITE_ORIGIN_TEMPLATE is set", async () => {
    const { config, sites, exporter } = await makeFixture({
      STATIC_SITE_ORIGIN_TEMPLATE: "https://{token}.sites.example.com",
    });
    const g1 = join(config.workspaceRoot, "guilds", "101");
    await mkdir(g1, { recursive: true });
    await writeFile(join(g1, "note.txt"), "per-origin");

    const result = await exporter.create("101", false);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.url).toMatch(
      /^https:\/\/[a-f0-9]{48}\.sites\.example\.com\/hibana-workspace-101-.*\.tar\.gz$/,
    );

    const res = await sites.serve(new Request(result.url));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/gzip");
  });

  test("enforces raw size cap, compressed size cap, total cap eviction, and TTL expiry", async () => {
    let clock = 1_780_000_000_000;
    const { config, sites, exporter } = await makeFixture(
      {},
      {
        maxRawBytes: 50_000,
        maxArchiveBytes: 10_000,
        maxTotalBytes: 15_000,
        ttlMs: 60_000,
        now: () => clock,
      },
    );

    const g1 = join(config.workspaceRoot, "guilds", "101");
    await mkdir(g1, { recursive: true });

    // Exceeds raw cap -> fails before tar runs.
    await writeFile(join(g1, "big.bin"), randomBytes(60_000));
    await expect(exporter.create("101", false)).rejects.toThrow("上限");

    // Fits raw cap (20 KB incompressible random bytes) but exceeds compressed cap (10 KB).
    await writeFile(join(g1, "big.bin"), randomBytes(20_000));
    await expect(exporter.create("101", false)).rejects.toThrow("上限");
    // No temp files left behind.
    expect(await readdir(exporter.root)).toEqual([]);

    // Fits compressed cap (~8 KB incompressible). Creating a second one evicts the first (total cap 15 KB).
    await writeFile(join(g1, "big.bin"), randomBytes(8_000));
    const first = await exporter.create("101", false);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("expected ok");

    clock += 1_000;
    const second = await exporter.create("101", false);
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("expected ok");

    expect((await sites.serve(new Request(first.url))).status).toBe(404);
    expect((await sites.serve(new Request(second.url))).status).toBe(200);

    // After TTL passes, lookup and serve return 404 and sweep removes the file.
    clock += 60_001;
    await exporter.sweep();
    expect((await sites.serve(new Request(second.url))).status).toBe(404);
    expect(await readdir(exporter.root)).toEqual([]);
  });

  test("fails cleanly when static site hosting is disabled", async () => {
    const { exporter } = await makeFixture({
      STATIC_SITE_ENABLED: "false",
    });
    await expect(exporter.create("101", true)).rejects.toThrow("静的配信");
  });

  test("WebSync.pull executes workspace_export_commands and posts /internal/exports/ack", async () => {
    const { config, runtime, exporter } = await makeFixture({
      WEB_API_URL: "https://api.example.com",
      WEB_INTERNAL_TOKEN: "secret-token",
    });
    const g1 = join(config.workspaceRoot, "guilds", "101");
    await mkdir(g1, { recursive: true });
    await writeFile(join(g1, "a.txt"), "hello");

    const acked: { path: string; body: unknown }[] = [];
    runtime.remote = async (path, _method, body) => {
      acked.push({ path, body });
      return { ok: true };
    };

    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          version: 5,
          guilds: {},
          user_contexts: {},
          user_overrides: {},
          blocked_users: [],
          user_roles: {},
          unpublished_presets: [],
          premium_presets: [],
          artifact_commands: [],
          skill_commands: [],
          workspace_export_commands: [
            {
              id: 42,
              guild_id: "101",
              include_settings: false,
              created_at: Date.now(),
              result: null,
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;

    try {
      const sync = new WebSync(
        runtime,
        {
          exports: exporter,
          sites: { list: () => [] },
          skills: { export: async () => [] },
        } as never,
        () => {},
      );
      await sync.pull();
    } finally {
      globalThis.fetch = origFetch;
    }

    const exportAck = acked.find((a) => a.path === "/internal/exports/ack");
    expect(exportAck).toBeDefined();
    const payload = exportAck!.body as {
      id: number;
      result: { ok: boolean; file_count?: number; url?: string };
    };
    expect(payload.id).toBe(42);
    expect(payload.result.ok).toBe(true);
    expect(payload.result.file_count).toBe(1);
    expect(payload.result.url).toContain("hibana-workspace-101-");
  });
});

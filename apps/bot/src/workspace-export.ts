import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { lstat, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  WORKSPACE_EXPORT_MAX_ARCHIVE_BYTES,
  WORKSPACE_EXPORT_MAX_FILES,
  WORKSPACE_EXPORT_MAX_RAW_BYTES,
  WORKSPACE_EXPORT_TOTAL_MAX_BYTES,
  WORKSPACE_EXPORT_TTL_MS,
  type WorkspaceExportResult,
} from "@hibana/shared/exports";
import type { Config } from "./config";
import type { Runtime } from "./runtime";
import { Serial } from "./io";
import { safePath, type Sandbox } from "./tools/sandbox";
import type { Sites } from "./tools/sites";

const GUILD_ID = /^[1-9][0-9]{0,19}$/;
const TAR_TIMEOUT_MS = 5 * 60 * 1000;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export type ExportEntry = {
  token: string;
  guildId: string;
  filename: string;
  filePath: string;
  bytes: number;
  fileCount: number;
  createdAt: number;
  expiresAt: number;
};

export type WorkspaceExporterOptions = {
  maxRawBytes?: number;
  maxArchiveBytes?: number;
  maxTotalBytes?: number;
  maxFiles?: number;
  ttlMs?: number;
  tarTimeoutMs?: number;
  now?: () => number;
};

function formatMb(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${Math.round((mb / 1024) * 10) / 10} GB`;
  return `${Math.round(mb * 10) / 10} MB`;
}

/**
 * Walks a guild workspace directory and collects regular files only.
 * Symlinks (both files and directories) are always skipped and never followed.
 */
async function collectRegularFiles(
  root: string,
  maxFiles: number,
  maxRawBytes: number,
): Promise<{ paths: string[]; rawBytes: number }> {
  const paths: string[] = [];
  let rawBytes = 0;

  const walk = async (dir: string) => {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = join(dir, entry.name);
      const st = await lstat(full).catch(() => null);
      if (!st || st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        await walk(full);
      } else if (st.isFile()) {
        if (paths.length >= maxFiles) {
          throw new Error(
            `ファイル数が上限（${maxFiles.toLocaleString()} 件）を超えています。`,
          );
        }
        rawBytes += st.size;
        if (rawBytes > maxRawBytes) {
          throw new Error(
            `ワークスペースの合計サイズが上限（${formatMb(maxRawBytes)}）を超えています。`,
          );
        }
        const rel = relative(root, full).replaceAll("\\", "/");
        if (
          !rel ||
          rel === ".." ||
          rel.startsWith("../") ||
          rel.startsWith("/") ||
          rel.includes("\0")
        )
          continue;
        paths.push(rel);
      }
    }
  };

  try {
    const rootStat = await lstat(root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      return { paths: [], rawBytes: 0 };
    }
    await walk(root);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }

  return { paths, rawBytes };
}

/**
 * Runs GNU tar to stream a `.tar.gz` archive to `outputPath` while enforcing a
 * hard compressed-size cap so disk usage never exceeds `maxArchiveBytes`.
 */
async function buildTarGz(
  args: string[],
  outputPath: string,
  maxArchiveBytes: number,
  timeoutMs: number,
): Promise<number> {
  return new Promise<number>((resolveBytes, reject) => {
    const child = spawn("tar", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out = createWriteStream(outputPath, { mode: 0o600 });
    let bytes = 0;
    let stderr = "";
    let failed: Error | null = null;
    let settled = false;

    const fail = (err: Error) => {
      if (!failed) failed = err;
      try {
        child.kill("SIGKILL");
      } catch {}
      out.destroy();
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (failed) {
        reject(failed);
      } else {
        resolveBytes(bytes);
      }
    };

    const timer = setTimeout(() => {
      fail(new Error("アーカイブの作成がタイムアウトしました。"));
    }, timeoutMs);

    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 2000) stderr += chunk.toString("utf8");
    });

    child.stdout.on("data", (chunk: Buffer) => {
      if (failed) return;
      bytes += chunk.length;
      if (bytes > maxArchiveBytes) {
        fail(
          new Error(
            `圧縮後のサイズが上限（${formatMb(maxArchiveBytes)}）を超えています。`,
          ),
        );
        return;
      }
      if (!out.write(chunk)) {
        child.stdout.pause();
        out.once("drain", () => {
          if (!failed) child.stdout.resume();
        });
      }
    });

    child.on("error", (err) => fail(err));
    out.on("error", (err) => fail(err));

    let childClosed = false;
    let exitCode: number | null = null;
    let streamClosed = false;

    const maybeDone = () => {
      if (!childClosed || !streamClosed) return;
      if (!failed && exitCode !== 0) {
        failed = new Error(
          `アーカイブの作成に失敗しました（tar exit ${exitCode ?? "unknown"}${stderr.trim() ? `: ${stderr.trim().slice(0, 200)}` : ""}）。`,
        );
      }
      finish();
    };

    child.stdout.on("end", () => {
      if (!failed) out.end();
    });

    out.on("close", () => {
      streamClosed = true;
      maybeDone();
    });

    child.on("close", (code) => {
      childClosed = true;
      exitCode = code;
      if (failed) {
        streamClosed = true;
      }
      maybeDone();
    });
  });
}

/**
 * Packages a guild's local Docker sandbox workspace (and optionally its server
 * settings JSON) into a short-lived `.tar.gz` served by `Sites` (#193).
 */
export class WorkspaceExporter {
  readonly root: string;
  /** Strictly one export runs at a time across the whole bot (#193). */
  private serial = new Serial();
  private entries = new Map<string, ExportEntry>();
  private timer?: ReturnType<typeof setInterval>;

  private readonly maxRawBytes: number;
  private readonly maxArchiveBytes: number;
  private readonly maxTotalBytes: number;
  private readonly maxFiles: number;
  private readonly ttlMs: number;
  private readonly tarTimeoutMs: number;
  private readonly now: () => number;

  constructor(
    private config: Config,
    private runtime: Runtime,
    private sandbox: Sandbox,
    private sites: Sites,
    options: WorkspaceExporterOptions = {},
  ) {
    this.root = join(config.dataDir, "exports");
    this.maxRawBytes = options.maxRawBytes ?? WORKSPACE_EXPORT_MAX_RAW_BYTES;
    this.maxArchiveBytes =
      options.maxArchiveBytes ?? WORKSPACE_EXPORT_MAX_ARCHIVE_BYTES;
    this.maxTotalBytes =
      options.maxTotalBytes ?? WORKSPACE_EXPORT_TOTAL_MAX_BYTES;
    this.maxFiles = options.maxFiles ?? WORKSPACE_EXPORT_MAX_FILES;
    this.ttlMs = options.ttlMs ?? WORKSPACE_EXPORT_TTL_MS;
    this.tarTimeoutMs = options.tarTimeoutMs ?? TAR_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
  }

  /** Clears leftover ephemeral exports from a previous process and starts TTL cleanup. */
  async load() {
    this.entries.clear();
    await rm(this.root, { recursive: true, force: true });
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    this.timer = setInterval(() => {
      void this.sweep().catch(() => {});
    }, SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Removes expired archive files from memory and disk. */
  async sweep() {
    const now = this.now();
    const expired: ExportEntry[] = [];
    for (const [token, entry] of this.entries) {
      if (now >= entry.expiresAt) {
        this.entries.delete(token);
        expired.push(entry);
      }
    }
    await Promise.all(
      expired.map((e) => rm(e.filePath, { force: true }).catch(() => {})),
    );
  }

  /** Looks up a live download token for `Sites.serve`. */
  lookup(token: string): ExportEntry | undefined {
    const entry = this.entries.get(token);
    if (!entry) return undefined;
    if (this.now() >= entry.expiresAt) {
      this.entries.delete(token);
      void rm(entry.filePath, { force: true }).catch(() => {});
      return undefined;
    }
    return entry;
  }

  /**
   * Builds a `.tar.gz` archive of `workspaces/guilds/<guildId>/` and registers
   * a short-lived download token. Never includes thread workspaces, skills,
   * scheduled assets, artifacts, conversation history, `gh-auth`, or symlinks.
   */
  async create(
    guildId: string,
    includeSettings: boolean,
  ): Promise<WorkspaceExportResult> {
    if (!GUILD_ID.test(guildId)) {
      throw new Error("サーバー ID が不正です。");
    }
    if (!this.sites.serving) {
      throw new Error(
        "静的配信サーバーが無効なため、ダウンロード URL を発行できません。",
      );
    }

    return this.serial.run(async () => {
      await this.sweep();
      await mkdir(this.root, { recursive: true, mode: 0o700 });

      // Hold a sandbox lease while reading so workspace TTL sweep cannot drop files mid-archive.
      const release = this.sandbox.lease({
        guildId,
        channelId: guildId,
        userId: "0",
        botId: "0",
        thread: false,
        depth: 0,
        delivered: false,
      });

      // 48 hex chars (192 bits) fits safely within a 63-char DNS label for per-token origins.
      const token = randomBytes(24).toString("hex");
      const createdAt = this.now();
      const stamp = new Date(createdAt)
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(/\.\d+Z$/, "Z");
      const filename = `hibana-workspace-${guildId}-${stamp}.tar.gz`;
      const stagingDir = join(this.root, `.staging-${token}`);
      const tmpArchive = join(this.root, `.archive-${token}.tar.gz.tmp`);
      const finalPath = join(this.root, `${token}.tar.gz`);

      try {
        const workspaceDir = await safePath(
          this.config.workspaceRoot,
          `guilds/${guildId}`,
        );
        const { paths } = await collectRegularFiles(
          workspaceDir,
          this.maxFiles,
          this.maxRawBytes,
        );

        if (paths.length === 0 && !includeSettings) {
          throw new Error(
            "このサーバーのワークスペースにファイルがありません。",
          );
        }

        await mkdir(stagingDir, { recursive: true, mode: 0o700 });

        const tarArgs: string[] = ["-czf", "-", "--no-recursion"];
        let fileCount = paths.length;

        if (includeSettings) {
          // Only export this server's settings; never global state, DM contexts, or credentials.
          const settingsPayload = JSON.stringify(
            {
              guild_id: guildId,
              exported_at: new Date(createdAt).toISOString(),
              settings: this.runtime.guild(guildId),
            },
            null,
            2,
          );
          if (paths.length === 0) {
            await writeFile(
              join(stagingDir, "settings.json"),
              settingsPayload,
              {
                mode: 0o600,
              },
            );
            tarArgs.push("-C", stagingDir, "settings.json");
          } else {
            // Use a token-unique sentinel name so a workspace file named `settings.json`
            // maps to `workspace/settings.json` without colliding with the root `settings.json`.
            const sentinel = `__hibana_settings_${token}__.json`;
            const listPath = join(stagingDir, "files.list");
            await writeFile(join(stagingDir, sentinel), settingsPayload, {
              mode: 0o600,
            });
            await writeFile(listPath, `${paths.join("\0")}\0`, { mode: 0o600 });
            tarArgs.push(
              `--transform=s,^,workspace/,;s,^workspace/${sentinel.replaceAll(".", "\\.")}$,settings.json,`,
              "-C",
              workspaceDir,
              "--null",
              "-T",
              listPath,
              "-C",
              stagingDir,
              sentinel,
            );
          }
          fileCount += 1;
        } else {
          const listPath = join(stagingDir, "files.list");
          await writeFile(listPath, `${paths.join("\0")}\0`, { mode: 0o600 });
          tarArgs.push(
            "--transform=s,^,workspace/,",
            "-C",
            workspaceDir,
            "--null",
            "-T",
            listPath,
          );
        }

        const bytes = await buildTarGz(
          tarArgs,
          tmpArchive,
          this.maxArchiveBytes,
          this.tarTimeoutMs,
        );

        await this.ensureRoom(bytes);
        await rename(tmpArchive, finalPath);

        const finishedAt = this.now();
        const expiresAt = finishedAt + this.ttlMs;
        const entry: ExportEntry = {
          token,
          guildId,
          filename,
          filePath: finalPath,
          bytes,
          fileCount,
          createdAt: finishedAt,
          expiresAt,
        };
        this.entries.set(token, entry);

        return {
          ok: true,
          url: this.sites.exportUrl(token, filename),
          filename,
          bytes,
          file_count: fileCount,
          expires_at_unix: Math.floor(expiresAt / 1000),
          includes_settings: includeSettings,
        };
      } catch (e) {
        await rm(tmpArchive, { force: true }).catch(() => {});
        await rm(finalPath, { force: true }).catch(() => {});
        throw e;
      } finally {
        release();
        await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
      }
    });
  }

  /** Evicts oldest live exports until `additional` bytes fit under `maxTotalBytes`. */
  private async ensureRoom(additional: number) {
    await this.sweep();
    if (additional > this.maxTotalBytes) {
      throw new Error(
        `圧縮後のサイズが一時保管の上限（${formatMb(this.maxTotalBytes)}）を超えています。`,
      );
    }
    const ordered = [...this.entries.values()].sort(
      (a, b) => a.createdAt - b.createdAt,
    );
    let total = ordered.reduce((sum, e) => sum + e.bytes, 0);
    for (const oldest of ordered) {
      if (total + additional <= this.maxTotalBytes) break;
      this.entries.delete(oldest.token);
      await rm(oldest.filePath, { force: true }).catch(() => {});
      total -= oldest.bytes;
    }
  }
}

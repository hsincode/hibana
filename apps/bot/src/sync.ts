import { createHash } from "node:crypto";
import { Runtime, type Snapshot } from "./runtime";
import { ToolRegistry } from "./tools";
import { sleep, Serial } from "./io";
import type { Context } from "./types";

/**
 * How often the bot asks the settings API whether anything changed. An
 * unchanged snapshot answers 304 after one indexed read.
 *
 * The bot used to hold `/internal/events` (SSE) open instead. On Vercel an open
 * response keeps the function instance provisioned, so a stream that was always
 * connected was billed for memory around the clock (#27). A dashboard change
 * now reaches the bot within this interval instead of within seconds.
 */
export const SNAPSHOT_POLL_MS = 30_000;

/** Longest wait between attempts while the settings API keeps failing. */
export const SNAPSHOT_RETRY_MAX_MS = 300_000;

/** Wait before the next poll: the interval, doubled per consecutive failure. */
export function retryDelay(failures: number, pollMs: number, maxMs: number) {
  return Math.min(pollMs * 2 ** failures, maxMs);
}

const digest = (data: string | Uint8Array) =>
  createHash("sha256").update(data).digest("hex");

export class WebSync {
  private assetQueue = new Serial();
  private etag?: string;
  private abort = new AbortController();
  private queue = new Serial();
  /** Capabilities and assets reached the API since this process started. */
  private announced = false;
  /** Digests of the lists the API last accepted. */
  private published: { sites?: string; skills?: string } = {};
  constructor(
    private runtime: Runtime,
    private tools: ToolRegistry,
    private onError: (e: unknown) => void,
    private timing = { pollMs: SNAPSHOT_POLL_MS, maxMs: SNAPSHOT_RETRY_MAX_MS },
  ) {}
  async pull() {
    return this.queue.run(async () => {
      const c = this.runtime.config;
      if (!c.webApiUrl) return;
      const r = await fetch(c.webApiUrl + "/internal/snapshot", {
        headers: {
          Authorization: `Bearer ${c.internalToken}`,
          ...(this.etag ? { "If-None-Match": this.etag } : {}),
        },
        signal: AbortSignal.any([
          this.abort.signal,
          AbortSignal.timeout(30000),
        ]),
        redirect: "error",
      });
      if (r.status === 304) return;
      if (!r.ok) throw new Error(`Settings snapshot HTTP ${r.status}`);
      const snapshot = (await r.json()) as Snapshot;
      // The first snapshot this bot ever holds (none was restored from disk)
      // has nothing to differ from, so it is the baseline, not a change.
      this.runtime.replace(snapshot, this.runtime.snapshot.version !== undefined);
      this.etag = r.headers.get("etag") ?? undefined;
      await this.runtime.persist();
      for (const command of snapshot.artifact_commands ?? []) {
        await this.tools.sites.applyCommand(command);
        await this.runtime.remote("/internal/artifacts/ack", "POST", {
          ids: [command.id],
        });
      }
      for (const command of snapshot.skill_commands ?? []) {
        const ctx: Context = {
          guildId: command.guild_id,
          channelId: command.guild_id,
          userId: "0",
          botId: "0",
          thread: false,
          depth: 0,
          delivered: false,
        };
        let result: Record<string, unknown>;
        try {
          const name = (
            {
              create: "create_skill",
              delete: "delete_skill",
              enabled: "set_skill_enabled",
              import: "import_skill",
            } as Record<string, string>
          )[command.action];
          if (!name) throw new Error("Unknown skill command");
          result = (await this.tools.skills.execute(
            name,
            command.args,
            ctx,
          )) as Record<string, unknown>;
        } catch (e) {
          result = {
            ok: false,
            error: e instanceof Error ? e.message : String(e),
          };
        }
        await this.runtime.remote("/internal/skills/ack", "POST", {
          id: command.id,
          result,
        });
      }
      if (snapshot.skill_commands?.length || snapshot.artifact_commands?.length)
        await this.publishAssets();
    });
  }
  async publishAssets() {
    return this.assetQueue.run(async () => {
      if (!this.runtime.config.webApiUrl) return;
      // Runs after every turn, because a turn may publish a site or edit a
      // skill. Most turns change neither, so a list is uploaded only when it
      // differs from what the API last accepted.
      const sites = this.tools.sites.list();
      const sitesDigest = digest(JSON.stringify(sites));
      if (sitesDigest !== this.published.sites) {
        await this.runtime.remote("/internal/artifacts", "POST", { sites });
        this.published.sites = sitesDigest;
      }
      const catalog = await this.tools.skills.export(
        Object.keys(this.runtime.snapshot.guilds),
      );
      const bytes = Buffer.from(JSON.stringify(catalog));
      const skillsDigest = digest(bytes);
      if (skillsDigest === this.published.skills) return;
      if (bytes.length < 180000) {
        await this.runtime.remote("/internal/skills", "POST", {
          skills: catalog,
        });
      } else {
        const total = Math.ceil(bytes.length / 180000),
          id = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
        if (total > 128) throw new Error("Skill catalog exceeds upload limit");
        for (let index = 0; index < total; index++)
          await this.runtime.remote("/internal/skills/chunk", "POST", {
            id,
            index,
            total,
            data: bytes
              .subarray(index * 180000, (index + 1) * 180000)
              .toString("base64"),
          });
      }
      this.published.skills = skillsDigest;
    });
  }
  async start() {
    if (!this.runtime.config.webApiUrl) return;
    let failures = 0;
    try {
      await this.refresh();
    } catch (e) {
      // A snapshot the API once served (restored by runtime.load()) carries the
      // block list and the roles, so an API outage must not keep the bot from
      // starting. Without one there is nothing to enforce them from.
      if (this.runtime.snapshot.version === undefined) throw e;
      this.onError(e);
      failures = 1;
    }
    void this.watch(failures);
  }
  /** One round: the snapshot, then what this process still owes the API. */
  private async refresh() {
    await this.pull();
    if (this.announced) return;
    await this.runtime.remote("/internal/capabilities", "POST", {
      available_presets: this.runtime.available(),
    });
    // Set before the upload: a catalog the API keeps refusing must not turn
    // every poll into another attempt. The next turn publishes again.
    this.announced = true;
    await this.publishAssets();
  }
  private async watch(failures: number) {
    const { pollMs, maxMs } = this.timing;
    while (!this.abort.signal.aborted) {
      await sleep(retryDelay(failures, pollMs, maxMs), this.abort.signal).catch(
        () => {},
      );
      if (this.abort.signal.aborted) return;
      try {
        await this.refresh();
        failures = 0;
      } catch (e) {
        failures++;
        if (!this.abort.signal.aborted) this.onError(e);
      }
    }
  }
  stop() {
    this.abort.abort();
  }
}

import { Runtime, type Snapshot } from "./runtime";
import { ToolRegistry } from "./tools";
import {
  sleep,
  Serial,
  isAbortError,
  isClosedControllerError,
} from "./io";
import type { Context } from "./types";

/**
 * Vercel serverless `/internal/events` is killed at maxDuration (300s). Closing
 * the client first avoids Bun 1.4.2's uncaught `Controller is already closed`
 * when the platform RSTs the body under an active reader.
 */
export const SSE_CLIENT_BUDGET_MS = 240_000;

/** Read SSE frames until the body ends. Never throws on a double-cancel. */
export async function consumeSse(
  body: ReadableStream<Uint8Array>,
  onFrame: (event: string) => Promise<void>,
) {
  // Decode ourselves: `pipeThrough(TextDecoderStream)` plus `reader.cancel()`
  // races Bun's node-to-web adapter when the peer RSTs the socket.
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > 65536) throw new Error("Oversized SSE event");
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const event = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        await onFrame(event);
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Already closed by idle timeout / abort; cancel must not crash the bot.
    }
  }
}

export class WebSync {
  private assetQueue = new Serial();
  private etag?: string;
  private abort = new AbortController();
  private queue = new Serial();
  constructor(
    private runtime: Runtime,
    private tools: ToolRegistry,
    private onError: (e: unknown) => void,
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
      this.runtime.replace(snapshot);
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
      await this.runtime.remote("/internal/artifacts", "POST", {
        sites: this.tools.sites.list(),
      });
      const catalog = await this.tools.skills.export(
        Object.keys(this.runtime.snapshot.guilds),
      );
      const bytes = Buffer.from(JSON.stringify(catalog));
      if (bytes.length < 180000) {
        await this.runtime.remote("/internal/skills", "POST", {
          skills: catalog,
        });
        return;
      }
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
    });
  }
  async start() {
    if (!this.runtime.config.webApiUrl) return;
    await this.pull();
    await this.runtime.remote("/internal/capabilities", "POST", {
      available_presets: this.runtime.available(),
    });
    await this.publishAssets();
    void this.watch();
  }
  private async watch() {
    const c = this.runtime.config;
    while (!this.abort.signal.aborted) {
      const cycle = AbortSignal.any([
        this.abort.signal,
        AbortSignal.timeout(SSE_CLIENT_BUDGET_MS),
      ]);
      try {
        const response = await fetch(c.webApiUrl + "/internal/events", {
          headers: {
            Authorization: `Bearer ${c.internalToken}`,
            Accept: "text/event-stream",
          },
          signal: cycle,
          redirect: "error",
        });
        if (!response.ok || !response.body)
          throw new Error(`Settings stream HTTP ${response.status}`);
        await this.pull();
        await consumeSse(response.body, async (event) => {
          if (/^event: (hello|update)/m.test(event)) await this.pull();
        });
      } catch (e) {
        if (
          !this.abort.signal.aborted &&
          !isAbortError(e) &&
          !isClosedControllerError(e)
        )
          this.onError(e);
      }
      if (!this.abort.signal.aborted) {
        try {
          await this.pull();
        } catch (e) {
          this.onError(e);
        }
        await sleep(5000, this.abort.signal).catch(() => {});
      }
    }
  }
  stop() {
    this.abort.abort();
  }
}

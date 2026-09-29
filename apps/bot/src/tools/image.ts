import { mkdir, writeFile, open } from "node:fs/promises";
import { dirname } from "node:path";
import { constants } from "node:fs";
import { downloadPublic } from "../network";
import type { Config } from "../config";
import type { Context, Json } from "../types";
import type { Sandbox } from "./sandbox";

const MAX_BYTES = 16 * 1024 * 1024;
export class ImageTools {
  constructor(private config: Config, private sandbox: Sandbox) {}

  private async request(path: string, ctx: Context, args?: Json) {
    const signal = AbortSignal.any([
      AbortSignal.timeout(args ? 600_000 : 3_000),
      ...(ctx.signal ? [ctx.signal] : []),
    ]);
    try {
      // This administrator-owned endpoint is loopback-only over SSH. Never send
      // it through publicFetch/VPN or accept an endpoint from tool arguments.
      return await fetch(this.config.imageWorkerUrl + path, {
        method: args ? "POST" : "GET", redirect: "error", signal,
        headers: { Authorization: `Bearer ${this.config.imageWorkerToken}`, "Content-Type": "application/json" },
        body: args ? JSON.stringify(args) : undefined,
      });
    } catch {
      if (ctx.signal?.aborted) throw new Error("Image request cancelled");
      throw new Error("Image PC is offline, service is stopped, or request timed out. No automatic retry was made.");
    }
  }

  async status(ctx: Context) {
    try {
      const response = await this.request("/health", ctx);
      if (!response.ok) {
        await response.body?.cancel();
        return { online: false, reason: response.status === 401 ? "Image worker credentials rejected" : "Image service unavailable" };
      }
      return await response.json();
    } catch (error) {
      if (ctx.signal?.aborted) throw error;
      return { online: false, reason: "Image PC is offline or service is stopped" };
    }
  }

  async edit(args: Json, ctx: Context) {
    const release = this.sandbox.lease(ctx);
    try {
      if (args.image_path !== undefined && args.image_index !== undefined)
        throw new Error("Choose image_path or image_index, not both");
      let bytes: Buffer;
      if (args.image_path !== undefined) {
        const path = await this.sandbox.path(ctx, String(args.image_path));
        // Bound the read itself and reject symlinks/devices before touching data.
        const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const stat = await file.stat();
          if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error("Input image must be a regular file up to 16 MiB");
          bytes = Buffer.alloc(MAX_BYTES + 1);
          let size = 0;
          while (size < bytes.length) {
            const read = await file.read(bytes, size, bytes.length - size, null);
            if (!read.bytesRead) break;
            size += read.bytesRead;
          }
          if (size > MAX_BYTES) throw new Error("Input image exceeds 16 MiB");
          bytes = bytes.subarray(0, size);
        } finally { await file.close(); }
      } else {
        // Only attachments already attached to this turn are eligible. A model
        // cannot supply a URL from another guild or make the PC fetch a URL.
        const url = ctx.images?.[Number(args.image_index ?? 0)];
        if (!url) throw new Error("No image attached to this turn; attach an image or use image_path from this workspace");
        const response = await downloadPublic(url, ctx.signal, MAX_BYTES);
        bytes = Buffer.from(await response.arrayBuffer());
      }
      if (!bytes.length) throw new Error("Input image is empty");
      return await this.generate({ prompt: args.prompt, steps: args.steps, seed: args.seed,
        resolution: args.resolution, image_base64: bytes.toString("base64") }, ctx, "/edit");
    } finally { release(); }
  }

  async generate(args: Json, ctx: Context, endpoint = "/generate") {
    const release = this.sandbox.lease(ctx);
    try {
      const response = await this.request(endpoint, ctx, args);
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(response.status === 400 ? "Invalid input image or edit parameters; use PNG, JPEG or WebP up to 16 MiB and 16 megapixels" : response.status === 409 ? "Image PC is busy; try again later" : `Image service failed (HTTP ${response.status}); no image was saved`);
      }
      if (response.headers.get("content-type")?.split(";")[0] !== "image/png" ||
          Number(response.headers.get("content-length") ?? 0) > MAX_BYTES) {
        await response.body?.cancel();
        throw new Error("Invalid image response");
      }
      const reader = response.body!.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > MAX_BYTES) throw new Error("Generated image too large");
          chunks.push(value);
        }
      } finally { await reader.cancel(); }
      const bytes = Buffer.concat(chunks);
      if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
        throw new Error("Invalid PNG response");
      const relative = `generated/qwen-${crypto.randomUUID()}.png`;
      // Preserve the same guild/DM scope and disk quota as every other file tool.
      await this.sandbox.locked(ctx, async () => {
        const path = await this.sandbox.path(ctx, relative);
        await this.sandbox.quota(await this.sandbox.root(ctx), bytes.length);
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
      });
      return { ok: true, path: relative, bytes: bytes.length, model: "Qwen-Image-2.1-Q4_K_M", next: "Use send_file to deliver this image in the current conversation." };
    } finally { release(); }
  }
}

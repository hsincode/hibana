import { randomBytes } from "node:crypto";
import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  SCHEDULE_ASSETS_GUILD_MAX_BYTES,
  SCHEDULE_ASSETS_MAX,
  SCHEDULE_ASSETS_TOTAL_MAX_BYTES,
  SCHEDULE_ASSET_DIR,
  scheduleAssetKind,
  scheduleAssetMaxBytes,
  scheduleAssetNameSchema,
  type ScheduleAsset,
} from "@hibana/shared/schedules";
import { Serial } from "./io";
import { assetDir } from "./schedules";

// Assets of scheduled actions added from Discord (`/schedule-asset`, decision
// record #168): the file attached to the command is saved where assets placed
// by hand live, and the scheduler's next scan reports it to the dashboard.

const DOWNLOAD_TIMEOUT_MS = 60_000;
const MB = 1024 * 1024;
const mb = (bytes: number) =>
  bytes >= 1024 * MB
    ? `${Math.ceil((bytes / (1024 * MB)) * 10) / 10} GB`
    : `${Math.ceil((bytes / MB) * 10) / 10} MB`;

/** Bytes of the regular files in a directory; a missing one holds none. */
async function dirBytes(dir: string): Promise<Map<string, number>> {
  const entries = await readdir(dir, { withFileTypes: true }).catch((e) => {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  });
  const out = new Map<string, number>();
  for (const e of entries) {
    if (!e.isFile()) continue;
    const info = await stat(join(dir, e.name)).catch(() => null);
    if (info?.isFile()) out.set(e.name, info.size);
  }
  return out;
}

const sum = (sizes: Iterable<number>) => [...sizes].reduce((a, b) => a + b, 0);

export class ScheduleAssets {
  /** One add or remove at a time, so two cannot both pass the limits. */
  private writes = new Serial();

  constructor(
    private o: {
      dataDir: string;
      /** Tests replace Discord's CDN. */
      fetch?: (url: string, init: RequestInit) => Promise<Response>;
      /** An asset was added or removed: the dashboard's list is stale. */
      changed?: () => void;
    },
  ) {}

  /** The server's assets as the dashboard lists them, and the room left. */
  async list(guildId: string) {
    const sizes = await dirBytes(assetDir(this.o.dataDir, guildId));
    const assets: ScheduleAsset[] = [];
    for (const [name, size] of [...sizes].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      const kind = scheduleAssetKind(name);
      if (!kind || !scheduleAssetNameSchema.safeParse(name).success) continue;
      if (size > scheduleAssetMaxBytes(kind)) continue;
      assets.push({ name, kind, size });
    }
    return {
      assets,
      used: mb(sum(sizes.values())),
      max: mb(SCHEDULE_ASSETS_GUILD_MAX_BYTES),
    };
  }

  /** Saves a file attached on Discord under `as`, or its own name. The
   *  same name is replaced. */
  async add(
    guildId: string,
    file: { name: string; url: string; size: number },
    as?: string | null,
  ) {
    const name = (as ?? file.name).trim();
    if (!scheduleAssetNameSchema.safeParse(name).success)
      throw new Error(
        `素材の名前「${name.slice(0, 100)}」は使えません。英数字で始まり、英数字・「.」・「_」・「-」だけの名前を \`name\` で指定してください（例: morning.mp3）。`,
      );
    const kind = scheduleAssetKind(name);
    if (!kind)
      throw new Error(
        "素材の種類を拡張子で決められません。画像は png・jpg・jpeg・gif・webp、動画は mp4・webm・mov、音声は ogg・opus・mp3・wav・m4a・flac です。",
      );
    // Renaming must not turn one kind into another (an image named .mp3).
    const own = scheduleAssetKind(file.name);
    if (as && own && own !== kind)
      throw new Error(
        `添付したファイルの種類（${own}）と、名前の拡張子の種類（${kind}）が違います。`,
      );
    const max = scheduleAssetMaxBytes(kind);
    const tooLarge = () =>
      new Error(
        `${kind === "audio" ? "音声" : "画像と動画"}は ${mb(max)} までです。`,
      );
    if (file.size > max) throw tooLarge();
    return this.writes.run(async () => {
      const dir = assetDir(this.o.dataDir, guildId);
      // Checked before the download from what Discord says, and again with
      // what arrived.
      await this.room(guildId, name, file.size);
      const data = await this.download(file.url, max).catch((e) => {
        if (e === TOO_LARGE) throw tooLarge();
        throw e;
      });
      await this.room(guildId, name, data.length);
      await mkdir(dir, { recursive: true, mode: 0o750 });
      // Written aside, then moved into place: the scheduler never reads
      // half a file. A name with a leading dot is never listed.
      const temp = join(dir, `.upload-${randomBytes(6).toString("hex")}`);
      try {
        await writeFile(temp, data, { mode: 0o640 });
        const replaced = await stat(join(dir, name))
          .then((s) => s.isFile())
          .catch(() => false);
        await rename(temp, join(dir, name));
        this.o.changed?.();
        return { name, kind, size: data.length, replaced };
      } finally {
        await rm(temp, { force: true });
      }
    });
  }

  async remove(guildId: string, name: string) {
    if (!scheduleAssetNameSchema.safeParse(name).success)
      throw new Error(`素材「${name.slice(0, 100)}」はありません。`);
    return this.writes.run(async () => {
      const path = join(assetDir(this.o.dataDir, guildId), name);
      const info = await stat(path).catch(() => null);
      if (!info?.isFile()) throw new Error(`素材「${name}」はありません。`);
      await rm(path);
      this.o.changed?.();
      return { removed: name };
    });
  }

  /** Refuses an add that would go over the server's or every server's
   *  limit. The file it replaces is not counted. */
  private async room(guildId: string, name: string, size: number) {
    const root = join(this.o.dataDir, SCHEDULE_ASSET_DIR);
    const mine = await dirBytes(assetDir(this.o.dataDir, guildId));
    const replaced = mine.get(name) ?? 0;
    if (!mine.has(name) && mine.size >= SCHEDULE_ASSETS_MAX)
      throw new Error(
        `素材は 1 つのサーバーに ${SCHEDULE_ASSETS_MAX} 件までです。使わない素材を消してください。`,
      );
    const guildBytes = sum(mine.values()) - replaced + size;
    if (guildBytes > SCHEDULE_ASSETS_GUILD_MAX_BYTES)
      throw new Error(
        `このサーバーの素材は合計 ${mb(SCHEDULE_ASSETS_GUILD_MAX_BYTES)} までです（今 ${mb(sum(mine.values()))}）。使わない素材を消してください。`,
      );
    let total = guildBytes;
    const dirs = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const d of dirs)
      if (d.isDirectory() && d.name !== guildId)
        total += sum((await dirBytes(join(root, d.name))).values());
    if (total > SCHEDULE_ASSETS_TOTAL_MAX_BYTES)
      throw new Error(
        `すべてのサーバーの素材が合計 ${mb(SCHEDULE_ASSETS_TOTAL_MAX_BYTES)} の上限に達しています。使わない素材を消してください。`,
      );
  }

  /** The attachment from Discord's CDN, refused past `max` bytes. */
  private async download(url: string, max: number): Promise<Buffer> {
    const res = await (this.o.fetch ?? fetch)(url, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!res.ok || !res.body)
      throw new Error(`添付したファイルを取れませんでした（${res.status}）。`);
    if (Number(res.headers.get("content-length") ?? 0) > max) {
      await res.body.cancel();
      throw TOO_LARGE;
    }
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for await (const chunk of res.body) {
      bytes += chunk.length;
      if (bytes > max) throw TOO_LARGE;
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
}

const TOO_LARGE = new Error("too large");

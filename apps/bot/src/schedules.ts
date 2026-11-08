import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  SCHEDULE_ASSET_DIR,
  SCHEDULE_ASSETS_MAX,
  SCHEDULE_CLIP_MAX_MS,
  isAttachmentKind,
  parseStoredSchedules,
  scheduleAssetKind,
  scheduleAssetMaxBytes,
  scheduleAssetNameSchema,
  type Schedule,
  type ScheduleAsset,
  type ScheduleAssetKind,
} from "@hibana/shared/schedules";
import { atomicJson, readJson, sleep } from "./io";

// Scheduled actions (定時アクション, #163): at a local time every day, post to a
// channel and play a clip where the bot already is in voice. No model runs.
// See docs/schedules.md.

/** How late after its minute an action still runs: the loop ticks every
 *  15 seconds, and a restart takes a few. A day missed by more is skipped. */
export const SCHEDULE_GRACE_MS = 2 * 60_000;
const TICK_MS = 15_000;
const ASSET_SCAN_MS = 60_000;
/** Server directories looked at under scheduled-assets/. */
const ASSET_GUILDS_MAX = 1000;

const formats = new Map<string, Intl.DateTimeFormat>();
/** The local date and HH:MM of an instant in a time zone. */
export function localClock(at: number, timeZone: string) {
  let format = formats.get(timeZone);
  if (!format) {
    if (formats.size > 100) formats.clear();
    format = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formats.set(timeZone, format);
  }
  const part = Object.fromEntries(
    format.formatToParts(at).map((p) => [p.type, p.value]),
  );
  return {
    date: `${part.year}-${part.month}-${part.day}`,
    time: `${part.hour}:${part.minute}`,
  };
}

/** The occurrence due now ("YYYY-MM-DD HH:MM", local), or null. It is due
 *  from its minute until SCHEDULE_GRACE_MS later. Each minute is looked at
 *  on the local clock, so a midnight in between and a daylight saving change
 *  need nothing of their own: a local time that does not exist that day never
 *  matches, and one that happens twice is the same occurrence. */
export function dueOccurrence(
  schedule: Pick<Schedule, "time" | "time_zone">,
  now: number,
): string | null {
  for (let back = 0; back < SCHEDULE_GRACE_MS; back += 60_000) {
    const clock = localClock(now - back, schedule.time_zone);
    if (clock.time === schedule.time) return `${clock.date} ${schedule.time}`;
  }
  return null;
}

/** The server's own asset directory. */
export const assetDir = (dataDir: string, guildId: string) =>
  join(dataDir, SCHEDULE_ASSET_DIR, guildId);

/** The path of a server's asset, after the name, kind and size checks.
 *  "attachment": an image or a video to post; "audio": a clip to play. */
export async function assetPath(
  dataDir: string,
  guildId: string,
  name: string,
  use: "attachment" | "audio",
) {
  const kind = scheduleAssetKind(name);
  if (
    !kind ||
    !scheduleAssetNameSchema.safeParse(name).success ||
    (use === "attachment" ? !isAttachmentKind(kind) : kind !== "audio")
  )
    throw new Error(`Scheduled action: not an ${use} file name: ${name}`);
  const path = join(assetDir(dataDir, guildId), name);
  const info = await stat(path).catch(() => null);
  if (!info?.isFile())
    throw new Error(`Scheduled action: ${kind} file not found: ${name}`);
  if (info.size > scheduleAssetMaxBytes(kind))
    throw new Error(`Scheduled action: ${kind} file too large: ${name}`);
  return path;
}

/** Every server's asset files on this host, as the dashboard lists them. */
export async function scanScheduleAssets(
  dataDir: string,
): Promise<Record<string, ScheduleAsset[]>> {
  const root = join(dataDir, SCHEDULE_ASSET_DIR);
  const dirs = await readdir(root, { withFileTypes: true }).catch((e) => {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  });
  const out: Record<string, ScheduleAsset[]> = {};
  const guilds = dirs
    .filter((d) => d.isDirectory() && /^\d{17,20}$/.test(d.name))
    .map((d) => d.name)
    .sort()
    .slice(0, ASSET_GUILDS_MAX);
  for (const guildId of guilds) {
    const names = (await readdir(join(root, guildId))).sort();
    const assets: ScheduleAsset[] = [];
    for (const name of names) {
      const kind = scheduleAssetKind(name);
      if (!kind || !scheduleAssetNameSchema.safeParse(name).success) continue;
      const info = await stat(join(root, guildId, name)).catch(() => null);
      if (!info?.isFile() || info.size > scheduleAssetMaxBytes(kind)) continue;
      assets.push({ name, kind, size: info.size });
      if (assets.length >= SCHEDULE_ASSETS_MAX) break;
    }
    if (assets.length) out[guildId] = assets;
  }
  return out;
}

/** Discord, behind a seam so the scheduler can be tested. */
export type ScheduleTarget = {
  post(
    guildId: string,
    channelId: string,
    message: { text: string; file?: { name: string; data: Buffer } },
  ): Promise<void>;
  /** Plays the clip where the bot already is in voice in this server, after
   *  any audio playing there, and resolves once it has played. "absent": the
   *  bot is in no voice channel there, and nothing is played. */
  play(
    guildId: string,
    path: string,
    maxMs: number,
  ): Promise<"played" | "absent">;
};

export type SchedulerOptions = {
  dataDir: string;
  /** Where the last run of each scheduled action is kept across restarts. */
  statePath: string;
  /** Every server's scheduled actions, as the runtime holds them now. */
  schedules: () => Record<string, unknown>;
  /** Servers where the bot is switched off (bot_disabled) run nothing. */
  disabled: (guildId: string) => boolean;
  target: ScheduleTarget;
  report: (error: unknown) => void;
  log?: (message: string, fields: Record<string, unknown>) => void;
  /** Sends the asset list to the settings API; none without one. */
  reportAssets?: (guilds: Record<string, ScheduleAsset[]>) => Promise<unknown>;
  now?: () => number;
  tickMs?: number;
  assetScanMs?: number;
};

export class Scheduler {
  /** `<guild>:<schedule id>` → the occurrence that last ran. */
  private last: Record<string, string> = {};
  private loaded = false;
  private abort = new AbortController();
  private loop?: Promise<void>;
  private work = new Set<Promise<unknown>>();
  private assetsReported?: string;
  private assetsAt = -Infinity;
  private now: () => number;
  constructor(private o: SchedulerOptions) {
    this.now = o.now ?? Date.now;
  }

  start() {
    this.loop ??= this.run();
  }

  /** Stops the loop. A clip waiting to play is stopped by leaving voice. */
  async close() {
    this.abort.abort();
    await this.loop;
  }

  /** Settles once every action started so far has finished (tests). */
  async idle() {
    while (this.work.size) await Promise.allSettled([...this.work]);
  }

  private async run() {
    const scanMs = this.o.assetScanMs ?? ASSET_SCAN_MS;
    while (!this.abort.signal.aborted) {
      try {
        await this.tick();
      } catch (error) {
        this.o.report(error);
      }
      if (this.o.reportAssets && this.now() - this.assetsAt >= scanMs) {
        this.assetsAt = this.now();
        await this.syncAssets().catch(this.o.report);
      }
      await sleep(this.o.tickMs ?? TICK_MS, this.abort.signal).catch(() => {});
    }
  }

  /** Runs every scheduled action that is due and has not run for this
   *  occurrence. The occurrence is written down before anything is sent, so
   *  a restart never sends it twice. */
  async tick() {
    if (!this.loaded) {
      this.last = await readJson<Record<string, string>>(this.o.statePath, {});
      this.loaded = true;
    }
    const now = this.now();
    const live = new Set<string>();
    const due: [string, Schedule][] = [];
    for (const [guildId, raw] of Object.entries(this.o.schedules())) {
      for (const schedule of parseStoredSchedules(raw)) {
        const key = `${guildId}:${schedule.id}`;
        live.add(key);
        if (!schedule.enabled) continue;
        const occurrence = dueOccurrence(schedule, now);
        if (!occurrence || this.last[key] === occurrence) continue;
        this.last[key] = occurrence;
        if (!this.o.disabled(guildId)) due.push([guildId, schedule]);
      }
    }
    let pruned = false;
    for (const key of Object.keys(this.last))
      if (!live.has(key)) {
        delete this.last[key];
        pruned = true;
      }
    if (due.length || pruned) await atomicJson(this.o.statePath, this.last);
    for (const [guildId, schedule] of due)
      this.track(this.fire(guildId, schedule));
  }

  private track(p: Promise<unknown>) {
    const task = p.catch(this.o.report).finally(() => this.work.delete(task));
    this.work.add(task);
  }

  /** Its actions in order. One that fails is reported, and the rest still run. */
  private async fire(guildId: string, schedule: Schedule) {
    this.o.log?.("Scheduled action", { guild: guildId, schedule: schedule.id });
    for (const action of schedule.actions) {
      try {
        if (action.type === "post") {
          const file = action.file
            ? {
                name: action.file,
                data: await readFile(
                  await assetPath(
                    this.o.dataDir,
                    guildId,
                    action.file,
                    "attachment",
                  ),
                ),
              }
            : undefined;
          await this.o.target.post(guildId, action.channel_id, {
            text: action.text,
            file,
          });
        } else {
          const path = await assetPath(
            this.o.dataDir,
            guildId,
            action.audio,
            "audio",
          );
          // Not waited for: the clip may wait behind audio already playing,
          // and the actions after it do not.
          this.track(
            this.o.target
              .play(guildId, path, SCHEDULE_CLIP_MAX_MS)
              .then((result) =>
                this.o.log?.("Scheduled clip", {
                  guild: guildId,
                  schedule: schedule.id,
                  result,
                }),
              ),
          );
        }
      } catch (error) {
        this.o.report(error);
      }
    }
  }

  /** An asset was added or removed from Discord (#168): the next tick
   *  scans, so the dashboard has it within one tick (15 seconds). */
  assetsChanged() {
    this.assetsAt = -Infinity;
  }

  /** Sends the asset list when it differs from the one last sent. */
  async syncAssets() {
    if (!this.o.reportAssets) return;
    const guilds = await scanScheduleAssets(this.o.dataDir);
    const text = JSON.stringify(guilds);
    if (text === this.assetsReported) return;
    await this.o.reportAssets(guilds);
    this.assetsReported = text;
  }
}

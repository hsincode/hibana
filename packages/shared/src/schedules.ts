import { z } from "zod";

// Scheduled actions (定時アクション, #163): per server, at a local time every day,
// post to a channel (text, an image or a video) and play a clip in the voice
// channel the bot is already in. They run without a model. See
// docs/schedules.md.

export const SCHEDULES_MAX = 10;
export const SCHEDULE_ACTIONS_MAX = 4;
export const SCHEDULE_NAME_MAX = 100;
export const SCHEDULE_TEXT_MAX = 2000;
export const DEFAULT_SCHEDULE_TIME_ZONE = "Asia/Tokyo";
/** An image or video to post: Discord's upload limit for a server without boosts. */
export const SCHEDULE_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const SCHEDULE_AUDIO_MAX_BYTES = 20 * 1024 * 1024;
/** A clip is stopped after this long, whatever its length. */
export const SCHEDULE_CLIP_MAX_MS = 5 * 60_000;
/** Files the bot reports per server, after the size and name checks. */
export const SCHEDULE_ASSETS_MAX = 200;
/** Assets live in HIBANA_DATA_DIR/<this>/<guild id>/ on the bot's host. */
export const SCHEDULE_ASSET_DIR = "scheduled-assets";

export const SCHEDULE_IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp"];
export const SCHEDULE_VIDEO_EXTS = ["mp4", "webm", "mov"];
export const SCHEDULE_AUDIO_EXTS = ["ogg", "opus", "mp3", "wav", "m4a", "flac"];

export type ScheduleAssetKind = "image" | "video" | "audio";

export function scheduleAssetKind(name: string): ScheduleAssetKind | null {
  if (!name.includes(".")) return null;
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  if (SCHEDULE_IMAGE_EXTS.includes(ext)) return "image";
  if (SCHEDULE_VIDEO_EXTS.includes(ext)) return "video";
  if (SCHEDULE_AUDIO_EXTS.includes(ext)) return "audio";
  return null;
}

/** Whether a file of this kind can be attached to a post. */
export const isAttachmentKind = (kind: ScheduleAssetKind | null) =>
  kind === "image" || kind === "video";

export const scheduleAssetMaxBytes = (kind: ScheduleAssetKind) =>
  kind === "audio" ? SCHEDULE_AUDIO_MAX_BYTES : SCHEDULE_ATTACHMENT_MAX_BYTES;

/** Whether the runtime knows this IANA time zone. */
export function isTimeZone(value: string): boolean {
  if (!value) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const snowflake = z.string().regex(/^\d{17,20}$/, "not a Discord ID");

// A plain file name: no directory, no leading dot, so it can never leave the
// server's own asset directory.
export const scheduleAssetNameSchema = z
  .string()
  .max(100)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "not a plain file name");

const postActionSchema = z
  .object({
    type: z.literal("post"),
    channel_id: snowflake,
    text: z.string().max(SCHEDULE_TEXT_MAX),
    /** An image or a video to attach. */
    file: scheduleAssetNameSchema.nullable(),
  })
  .strict();

const voiceClipActionSchema = z
  .object({
    type: z.literal("voice_clip"),
    audio: scheduleAssetNameSchema,
  })
  .strict();

export const scheduleActionSchema = z.discriminatedUnion("type", [
  postActionSchema,
  voiceClipActionSchema,
]);

export const scheduleSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9-]{1,64}$/, "bad id"),
    name: z.string().trim().max(SCHEDULE_NAME_MAX),
    enabled: z.boolean(),
    // Every day at this local time; a day the bot misses is not made up.
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "time must be HH:MM"),
    time_zone: z
      .string()
      .max(64)
      .refine(isTimeZone, { message: "unknown time zone" }),
    actions: z.array(scheduleActionSchema).min(1).max(SCHEDULE_ACTIONS_MAX),
  })
  .strict()
  .superRefine((schedule, ctx) => {
    schedule.actions.forEach((action, i) => {
      if (action.type === "post") {
        if (!action.text.trim() && !action.file)
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["actions", i],
            message: "a post needs text or a file",
          });
        if (action.file && !isAttachmentKind(scheduleAssetKind(action.file)))
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["actions", i, "file"],
            message: "not an image or video file",
          });
      } else if (scheduleAssetKind(action.audio) !== "audio") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["actions", i, "audio"],
          message: "not an audio file",
        });
      }
    });
  });

export const schedulesSchema = z
  .array(scheduleSchema)
  .max(SCHEDULES_MAX)
  .superRefine((list, ctx) => {
    const seen = new Set<string>();
    list.forEach((s, i) => {
      if (seen.has(s.id))
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i, "id"],
          message: "duplicate id",
        });
      seen.add(s.id);
    });
  });

export type Schedule = z.infer<typeof scheduleSchema>;
export type ScheduleAction = z.infer<typeof scheduleActionSchema>;

export const scheduleAssetSchema = z
  .object({
    name: scheduleAssetNameSchema,
    kind: z.enum(["image", "video", "audio"]),
    size: z.number().int().min(0),
  })
  .strict();
export type ScheduleAsset = z.infer<typeof scheduleAssetSchema>;

/** Bot → settings API: the asset files found on the bot's host. */
export const scheduleAssetsReportSchema = z
  .object({
    guilds: z.record(
      snowflake,
      z.array(scheduleAssetSchema).max(SCHEDULE_ASSETS_MAX),
    ),
  })
  .strict();
export type ScheduleAssetsReport = z.infer<typeof scheduleAssetsReportSchema>;

/** Stored rows that no longer parse are dropped, not served half-valid. */
export function parseStoredSchedules(raw: unknown): Schedule[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    const parsed = scheduleSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

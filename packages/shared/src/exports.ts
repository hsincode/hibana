import { z } from "zod";

/**
 * Limits and schemas for downloading a server's local workspace as a `.tar.gz`
 * archive from the dashboard (decision record #193).
 */

/** Maximum uncompressed bytes read from a guild workspace for one export (1 GB). */
export const WORKSPACE_EXPORT_MAX_RAW_BYTES = 1024 * 1024 * 1024;

/** Maximum compressed `.tar.gz` size written for one export (500 MB). */
export const WORKSPACE_EXPORT_MAX_ARCHIVE_BYTES = 500 * 1024 * 1024;

/** Maximum total bytes kept in the bot's temporary exports directory (1 GB). */
export const WORKSPACE_EXPORT_TOTAL_MAX_BYTES = 1024 * 1024 * 1024;

/** Maximum regular files included in one export (matches sandbox quota walk). */
export const WORKSPACE_EXPORT_MAX_FILES = 100_000;

/** How long a generated archive stays downloadable on the bot host (15 minutes). */
export const WORKSPACE_EXPORT_TTL_MS = 15 * 60 * 1000;

/** Minimum interval between export requests for the same server (60 seconds). */
export const WORKSPACE_EXPORT_COOLDOWN_MS = 60 * 1000;

/** Recent export commands kept per server for status display. */
export const WORKSPACE_EXPORT_HISTORY_LIMIT = 10;

export const workspaceExportRequestSchema = z
  .object({
    include_settings: z.boolean().default(false),
  })
  .strict();

export type WorkspaceExportRequest = z.infer<
  typeof workspaceExportRequestSchema
>;

const httpUrlSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine((raw) => {
    try {
      const u = new URL(raw);
      return u.protocol === "http:" || u.protocol === "https:";
    } catch {
      return false;
    }
  }, "Invalid download URL");

const exportFilenameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9._-]+\.tar\.gz$/);

export const workspaceExportResultSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    url: httpUrlSchema,
    filename: exportFilenameSchema,
    bytes: z.number().int().min(0).max(WORKSPACE_EXPORT_MAX_ARCHIVE_BYTES),
    file_count: z
      .number()
      .int()
      .min(0)
      .max(WORKSPACE_EXPORT_MAX_FILES + 1),
    expires_at_unix: z.number().int().min(0),
    includes_settings: z.boolean(),
  }),
  z.object({
    ok: z.literal(false),
    error: z.string().min(1).max(1000),
  }),
]);

export type WorkspaceExportResult = z.infer<typeof workspaceExportResultSchema>;

/** What non-managers see: the secret download URL is stripped (#166, #193). */
export type PublicWorkspaceExportResult =
  | {
      ok: true;
      url?: string;
      filename: string;
      bytes: number;
      file_count: number;
      expires_at_unix: number;
      includes_settings: boolean;
    }
  | {
      ok: false;
      error: string;
    };

export type WorkspaceExportCommand = {
  id: number;
  guild_id: string;
  include_settings: boolean;
  created_at: number;
  result: WorkspaceExportResult | null;
};

export type PublicWorkspaceExportCommand = Omit<
  WorkspaceExportCommand,
  "result"
> & {
  result: PublicWorkspaceExportResult | null;
};

export const workspaceExportAckSchema = z.object({
  id: z.number().int().min(1),
  result: workspaceExportResultSchema,
});

export type WorkspaceExportAck = z.infer<typeof workspaceExportAckSchema>;

export function redactExportForViewer(
  command: WorkspaceExportCommand,
  canEdit: boolean,
): PublicWorkspaceExportCommand {
  if (canEdit || !command.result || !command.result.ok) return command;
  const { url: _hidden, ...rest } = command.result;
  return { ...command, result: rest };
}

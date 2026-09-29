import type { GuildRow, UserOverrideRow } from "./settings";
import type { UserContextEntry } from "./store";

export type CachedSnapshot = {
  chatgpt_available?: boolean;
  skill_commands: import("./skills").SkillCommand[];
  version: number;
  guilds: Record<string, GuildRow>;
  user_contexts: Record<string, UserContextEntry>;
  /** Personal overlay (model / context / context). Dashboard is the writer. */
  user_overrides: Record<string, UserOverrideRow>;
  blocked_users: string[];
  /** Dashboard plan roles so the bot can gate Premium-only presets. */
  user_roles: Record<string, string>;
  /**
   * Preset ids currently hidden from pickers. Dashboard is the writer
   * (`preset_visibility` meta); PUT /internal/snapshot must not replace this.
   */
  unpublished_presets: string[];
  /**
   * Preset ids currently Premium-floor (Premium / Moderator / Administrator).
   * Dashboard is the writer (`preset_premium` meta); PUT must not replace this.
   */
  premium_presets: string[];
  /** Dashboard pin/unpin/month-extend waiting for the bot. */
  artifact_commands: {
    id: number;
    token: string;
    guild_id: string | null;
    action: string;
  }[];
};

/**
 * Vercel isolates do not share in-process subscribers, so the SSE handler
 * also cheap-polls `meta.snapshot_version`. One indexed read is enough to
 * emit `update` without the bot pulling guilds / contexts / blocked on a
 * timer. Same-isolate writes still notify instantly via {@link notify}.
 */
export const SSE_VERSION_WATCH_MS = 5_000;

/** Keep proxies from idle-closing the stream. The bot hangs up at 240s so it
 *  closes before Vercel's 300s maxDuration RST, which crashes Bun 1.4.2. */
export const SSE_PING_MS = 15_000;

type Listener = (version: number) => void;

/** Per-isolate snapshot cache + fan-out for `/internal/events`. */
export class SnapshotHub {
  private cache: CachedSnapshot | null = null;
  private listeners = new Set<Listener>();

  get(): CachedSnapshot | null {
    return this.cache;
  }

  set(snap: CachedSnapshot) {
    this.cache = snap;
  }

  invalidate() {
    this.cache = null;
  }

  notify(version: number) {
    for (const listener of this.listeners) {
      try {
        listener(version);
      } catch {
        // A slow SSE client must not block the writer or the other subscribers.
      }
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

export function snapshotEtag(version: number): string {
  return `"${version}"`;
}

export function parseSnapshotEtag(header: string | null): number | null {
  if (!header) return null;
  const token = header.trim().replace(/^W\//, "").replaceAll('"', "");
  if (!/^\d+$/.test(token)) return null;
  return Number(token);
}

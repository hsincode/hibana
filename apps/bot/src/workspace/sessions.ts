import type { ConversationStore } from "../conversation-store";
import type { WorkspaceState, WorkspaceTotals, WorkspaceVariant } from "./types";

/** The cloud session one channel (a thread or a DM included) talks to. */
export type SessionRow = {
  channelId: string;
  guildId?: string;
  /** `conversationKey(selection, "workspace", variant)` the session was
   *  created for. Its agent, model and effort are fixed from then on. */
  key: string;
  sessionId: string;
  variant: WorkspaceVariant;
  createdAt: number;
  usedAt: number;
  /** The session's cumulative usage as last added to the usage ledger: the
   *  "before" of the next difference. */
  totals?: WorkspaceTotals;
  state?: WorkspaceState;
  /** Set while a turn's raised spending ceiling has not been lowered again.
   *  A process that dies in a turn leaves it behind, which is how the next
   *  one knows the session may still be spending. */
  lease?: { ceilingCents: number; at: number };
};

/** A session no channel uses any more, waiting to be removed on Anthropic's
 *  side. `delete` takes its files and transcript with it and is for an
 *  explicit clear; everything else is archived. */
export type Disposal = {
  sessionId: string;
  mode: "delete" | "archive";
  channelId: string;
  guildId?: string;
  key: string;
  variant: WorkspaceVariant;
  /** What the ledger had counted when the session was retired. */
  totals?: WorkspaceTotals;
  queuedAt: number;
  attempts: number;
};

/** What `touch` replaces: each field given replaces the stored one whole. */
export type SessionPatch = {
  totals?: WorkspaceTotals;
  state?: WorkspaceState;
  /** `null` releases the lease. */
  lease?: { ceilingCents: number } | null;
};

// Memory keeps what the store would hand back after a restart (the JSON form).
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/**
 * Which Anthropic Workspace session each channel uses (decision record: #76),
 * and the sessions still to be removed. Like `RouteMemory`, memory is the
 * working copy and each change is written through: with a store the rows
 * outlive a restart, and without one, or while it is unavailable, they live
 * in this process only.
 *
 * A session id leaves this table only through `disposed`. Whatever ends a
 * channel's use of a session moves it to the queue first, because a session
 * nobody remembers can neither be removed nor have its budget lowered. A
 * session the table never held, or lost with its process, comes back into
 * the queue through `abandon`. Nothing here calls the API.
 */
export class SessionTable {
  private rows = new Map<string, SessionRow>();
  private queue = new Map<string, Disposal>();
  constructor(
    private store?: ConversationStore,
    private now: () => number = Date.now,
  ) {}
  private row(channelId: string): SessionRow | undefined {
    const known = this.rows.get(channelId);
    if (known || !this.store) return known;
    const saved = this.store.loadSession(channelId);
    if (saved) this.rows.set(channelId, saved);
    return saved;
  }
  get(channelId: string): SessionRow | undefined {
    const row = this.row(channelId);
    return row && structuredClone(row);
  }
  /** Records the session a channel now uses. A different session the channel
   *  still had is queued to be archived, never overwritten. */
  save(row: Omit<SessionRow, "createdAt" | "usedAt"> & { createdAt?: number; usedAt?: number }): SessionRow {
    const previous = this.row(row.channelId);
    if (previous && previous.sessionId !== row.sessionId) this.move([previous], "archive");
    const at = this.now();
    const saved: SessionRow = plain({ ...row, createdAt: row.createdAt ?? at, usedAt: row.usedAt ?? at });
    this.rows.set(saved.channelId, saved);
    this.store?.saveSession(saved);
    return structuredClone(saved);
  }
  /** Updates the row of the session a turn ran on, and marks it used. False,
   *  and nothing changes, when the channel has another session by now or
   *  none: what a turn learned about a session must not land on the next. */
  touch(channelId: string, sessionId: string, patch: SessionPatch): boolean {
    const row = this.row(channelId);
    if (!row || row.sessionId !== sessionId) return false;
    if (patch.totals) row.totals = plain(patch.totals);
    if (patch.state) row.state = plain(patch.state);
    if (patch.lease === null) delete row.lease;
    else if (patch.lease) row.lease = { ceilingCents: patch.lease.ceilingCents, at: this.now() };
    row.usedAt = this.now();
    // Synchronous, so a lease is on disk before the ceiling is raised.
    this.store?.saveSession(row);
    return true;
  }
  /** Rows with a lease, also those an earlier process left and this one has
   *  not read yet. Whether a turn is running on one is the caller's to know. */
  leased(): SessionRow[] {
    for (const saved of this.store?.leasedSessions() ?? [])
      if (!this.rows.has(saved.channelId)) this.rows.set(saved.channelId, saved);
    return [...this.rows.values()].filter((row) => row.lease).map((row) => structuredClone(row));
  }
  private move(rows: SessionRow[], mode: Disposal["mode"]): Disposal[] {
    const queuedAt = this.now();
    const moved = rows.map((row): Disposal => ({
      sessionId: row.sessionId, mode, channelId: row.channelId, guildId: row.guildId, key: row.key,
      variant: row.variant, totals: row.totals, queuedAt, attempts: 0,
    }));
    for (const disposal of moved) {
      this.rows.delete(disposal.channelId);
      this.queue.set(disposal.sessionId, disposal);
    }
    if (moved.length) this.store?.retireSessions(moved);
    return moved.map((disposal) => structuredClone(disposal));
  }
  /** Ends a channel's use of its session and queues the session for removal,
   *  in one step. Undefined when the channel has none. */
  retire(channelId: string, mode: Disposal["mode"]): Disposal | undefined {
    const row = this.row(channelId);
    return row && this.move([row], mode)[0];
  }
  /** The same for every channel of a guild, in one step; without a guild,
   *  every channel (the reach of `History.clearGuild`). `except` names the
   *  channels to leave, such as those with a turn running. */
  retireGuild(guildId: string | undefined, mode: Disposal["mode"], except: string[] = []): Disposal[] {
    // Also the channels of the guild that this process has not read yet.
    for (const saved of this.store?.guildSessions(guildId) ?? [])
      if (!this.rows.has(saved.channelId)) this.rows.set(saved.channelId, saved);
    const kept = new Set(except);
    return this.move(
      [...this.rows.values()].filter((row) => (!guildId || row.guildId === guildId) && !kept.has(row.channelId)),
      mode,
    );
  }
  /** Queues a session that no row names any more: a mark in a checkpoint is
   *  all that remembers it, as after a process without a store died in its
   *  turn. It is archived, like every session that was not cleared. What the
   *  ledger counted of it is not known, so it is queued without totals and
   *  its removal counts all it has used. False, and nothing changes, when
   *  the channel uses that session or it is queued already. */
  abandon(session: Pick<Disposal, "sessionId" | "channelId" | "guildId" | "key" | "variant">): boolean {
    if (this.holds(session.channelId, session.sessionId)) return false;
    const disposal: Disposal = plain({
      sessionId: session.sessionId, mode: "archive", channelId: session.channelId, guildId: session.guildId,
      key: session.key, variant: session.variant, queuedAt: this.now(), attempts: 0,
    });
    this.queue.set(disposal.sessionId, disposal);
    // No row is deleted with it: the insert is all this does on disk.
    this.store?.retireSessions([disposal]);
    return true;
  }
  /** Whether the table still answers for a session: the channel uses it, or
   *  it waits to be removed. */
  holds(channelId: string, sessionId: string): boolean {
    return this.row(channelId)?.sessionId === sessionId || this.pending().has(sessionId);
  }
  /** The queue, with what an earlier process left in the store. */
  private pending(): Map<string, Disposal> {
    for (const saved of this.store?.loadDisposals() ?? [])
      if (!this.queue.has(saved.sessionId)) this.queue.set(saved.sessionId, saved);
    return this.queue;
  }
  /** Everything waiting to be removed, oldest first, including what an
   *  earlier process queued and could not finish. */
  disposals(): Disposal[] {
    return [...this.pending().values()]
      .sort((a, b) => a.queuedAt - b.queuedAt || a.sessionId.localeCompare(b.sessionId))
      .map((disposal) => structuredClone(disposal));
  }
  /** A removal that did not succeed stays queued for the next attempt. */
  failed(sessionId: string) {
    const disposal = this.queue.get(sessionId);
    if (disposal) disposal.attempts++;
    this.store?.failDisposal(sessionId);
  }
  /** The session is gone on Anthropic's side, or was never there. */
  disposed(sessionId: string) {
    this.queue.delete(sessionId);
    this.store?.deleteDisposal(sessionId);
  }
}

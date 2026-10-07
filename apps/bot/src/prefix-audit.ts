import type { Json } from "./types";

/** Which conversation a request continues. Prompt caches match on a request's
 *  leading bytes, so only requests of one lineage can extend each other. */
export type RequestTrace = {
  channel: string;
  agent: string;
  round: number;
  /** A child starts from its root's conversation, so its first request is
   *  compared with the root's latest one. */
  child?: boolean;
};

type Segment = { kind: string; hash: number | bigint; bytes: number };

export type PrefixReport = {
  segments: number;
  bytes: number;
  /** The earlier request this one was compared with; `none` for a first request. */
  against: "lineage" | "root" | "none";
  shared_segments: number;
  shared_bytes: number;
  /** Kind of the first segment that differs from the earlier request, or null
   *  when this request only appends to it. A non-null value means everything
   *  after `shared_bytes` cannot be served from the cache. */
  diverged: string | null;
};

const ROOT = "root";
// Settings outside the message list that invalidate a cached prefix when they change.
const SETTINGS = ["model", "reasoning", "reasoning_effort", "thinking", "output_config"];

function segment(kind: string, value: unknown): Segment {
  const text = JSON.stringify(value) ?? "";
  return { kind, hash: Bun.hash(text), bytes: Buffer.byteLength(text) };
}

/** Splits a rendered request body into the units a provider caches in order:
 *  settings, tool definitions, system text, then one unit per input item. */
export function requestSegments(body: Json): Segment[] {
  const items = (body.input ?? body.messages ?? []) as Json[];
  const system = body.instructions ?? body.system;
  return [
    segment("settings", SETTINGS.map(key => body[key] ?? null)),
    ...((body.tools ?? []) as Json[]).map(tool => segment("tool", tool)),
    ...(system ? [segment("system", system)] : []),
    ...items.flatMap(item => {
      const kind = `item:${String(item.role ?? item.type ?? "unknown")}`;
      // Anthropic merges consecutive same-role messages into one turn. Split
      // by content block so a block appended to the last turn is an append.
      return Array.isArray(item.content)
        ? [segment(kind, item.role), ...item.content.map(block => segment(kind, block))]
        : [segment(kind, item)];
    }),
  ];
}

function compare(current: Segment[], earlier: Segment[]) {
  let shared = 0;
  while (
    shared < current.length && shared < earlier.length &&
    current[shared]!.hash === earlier[shared]!.hash && current[shared]!.bytes === earlier[shared]!.bytes
  ) shared++;
  return {
    shared_segments: shared,
    shared_bytes: current.slice(0, shared).reduce((sum, s) => sum + s.bytes, 0),
    // Running off the end of the earlier request is a plain append.
    diverged: shared === earlier.length ? null : current[shared]?.kind ?? "truncated",
  };
}

/** Reports how much of each request repeats the previous request of the same
 *  lineage. It keeps hashes and sizes only, never message text, and reads the
 *  body that is actually sent, so the result does not depend on the provider. */
export class PrefixAudit {
  private last = new Map<string, Segment[]>();
  // Bounds memory: a long tool loop keeps about 100 bytes per input item.
  constructor(private capacity = 128) {}

  /** Compares without recording. Call `commit` once the provider has accepted
   *  the request: a body that was never delivered is not a prefix of anything. */
  observe(trace: RequestTrace, body: Json): { report: PrefixReport; commit: () => void } {
    const current = requestSegments(body);
    const key = `${trace.channel}:${trace.agent}`;
    const rootKey = `${trace.channel}:${ROOT}`;
    const candidates: [PrefixReport["against"], Segment[] | undefined][] = [
      ["lineage", this.last.get(key)],
      ["root", trace.child ? this.last.get(rootKey) : undefined],
    ];
    let report: PrefixReport = {
      segments: current.length,
      bytes: current.reduce((sum, s) => sum + s.bytes, 0),
      against: "none", shared_segments: 0, shared_bytes: 0, diverged: null,
    };
    for (const [against, earlier] of candidates) {
      if (!earlier) continue;
      const result = compare(current, earlier);
      if (report.against === "none" || result.shared_bytes > report.shared_bytes)
        report = { ...report, against, ...result };
    }
    return {
      report,
      commit: () => {
        // Re-insert so the map evicts the least recently used lineage first,
        // and keep a root alive while its children are still comparing with it.
        const root = trace.child ? this.last.get(rootKey) : undefined;
        if (root) this.touch(rootKey, root);
        this.touch(key, current);
        while (this.last.size > this.capacity) this.last.delete(this.last.keys().next().value!);
      },
    };
  }
  private touch(key: string, segments: Segment[]) {
    this.last.delete(key);
    this.last.set(key, segments);
  }
}

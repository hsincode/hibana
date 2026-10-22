import { basename } from "node:path/posix";
import type { BetaManagedAgentsSessionEvent } from "@anthropic-ai/sdk/resources/beta/sessions/events";
import type { RawEvent } from "./types";

// The status lines of an Anthropic Workspace turn (#76). Every sentence the
// channel reads about what a session is doing is written here; the runner
// passes events through and holds no text of its own.
//
// A status line is visible to everyone in the channel, not only to the person
// who asked. It names the kind of step that is running. A shell command is
// never quoted: the built-in bash tool takes no description, and the command
// itself can carry anything the model was working with.

/** An event of a session, as the stream's raw reader or the SDK types it.
 *  Every field is read as unknown: new event types and fields appear. */
type SessionEvent = RawEvent | BetaManagedAgentsSessionEvent;
type Fields = Record<string, unknown>;

/** Model-written text as one short line. Whitespace is folded, and a `@` is
 *  kept from forming a mention even where the message is posted without
 *  `allowed_mentions`. */
const text = (value: unknown, limit = 120) =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit)
    .replace(/@/g, "@\u200b");
const labelled = (label: string, value: unknown) =>
  text(value) ? `${label}: ${text(value)}` : label;
const host = (url: unknown) => {
  try {
    return new URL(String(url)).host;
  } catch {
    return "";
  }
};

/** Shown while a turn waits for one of the bot's Workspace slots: the limit
 *  on turns running at once is the bot's own, across every server. */
export const waitingLine =
  "ほかの作業が終わるのを待っています（Anthropic Workspace の同時実行の上限）。";

/** What one tool call of the primary thread is doing, built-in or custom.
 *  `more` is how many further calls are running beside it. */
export function toolLine(name: string, input: Fields = {}, more = 0): string {
  const line =
    name === "bash"
      ? input.restart === true
        ? "シェルを再起動しています"
        : "コマンドを実行しています"
      : name === "read"
        ? labelled("読み込み", input.file_path)
        : name === "write" || name === "edit"
          ? labelled("編集", input.file_path)
          : name === "glob" || name === "grep"
            ? labelled("検索", input.pattern)
            : name === "web_search"
              ? labelled("web 検索", input.query)
              : name === "web_fetch"
                ? labelled("web 取得", host(input.url))
                : name === "send_file"
                  ? labelled(
                      "送信",
                      typeof input.path === "string"
                        ? basename(input.path)
                        : "",
                    )
                  : name === "AskUserQuestion"
                    ? "質問の回答を待っています"
                    : labelled("ツール", name);
  return more > 0 ? `${line}（ほか ${more} 件）` : line;
}

const RETRYING: Record<string, string> = {
  model_overloaded_error: "モデルが混み合っているため再試行しています",
  model_rate_limited_error: "レート制限のため再試行しています",
};

/** The status line an event calls for, if any: a tool call of the primary
 *  thread, a retry, or a workflow run's error. Calls made inside a workflow
 *  run are left to that run's own line (`runLine`). */
export function eventLine(event: SessionEvent): string | undefined {
  const e = event as RawEvent;
  switch (e.type) {
    case "agent.tool_use":
    case "agent.mcp_tool_use":
    case "agent.custom_tool_use":
      if (e.session_thread_id || typeof e.name !== "string") return undefined;
      return toolLine(
        e.name,
        e.input && typeof e.input === "object" ? (e.input as Fields) : {},
      );
    case "session.status_rescheduled":
      return "再試行しています";
    case "session.error": {
      const error = (e.error ?? {}) as {
        type?: unknown;
        retry_status?: { type?: unknown };
      };
      if (error.retry_status?.type !== "retrying") return undefined;
      return RETRYING[String(error.type)] ?? "エラーのため再試行しています";
    }
    case "workflow_run.error":
      // The API writes this message itself; it holds nothing from the run.
      return labelled(
        "ワークフローのエラー",
        (e.error as { message?: unknown } | undefined)?.message,
      );
    default:
      return undefined;
  }
}

/** One workflow run as its status line shows it. */
export type RunView = {
  id: string;
  name: string;
  phases: { id: string; name: string }[];
  /** The phases now open: `workflow_run.phase_started` event id → phase id. */
  open: Map<string, string>;
  /** Agents (session threads) the run created, and how many of them ended. */
  threads: number;
  finished: number;
  state: "running" | "idle" | "ended";
  /** `result.type` of the run's end. New values may appear. */
  result?: string;
  startedAt: number;
  endedAt?: number;
};

/** Folds one event into the runs it concerns and returns the run whose view
 *  changed. `threadRuns` maps a thread to the run that created it. An event
 *  about a run or thread that was never seen, of an unknown type, or without
 *  the fields it should have changes nothing and returns undefined. */
export function applyRunEvent(
  runs: Map<string, RunView>,
  threadRuns: Map<string, string>,
  event: SessionEvent,
  now = Date.now(),
): RunView | undefined {
  const e = event as RawEvent;
  const id =
    typeof e.workflow_run_id === "string" ? e.workflow_run_id : undefined;
  const thread =
    typeof e.session_thread_id === "string" ? e.session_thread_id : undefined;
  if (e.type === "workflow_run.created") {
    if (!id) return undefined;
    // Seen again after a reconnect: the view it already has stands.
    const known = runs.get(id);
    if (known) return known;
    const phases = (Array.isArray(e.phases) ? (e.phases as Fields[]) : [])
      .filter((p) => p && typeof p.id === "string")
      .map((p) => ({ id: p.id as string, name: String(p.name ?? p.id) }));
    const run: RunView = {
      id,
      name: String(e.name ?? id),
      phases,
      open: new Map(),
      threads: 0,
      finished: 0,
      state: "running",
      startedAt: now,
    };
    runs.set(id, run);
    return run;
  }
  if (e.type === "session.thread_created") {
    const run = id ? runs.get(id) : undefined;
    if (!run || !thread || threadRuns.has(thread)) return undefined;
    threadRuns.set(thread, run.id);
    run.threads++;
    return run;
  }
  if (e.type === "session.thread_status_terminated") {
    const run = thread ? runs.get(threadRuns.get(thread) ?? "") : undefined;
    if (!run || run.finished >= run.threads) return undefined;
    run.finished++;
    return run;
  }
  const run = id ? runs.get(id) : undefined;
  if (!run) return undefined;
  switch (e.type) {
    case "workflow_run.status_running":
    case "workflow_run.status_idle":
      // The end is the last of a run's events; nothing reopens it.
      if (run.state === "ended") return undefined;
      run.state = e.type === "workflow_run.status_running" ? "running" : "idle";
      return run;
    case "workflow_run.phase_started":
      if (!e.id || typeof e.workflow_run_phase_id !== "string")
        return undefined;
      run.open.set(e.id, e.workflow_run_phase_id);
      return run;
    case "workflow_run.phase_ended":
      return run.open.delete(String(e.phase_started_id)) ? run : undefined;
    case "workflow_run.status_ended": {
      const result = (e.result as { type?: unknown } | undefined)?.type;
      run.state = "ended";
      run.result = typeof result === "string" ? result : undefined;
      run.endedAt ??= now;
      run.open.clear();
      return run;
    }
    default:
      return undefined;
  }
}

const duration = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60
    ? `${s}秒`
    : `${Math.floor(s / 60)}分${s % 60 ? `${s % 60}秒` : ""}`;
};
const ENDED: Record<string, string> = {
  completed: "完了",
  stopped: "停止",
  error: "失敗",
};
const MAX_PHASES = 3;

/** The one status line of a run, in the form the local workflow engine uses
 *  for its own. The run's threads are called agents: a "thread" in a Discord
 *  channel is something else. Names are the model's and are shown flattened. */
export function runLine(run: RunView, now = Date.now()): string {
  const state =
    run.state === "running"
      ? "実行中"
      : run.state === "idle"
        ? "一時停止"
        : (ENDED[run.result ?? ""] ?? "終了");
  const open = [...new Set(run.open.values())].map((id) =>
    text(run.phases.find((p) => p.id === id)?.name ?? id, 40),
  );
  const phases =
    open.length > MAX_PHASES
      ? `${open.slice(0, MAX_PHASES).join("、")} ほか ${open.length - MAX_PHASES}`
      : open.join("、");
  const parts = [
    state,
    ...(phases ? [phases] : []),
    `エージェント ${run.threads}（終了 ${run.finished}）`,
    duration((run.endedAt ?? now) - run.startedAt),
  ];
  return `ワークフロー: ${text(run.name, 80)}（${parts.join("・")}）`;
}

/** Wraps a status writer for a stream of updates. While one write is in
 *  flight, and for `minMs` after it, only the newest text is kept, so a burst
 *  of events becomes a few edits instead of a queue of them behind Discord's
 *  rate limit. The last text given is always written. A failed write is
 *  dropped: a status line must never stop the turn. */
export function coalesce(
  write: (text: string) => Promise<void>,
  minMs = 1500,
): (text: string) => void {
  let latest: string | undefined,
    written: string | undefined,
    busy = false;
  const drain = async () => {
    busy = true;
    try {
      while (latest !== undefined) {
        const next = latest;
        latest = undefined;
        if (next === written) continue;
        written = next;
        await Promise.resolve()
          .then(() => write(next))
          .catch(() => {});
        await new Promise<void>((resolve) => {
          // A pending status edit must not keep a stopping process alive.
          (setTimeout(resolve, minMs) as { unref?: () => void }).unref?.();
        });
      }
    } finally {
      busy = false;
    }
  };
  return (next) => {
    latest = next;
    if (!busy) void drain();
  };
}

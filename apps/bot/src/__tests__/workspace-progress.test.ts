import { describe, expect, test } from "bun:test";
import type { BetaManagedAgentsSessionEvent } from "@anthropic-ai/sdk/resources/beta/sessions/events";
import {
  applyRunEvent,
  coalesce,
  eventLine,
  runLine,
  toolLine,
  type RunView,
} from "../workspace/progress";
import type { RawEvent } from "../workspace/types";

// Decision record: #76. What the channel is shown while an Anthropic
// Workspace session works. The lines are read by everyone in the channel.

const at = "2026-10-12T00:00:00Z";

describe("a tool call's line", () => {
  test("says what each built-in tool is doing", () => {
    expect(
      toolLine("read", { file_path: "/mnt/session/outputs/report.md" }),
    ).toBe("読み込み: /mnt/session/outputs/report.md");
    expect(
      toolLine("write", { file_path: "src/app.ts", content: "secret" }),
    ).toBe("編集: src/app.ts");
    expect(
      toolLine("edit", {
        file_path: "src/app.ts",
        old_string: "a",
        new_string: "b",
      }),
    ).toBe("編集: src/app.ts");
    expect(toolLine("glob", { pattern: "**/*.ts" })).toBe("検索: **/*.ts");
    expect(toolLine("grep", { pattern: "TODO", path: "src" })).toBe(
      "検索: TODO",
    );
    expect(toolLine("web_search", { query: "bun test timeout" })).toBe(
      "web 検索: bun test timeout",
    );
    expect(
      toolLine("web_fetch", {
        url: "https://docs.example.com/guide?token=abc#top",
      }),
    ).toBe("web 取得: docs.example.com");
    expect(toolLine("bash", { restart: true })).toBe(
      "シェルを再起動しています",
    );
  });

  test("never shows a shell command", () => {
    const command =
      "curl -H 'Authorization: Bearer sk-live-123' https://internal.example/users | tee out.json";
    const line = toolLine("bash", { command, timeout_ms: 1000 });
    expect(line).toBe("コマンドを実行しています");
    for (const part of ["curl", "sk-live-123", "internal.example"])
      expect(line).not.toContain(part);
    expect(
      eventLine({
        type: "agent.tool_use",
        id: "sevt_1",
        name: "bash",
        input: { command },
        processed_at: at,
      }),
    ).toBe("コマンドを実行しています");
  });

  test("names a custom tool, and the file a send_file call is about", () => {
    expect(
      toolLine("send_file", {
        path: "/mnt/session/outputs/charts/q3.png",
        content: "private caption",
      }),
    ).toBe("送信: q3.png");
    expect(
      toolLine("AskUserQuestion", { questions: [{ question: "private?" }] }),
    ).toBe("質問の回答を待っています");
    expect(toolLine("read_messages", { channel_id: "10", limit: 50 })).toBe(
      "ツール: read_messages",
    );
    expect(toolLine("ban_member", { user_id: "77", reason: "private" })).toBe(
      "ツール: ban_member",
    );
  });

  test("counts the calls running beside it", () => {
    expect(toolLine("read", { file_path: "a.txt" }, 2)).toBe(
      "読み込み: a.txt（ほか 2 件）",
    );
    expect(toolLine("bash", { command: "ls" }, 1)).toBe(
      "コマンドを実行しています（ほか 1 件）",
    );
    expect(toolLine("read", { file_path: "a.txt" }, 0)).toBe("読み込み: a.txt");
  });

  test("stays one short line whatever the input is", () => {
    expect(toolLine("read", { file_path: "a\n  b\tc.txt" })).toBe(
      "読み込み: a b c.txt",
    );
    expect(toolLine("grep", { pattern: "x".repeat(500) })).toBe(
      `検索: ${"x".repeat(120)}`,
    );
    // An input the tool should not have had says only what kind of step it is.
    expect(toolLine("read", {})).toBe("読み込み");
    expect(toolLine("read")).toBe("読み込み");
    expect(toolLine("web_fetch", { url: "not a url" })).toBe("web 取得");
    expect(toolLine("web_search", { query: 42 })).toBe("web 検索: 42");
    expect(toolLine("send_file", { path: ["a"] })).toBe("送信");
  });
});

describe("an event's line", () => {
  test("is the tool call's for the primary thread, and nothing for a call inside a workflow run", () => {
    const use: BetaManagedAgentsSessionEvent = {
      type: "agent.tool_use",
      id: "sevt_1",
      name: "read",
      input: { file_path: "notes.md" },
      processed_at: at,
    };
    expect(eventLine(use)).toBe("読み込み: notes.md");
    expect(eventLine({ ...use, session_thread_id: null })).toBe(
      "読み込み: notes.md",
    );
    expect(eventLine({ ...use, session_thread_id: "sthr_1" })).toBeUndefined();
    const custom: BetaManagedAgentsSessionEvent = {
      type: "agent.custom_tool_use",
      id: "sevt_2",
      name: "send_file",
      input: { path: "/mnt/session/outputs/a.pdf" },
      processed_at: at,
    };
    expect(eventLine(custom)).toBe("送信: a.pdf");
    expect(
      eventLine({ ...custom, session_thread_id: "sthr_1" }),
    ).toBeUndefined();
    expect(
      eventLine({
        type: "agent.mcp_tool_use",
        id: "sevt_3",
        name: "lookup",
        mcp_server_name: "docs",
        input: {},
        processed_at: at,
      }),
    ).toBe("ツール: lookup");
  });

  test("says when the session is retrying, and why when the API says so", () => {
    expect(
      eventLine({
        type: "session.status_rescheduled",
        id: "sevt_1",
        processed_at: at,
      }),
    ).toBe("再試行しています");
    const failed = (type: string, retry: string): RawEvent => ({
      type: "session.error",
      id: "sevt_2",
      error: {
        type,
        message: "internal detail",
        retry_status: { type: retry },
      },
    });
    expect(eventLine(failed("model_overloaded_error", "retrying"))).toBe(
      "モデルが混み合っているため再試行しています",
    );
    expect(eventLine(failed("model_rate_limited_error", "retrying"))).toBe(
      "レート制限のため再試行しています",
    );
    expect(eventLine(failed("some_future_error", "retrying"))).toBe(
      "エラーのため再試行しています",
    );
    // An error that is not being retried ends the turn; that is the reply's to say.
    expect(
      eventLine(failed("model_overloaded_error", "exhausted")),
    ).toBeUndefined();
    expect(eventLine(failed("unknown_error", "terminal"))).toBeUndefined();
  });

  test("shows a workflow run's error as the API worded it", () => {
    expect(
      eventLine({
        type: "workflow_run.error",
        id: "sevt_1",
        workflow_run_id: null,
        processed_at: at,
        error: {
          type: "max_workflow_runs_error",
          message: "The session is at its limit of open workflow runs.",
        },
      }),
    ).toBe(
      "ワークフローのエラー: The session is at its limit of open workflow runs.",
    );
    expect(eventLine({ type: "workflow_run.error", id: "sevt_2" })).toBe(
      "ワークフローのエラー",
    );
  });

  test("is nothing for the rest, known or not", () => {
    for (const event of [
      {
        type: "agent.message",
        id: "sevt_1",
        content: [{ type: "text", text: "hello" }],
      },
      { type: "agent.tool_result", id: "sevt_2" },
      {
        type: "session.status_idle",
        id: "sevt_3",
        stop_reason: { type: "end_turn" },
      },
      {
        type: "workflow_run.created",
        id: "sevt_4",
        workflow_run_id: "wrun_1",
        name: "survey",
        phases: [],
      },
      { type: "span.model_request_end", id: "sevt_5" },
      { type: "agent.tool_use", id: "sevt_6" },
      { type: "session.error", id: "sevt_7" },
      { type: "some.future_event" },
    ] satisfies RawEvent[])
      expect(eventLine(event)).toBeUndefined();
  });
});

/** The state a turn keeps for its runs, and a way to feed it events. */
function tracker(now = 1_000_000) {
  const runs = new Map<string, RunView>(),
    threadRuns = new Map<string, string>();
  const clock = { now };
  let count = 0;
  const apply = (event: RawEvent) =>
    applyRunEvent(
      runs,
      threadRuns,
      { id: `sevt_${++count}`, ...event },
      clock.now,
    );
  return {
    runs,
    threadRuns,
    clock,
    apply,
    line: (id = "wrun_1") => runLine(runs.get(id)!, clock.now),
  };
}
const created = (extra: Partial<RawEvent> = {}): RawEvent => ({
  type: "workflow_run.created",
  workflow_run_id: "wrun_1",
  name: "survey the docs",
  description: null,
  phases: [
    { id: "wphs_1", name: "collect", description: null },
    { id: "wphs_2", name: "compare", description: "side by side" },
  ],
  processed_at: at,
  ...extra,
});

describe("a workflow run's line", () => {
  test("a run shows its name, open phase and agent count", () => {
    const { runs, clock, apply, line } = tracker();
    expect(apply(created())).toBe(runs.get("wrun_1")!);
    expect(line()).toBe(
      "ワークフロー: survey the docs（実行中・エージェント 0（終了 0）・0秒）",
    );
    apply({ type: "workflow_run.status_running", workflow_run_id: "wrun_1" });
    apply({
      type: "workflow_run.phase_started",
      id: "sevt_p1",
      workflow_run_id: "wrun_1",
      workflow_run_phase_id: "wphs_1",
    });
    for (const thread of ["sthr_1", "sthr_2", "sthr_3"])
      apply({
        type: "session.thread_created",
        session_thread_id: thread,
        workflow_run_id: "wrun_1",
        agent_name: "reader",
      });
    clock.now += 12_000;
    expect(line()).toBe(
      "ワークフロー: survey the docs（実行中・collect・エージェント 3（終了 0）・12秒）",
    );
    apply({
      type: "session.thread_status_terminated",
      session_thread_id: "sthr_2",
      agent_name: "reader",
    });
    apply({
      type: "workflow_run.phase_started",
      id: "sevt_p2",
      workflow_run_id: "wrun_1",
      workflow_run_phase_id: "wphs_2",
    });
    clock.now += 60_000;
    expect(line()).toBe(
      "ワークフロー: survey the docs（実行中・collect、compare・エージェント 3（終了 1）・1分12秒）",
    );
    apply({
      type: "workflow_run.phase_ended",
      workflow_run_id: "wrun_1",
      workflow_run_phase_id: "wphs_1",
      phase_started_id: "sevt_p1",
    });
    apply({ type: "workflow_run.status_idle", workflow_run_id: "wrun_1" });
    expect(line()).toBe(
      "ワークフロー: survey the docs（一時停止・compare・エージェント 3（終了 1）・1分12秒）",
    );
    apply({ type: "workflow_run.status_running", workflow_run_id: "wrun_1" });
    apply({
      type: "session.thread_status_terminated",
      session_thread_id: "sthr_1",
    });
    apply({
      type: "session.thread_status_terminated",
      session_thread_id: "sthr_3",
    });
    apply({
      type: "workflow_run.phase_ended",
      workflow_run_id: "wrun_1",
      workflow_run_phase_id: "wphs_2",
      phase_started_id: "sevt_p2",
    });
    clock.now += 48_000;
    apply({
      type: "workflow_run.status_ended",
      workflow_run_id: "wrun_1",
      result: { type: "completed" },
    });
    expect(line()).toBe(
      "ワークフロー: survey the docs（完了・エージェント 3（終了 3）・2分）",
    );
    // The clock stops with the run.
    clock.now += 600_000;
    expect(line()).toBe(
      "ワークフロー: survey the docs（完了・エージェント 3（終了 3）・2分）",
    );
  });

  test("says how a run ended", () => {
    const ended = (result: unknown) => {
      const { apply, line } = tracker();
      apply(created());
      apply({
        type: "workflow_run.phase_started",
        id: "sevt_p1",
        workflow_run_id: "wrun_1",
        workflow_run_phase_id: "wphs_1",
      });
      apply({
        type: "workflow_run.status_ended",
        workflow_run_id: "wrun_1",
        result,
      });
      return line();
    };
    expect(ended({ type: "completed" })).toContain("（完了・");
    expect(ended({ type: "stopped" })).toContain("（停止・");
    expect(
      ended({
        type: "error",
        error: {
          type: "timeout_error",
          message: "The run reached its time limit.",
        },
      }),
    ).toContain("（失敗・");
    // A way of ending this code does not know yet is still an end, and a
    // phase left open by it is no longer shown as running.
    expect(ended({ type: "superseded" })).toBe(
      "ワークフロー: survey the docs（終了・エージェント 0（終了 0）・0秒）",
    );
    expect(ended(undefined)).toContain("（終了・");
  });

  test("keeps runs apart, and tells the caller which one changed", () => {
    const { runs, threadRuns, apply, line } = tracker();
    apply(created());
    apply(
      created({
        workflow_run_id: "wrun_2",
        name: "write the summary",
        phases: [],
      }),
    );
    expect(
      apply({
        type: "session.thread_created",
        session_thread_id: "sthr_1",
        workflow_run_id: "wrun_2",
      }),
    ).toBe(runs.get("wrun_2")!);
    expect(
      apply({ type: "workflow_run.status_idle", workflow_run_id: "wrun_1" }),
    ).toBe(runs.get("wrun_1")!);
    expect(line("wrun_1")).toBe(
      "ワークフロー: survey the docs（一時停止・エージェント 0（終了 0）・0秒）",
    );
    expect(line("wrun_2")).toBe(
      "ワークフロー: write the summary（実行中・エージェント 1（終了 0）・0秒）",
    );
    expect([...threadRuns]).toEqual([["sthr_1", "wrun_2"]]);
    // A phase the plan never declared is shown by its id.
    apply({
      type: "workflow_run.phase_started",
      id: "sevt_p9",
      workflow_run_id: "wrun_2",
      workflow_run_phase_id: "wphs_9",
    });
    expect(line("wrun_2")).toContain("（実行中・wphs_9・");
  });

  test("unknown ids and result types do not throw", () => {
    const { runs, threadRuns, apply, line } = tracker();
    apply(created());
    const before = line();
    for (const event of [
      { type: "workflow_run.status_running", workflow_run_id: "wrun_404" },
      {
        type: "workflow_run.status_ended",
        workflow_run_id: "wrun_404",
        result: { type: "completed" },
      },
      {
        type: "workflow_run.phase_started",
        workflow_run_id: "wrun_404",
        workflow_run_phase_id: "wphs_1",
      },
      {
        type: "workflow_run.phase_ended",
        workflow_run_id: "wrun_1",
        phase_started_id: "sevt_never_started",
      },
      { type: "workflow_run.phase_started", workflow_run_id: "wrun_1" },
      {
        type: "workflow_run.error",
        workflow_run_id: "wrun_1",
        error: { type: "program_error", message: "x" },
      },
      { type: "workflow_run.created" },
      { type: "workflow_run.something_new", workflow_run_id: "wrun_1" },
      // A thread of the session's own subagents, of no run, or seen twice.
      {
        type: "session.thread_created",
        session_thread_id: "sthr_9",
        workflow_run_id: null,
      },
      {
        type: "session.thread_created",
        session_thread_id: "sthr_9",
        workflow_run_id: "wrun_404",
      },
      { type: "session.thread_created", workflow_run_id: "wrun_1" },
      { type: "session.thread_status_terminated", session_thread_id: "sthr_9" },
      { type: "session.thread_status_terminated" },
      { type: "agent.message", content: [] },
      { type: "some.future_event", workflow_run_id: 7 },
    ] satisfies RawEvent[])
      expect(apply(event)).toBeUndefined();
    expect(line()).toBe(before);
    expect(runs.size).toBe(1);
    expect(threadRuns.size).toBe(0);
  });

  test("an event seen twice is counted once", () => {
    const { runs, apply, line } = tracker();
    apply(created());
    const thread = {
      type: "session.thread_created",
      session_thread_id: "sthr_1",
      workflow_run_id: "wrun_1",
    };
    apply(thread);
    apply({ type: "workflow_run.status_idle", workflow_run_id: "wrun_1" });
    // The stream was reopened and the event list replayed the start.
    expect(apply(created({ name: "another name" }))).toBe(runs.get("wrun_1")!);
    expect(apply(thread)).toBeUndefined();
    apply({
      type: "session.thread_status_terminated",
      session_thread_id: "sthr_1",
    });
    expect(
      apply({
        type: "session.thread_status_terminated",
        session_thread_id: "sthr_1",
      }),
    ).toBeUndefined();
    expect(line()).toBe(
      "ワークフロー: survey the docs（一時停止・エージェント 1（終了 1）・0秒）",
    );
    // Nothing reopens a run that ended.
    apply({
      type: "workflow_run.status_ended",
      workflow_run_id: "wrun_1",
      result: { type: "stopped" },
    });
    expect(
      apply({ type: "workflow_run.status_running", workflow_run_id: "wrun_1" }),
    ).toBeUndefined();
    expect(line()).toContain("（停止・");
  });

  test("a name with newlines and mentions is flattened", () => {
    const { apply, line } = tracker();
    apply(
      created({
        name: "  ship it\n\n@everyone   <@123456789> ```\n" + "x".repeat(200),
        phases: [
          { id: "wphs_1", name: "step\none @here " + "y".repeat(100) },
          { id: "wphs_2", name: "b" },
          { id: "wphs_3", name: "c" },
          { id: "wphs_4", name: "d" },
          { id: "wphs_5", name: "e" },
        ],
      }),
    );
    for (const [index, phase] of [
      "wphs_1",
      "wphs_2",
      "wphs_3",
      "wphs_4",
      "wphs_5",
    ].entries())
      apply({
        type: "workflow_run.phase_started",
        id: `sevt_p${index}`,
        workflow_run_id: "wrun_1",
        workflow_run_phase_id: phase,
      });
    const shown = line();
    expect(shown).not.toContain("\n");
    // Nothing in it can ping, with or without `allowed_mentions`.
    expect(shown).not.toContain("@everyone");
    expect(shown).not.toContain("@here");
    expect(shown).not.toContain("<@123456789>");
    expect(
      shown.startsWith(
        "ワークフロー: ship it @\u200beveryone <@\u200b123456789> ``` xxx",
      ),
    ).toBe(true);
    // Long names are cut, and so is a long list of open phases.
    expect(shown).toContain(
      "・step one @\u200bhere yyyyyyyyyyyyyyyyyyyyyyyyy、b、c ほか 2・",
    );
    expect(shown.length).toBeLessThan(300);
    expect(toolLine("read", { file_path: "@everyone.txt" })).toBe(
      "読み込み: @\u200beveryone.txt",
    );
  });

  test("accepts the events as the SDK types them", () => {
    const runs = new Map<string, RunView>(),
      threadRuns = new Map<string, string>();
    const events: BetaManagedAgentsSessionEvent[] = [
      {
        type: "workflow_run.created",
        id: "sevt_1",
        workflow_run_id: "wrun_1",
        name: "typed",
        description: null,
        phases: [{ id: "wphs_1", name: "only", description: null }],
        processed_at: at,
      },
      {
        type: "workflow_run.status_running",
        id: "sevt_2",
        workflow_run_id: "wrun_1",
        processed_at: at,
      },
      {
        type: "workflow_run.phase_started",
        id: "sevt_3",
        workflow_run_id: "wrun_1",
        workflow_run_phase_id: "wphs_1",
        processed_at: at,
      },
      {
        type: "session.thread_created",
        id: "sevt_4",
        session_thread_id: "sthr_1",
        workflow_run_id: "wrun_1",
        agent_name: "reader",
        processed_at: at,
      },
      {
        type: "session.thread_status_terminated",
        id: "sevt_5",
        session_thread_id: "sthr_1",
        agent_name: "reader",
        processed_at: at,
      },
      {
        type: "workflow_run.phase_ended",
        id: "sevt_6",
        workflow_run_id: "wrun_1",
        workflow_run_phase_id: "wphs_1",
        phase_started_id: "sevt_3",
        processed_at: at,
      },
      {
        type: "workflow_run.status_ended",
        id: "sevt_7",
        workflow_run_id: "wrun_1",
        result: { type: "completed" },
        processed_at: at,
      },
    ];
    for (const event of events)
      expect(applyRunEvent(runs, threadRuns, event, 0)).toBe(
        runs.get("wrun_1")!,
      );
    expect(runLine(runs.get("wrun_1")!, 5000)).toBe(
      "ワークフロー: typed（完了・エージェント 1（終了 1）・0秒）",
    );
  });
});

describe("coalescing status edits", () => {
  const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

  test("writes at once, then only the newest of what arrived meanwhile", async () => {
    const written: string[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const update = coalesce(async (text) => {
      written.push(text);
      if (written.length === 1) await blocked;
    }, 0);
    update("1 agent");
    await settle(0);
    expect(written).toEqual(["1 agent"]);
    // Discord is still answering the first edit while four more arrive.
    for (const text of ["2 agents", "3 agents", "4 agents", "5 agents"])
      update(text);
    await settle();
    expect(written).toEqual(["1 agent"]);
    release();
    await settle();
    expect(written).toEqual(["1 agent", "5 agents"]);
  });

  test("spaces the edits out and still writes the last one", async () => {
    const written: string[] = [];
    const update = coalesce(async (text) => {
      written.push(text);
    }, 40);
    update("a");
    update("b");
    await settle(5);
    // "b" waits for the interval; "a" was not held back for it.
    expect(written).toEqual(["a"]);
    update("c");
    await settle(120);
    expect(written).toEqual(["a", "c"]);
    update("done");
    await settle(120);
    expect(written).toEqual(["a", "c", "done"]);
  });

  test("does not repeat a line that is already shown, and a failed edit does not stop the next", async () => {
    const written: string[] = [];
    const update = coalesce(async (text) => {
      written.push(text);
      if (text === "fails") throw new Error("Unknown Message");
    }, 0);
    update("same");
    await settle();
    update("same");
    await settle();
    update("fails");
    await settle();
    update("after");
    await settle();
    expect(written).toEqual(["same", "fails", "after"]);
    // A writer that throws before returning a promise is no different.
    const thrown = coalesce(
      (() => {
        throw new Error("sync");
      }) as never,
      0,
    );
    expect(() => thrown("x")).not.toThrow();
    await settle();
  });
});

import { expect, test, spyOn } from "bun:test";
import pino from "pino";
import { processRun } from "../tools/sandbox";
import { runJevTask, jevTaskSchema } from "../jev-task";
import { emptyUsage, type Context } from "../types";

// Real subprocesses catch the distinction hidden by the legacy exit_code=124 mapping.
test("process diagnostics distinguish timeout, signal exit and parent cancellation", async () => {
  const events: any[] = [];
  const onExit = (event: any) => events.push(event);
  await processRun(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeout: 30, onExit });
  expect(events[0].termination).toBe("command_timeout");
  expect(events[0].signal).toBe("SIGKILL");
  await processRun(process.execPath, ["-e", "process.kill(process.pid, 'SIGTERM')"], { onExit });
  expect(events[1].termination).toBe("signal");
  const controller = new AbortController();
  const pending = processRun(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { signal: controller.signal, onExit });
  controller.abort();
  await expect(pending).rejects.toThrow();
  expect(events[2].termination).toBe("parent_abort");
  expect(events).toHaveLength(3);
});

test("Jev logs correlate operations without retaining private arguments and classify budget expiry", async () => {
  const records: any[] = [];
  const log = pino({ level: "info" }, { write: (line: string) => records.push(JSON.parse(line)) });
  const ctx: Context = { channelId: "200", userId: "300", botId: "400", messageId: "500", thread: true, depth: 0, delivered: false };
  const input = jevTaskSchema.parse({ objective: "PRIVATE objective", state: "PRIVATE state", actions: [
    { id: "secret-id", description: "PRIVATE description", tool: "playwright_cli", arguments: { args: ["eval", "PRIVATE script"] } },
  ] });
  const budget = new AbortController();
  const timeout = spyOn(AbortSignal, "timeout").mockReturnValue(budget.signal);
  try {
    const result = await runJevTask(input, {
      context: ctx, log, assertEnabled: () => {},
      decide: async () => ({ model: "test", answers: { action: { type: "choice", choice: "a0" } }, usage: emptyUsage(), cost: 0 }),
      execute: async (_tool, _args, actionCtx) => {
        expect(actionCtx.jevDiagnostic?.runId).toBe(records[0].jev_run_id);
        expect(actionCtx.jevDiagnostic!.deadline).toBeGreaterThan(performance.now());
        budget.abort();
        throw new Error("PRIVATE failure");
      },
    });
    expect(result.status).toBe("interrupted");
    expect(records.at(-1).termination).toBe("plan_timeout");
    expect(records.at(-1).phase).toBe("action");
    expect(records.find(r => r.msg === "Jev action finished").ok).toBe(false);
    expect(records.every(r => r.jev_run_id === records[0].jev_run_id && r.message_id === "500")).toBe(true);
    expect(JSON.stringify(records)).not.toContain("PRIVATE");
    expect(JSON.stringify(records)).not.toContain("secret-id");
  } finally { timeout.mockRestore(); }
});

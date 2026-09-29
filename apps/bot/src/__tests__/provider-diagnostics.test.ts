import { expect, test } from "bun:test";
import { apiFailure, readHttpFailure } from "../llm-errors";
import { readCompletion } from "../llm-stream";
import { requestCompletion } from "../llm-request";

test("unknown SSE error keeps code and event without exposing upstream content", async () => {
  const raw = { code: "unexpected_backend_failure", type: "backend_error", message: "private prompt and Bearer secret", token: "secret" };
  const response = new Response("data: " + JSON.stringify({ type: "response.failed", response: { error: raw } }) + "\n\n", { headers: { "content-type": "text/event-stream" } });
  try {
    await requestCompletion({
      fetch: async () => response,
      read: (r, s, a) => readCompletion(r, "responses", s, a),
      requestRetries: 0, streamRetries: 0, idleMs: 1000, hooks: {},
    });
    throw new Error("expected provider failure");
  } catch (error: any) {
    expect(error.diagnostics).toMatchObject({ event: "response.failed", code: raw.code, type: raw.type, phase: "stream", response_status: 200 });
    expect(error.diagnostics.elapsed_ms).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(error)).not.toContain("secret");
    expect(JSON.stringify(error)).not.toContain("private prompt");
  }
});

test("HTTP fallback preserves unclassified codes and suppresses arbitrary code values", async () => {
  const error = await readHttpFailure(Response.json({ error: { code: "new_backend_error", message: "private" } }, { status: 502 }), new AbortController().signal);
  expect(error.status).toBe(502);
  expect(error.diagnostics.code).toBe("new_backend_error");
  const unsafe = apiFailure({ code: "Bearer sk-secret", message: "private" });
  expect(unsafe.diagnostics.code).toBeUndefined();
  expect(unsafe.diagnostics.error_fingerprint).toHaveLength(16);
  expect(JSON.stringify(unsafe)).not.toContain("private");
});

test("retry notices carry the reason for malformed JSON", async () => {
  const notices: any[] = [];
  let calls = 0;
  const result = await requestCompletion({
    fetch: async () => Response.json({}),
    read: async () => { if (!calls++) throw new SyntaxError("private body"); return "ok"; },
    requestRetries: 0, streamRetries: 1, idleMs: 1000,
    hooks: { sleep: async () => {}, onRetry: n => notices.push(n) },
  });
  expect(result).toBe("ok");
  expect(notices[0].diagnostics.reason).toBe("invalid_json");
  expect(JSON.stringify(notices)).not.toContain("private body");
});

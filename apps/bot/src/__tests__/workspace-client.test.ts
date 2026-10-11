import { describe, expect, test } from "bun:test";
import { APIUserAbortError } from "@anthropic-ai/sdk";
import { loadConfig } from "../config";
import { ProviderError, providerFailureNotice } from "../llm-errors";
import { apiErrorInfo, createWorkspaceClient, SessionGone, toProviderError, workspaceBaseUrl } from "../workspace/client";
import { outputFiles } from "../workspace/tools";

// Decision record: #76. The official SDK as Anthropic Workspace uses it: which
// key goes to which host, and how its errors become the bot's fixed
// classifications. Every request is answered by a function in this file.

const config = (extra: NodeJS.ProcessEnv = {}) => loadConfig({
  ANTHROPIC_WORKSPACE_API_KEY: "fixture", SANDBOX_ENABLED: "false", SKILLS_ENABLED: "false",
  RUNTIME_STATE_PATH: "", LOG_DIR: "", ...extra,
});
type Sent = { url: string; method?: string; body?: unknown; headers: Record<string, string> };
/** A client whose requests are answered by `reply` and recorded. */
function client(reply: (url: URL) => Response | Promise<Response>, extra: NodeJS.ProcessEnv = {}) {
  const sent: Sent[] = [];
  const fetcher = async (input: unknown, init?: RequestInit) => {
    sent.push({ url: String(input), method: init?.method, body: init?.body, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    return reply(new URL(String(input)));
  };
  // The SDK waits between its own retries; these tests never need them.
  return { sent, client: createWorkspaceClient(config(extra), { fetch: fetcher as unknown as typeof fetch, maxRetries: 0 }) };
}
const session = () => Response.json({ id: "sesn_1", type: "session", status: "idle" });
const rejected = (status: number, error: Record<string, unknown>, headers: Record<string, string> = {}) =>
  Response.json({ type: "error", error, request_id: "req_body" }, { status, headers });
/** What the SDK throws for that response. */
async function thrown(reply: () => Response | Promise<Response>): Promise<unknown> {
  try {
    await client(reply).client.beta.sessions.retrieve("sesn_1");
  } catch (error) {
    return error;
  }
  throw new Error("the request did not fail");
}
/** `ANTHROPIC_CUSTOM_HEADERS` with each credential header twice: first in the
 *  spelling the SDK itself writes, then in another one. */
const TWICE = "X-Api-Key: another-key\nx-api-key: another-key-2\nAuthorization: Bearer another-token\nauthorization: Bearer another-token-2\nx-extra: 1";
/** Runs with variables the SDK would read from the environment by itself. */
async function withEnv(values: Record<string, string>, run: () => Promise<void>) {
  const before = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  try {
    await run();
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("the client", () => {
  test("sends its own key to its own host, whatever the SDK finds in the environment", async () => {
    // In this deployment these belong to Claude Kiro and to the `anthropic` provider.
    await withEnv({
      ANTHROPIC_AUTH_TOKEN: "another-provider", ANTHROPIC_API_KEY: "another-key",
      ANTHROPIC_BASE_URL: "https://elsewhere.example/v1",
    }, async () => {
      const { client: sdk, sent } = client(session);
      await sdk.beta.sessions.retrieve("sesn_1");
      expect(sent).toHaveLength(1);
      expect(sent[0]!.url).toBe("https://api.anthropic.com/v1/sessions/sesn_1?beta=true");
      expect(sent[0]!.headers["x-api-key"]).toBe("fixture");
      expect(sent[0]!.headers.authorization).toBeUndefined();
      expect(sent[0]!.headers["anthropic-beta"]).toContain("managed-agents-2026-04-01");
      expect(JSON.stringify(sent)).not.toContain("another-");
    });
  });

  test("keeps its key when ANTHROPIC_CUSTOM_HEADERS names another one, and sends no Authorization", async () => {
    // The SDK reads this variable by itself and lays its headers over the
    // credentials. Written in any case: header names are not case-sensitive.
    for (const custom of [
      "x-api-key: another-key\nAuthorization: Bearer another-token\nx-extra: 1",
      "X-Api-Key: another-key\nauthorization: Bearer another-token\nx-extra: 1",
      "X-API-KEY: another-key\nAUTHORIZATION: Bearer another-token\nx-extra: 1",
      // One name in several spellings. To the SDK these are separate keys of
      // an object, so a value it is given for one spelling leaves the others.
      TWICE,
      "x-api-key: another-key-2\nX-Api-Key: another-key\nauthorization: Bearer another-token-2\nAuthorization: Bearer another-token\nx-extra: 1",
      "X-Api-Key: another-key\nx-api-key: another-key-2\nX-API-KEY: another-key-3\n" +
        "Authorization: Bearer another-token\nauthorization: Bearer another-token-2\nAUTHORIZATION: Bearer another-token-3\nx-extra: 1",
      " x-api-key : another-key\r\n Authorization : Bearer another-token\r\nx-extra: 1\r\n",
      // A line without a value does not blank the key either. Without a
      // credential among its headers the SDK would refuse to send at all.
      "x-api-key:\nx-extra: 1",
      "X-Api-Key: another-key\nx-api-key:\nx-extra: 1",
      "x-api-key:\nAuthorization: Bearer another-token\nauthorization:\nx-extra: 1",
    ])
      await withEnv({ ANTHROPIC_CUSTOM_HEADERS: custom }, async () => {
        const { client: sdk, sent } = client(session);
        await sdk.beta.sessions.retrieve("sesn_1");
        await sdk.beta.sessions.events.send("sesn_1", { events: [{ type: "user.interrupt" }] });
        expect(sent).toHaveLength(2);
        // Nothing else about a request changes on the way.
        expect(sent.map((request) => request.method)).toEqual(["GET", "POST"]);
        expect(sent[1]!.body).toBe(JSON.stringify({ events: [{ type: "user.interrupt" }] }));
        for (const request of sent) {
          expect(request.url.startsWith("https://api.anthropic.com/v1/sessions/sesn_1")).toBe(true);
          expect(request.headers["x-api-key"]).toBe("fixture");
          expect(request.headers.authorization).toBeUndefined();
          // What does not carry a credential is still sent (#76).
          expect(request.headers["x-extra"]).toBe("1");
        }
        expect(JSON.stringify(sent)).not.toContain("another-");
      });
  });

  test("sends the event stream and the file requests with its key too", async () => {
    // The requests the runner and `send_file` make, the way they make them.
    await withEnv({ ANTHROPIC_CUSTOM_HEADERS: TWICE }, async () => {
      const { client: sdk, sent } = client((url) =>
        url.pathname.endsWith("/events/stream") ? new Response("event: ping\ndata: {}\n\n", { headers: { "content-type": "text/event-stream" } })
          : url.pathname.endsWith("/content") ? new Response("written by the session")
          : Response.json({ data: [], has_more: false, first_id: null, last_id: null }));
      const stream = await sdk.beta.sessions.events.stream("sesn_1", {}, { maxRetries: 0 }).asResponse();
      expect(await stream.text()).toContain("event: ping");
      const files = outputFiles(sdk);
      for await (const file of files.list("sesn_1")) throw new Error(`listed ${file.id}`);
      expect(await (await files.download("file_1")).text()).toBe("written by the session");
      expect(sent.map((request) => new URL(request.url).pathname)).toEqual([
        "/v1/sessions/sesn_1/events/stream", "/v1/files", "/v1/files/file_1/content",
      ]);
      for (const request of sent) {
        expect(new URL(request.url).origin).toBe("https://api.anthropic.com");
        expect(request.headers["x-api-key"]).toBe("fixture");
        expect(request.headers.authorization).toBeUndefined();
        expect(request.headers["x-extra"]).toBe("1");
      }
      expect(JSON.stringify(sent)).not.toContain("another-");
    });
  });

  test("drops a trailing /v1, which the SDK adds to every path itself", async () => {
    expect(workspaceBaseUrl("https://api.anthropic.com")).toBe("https://api.anthropic.com");
    expect(workspaceBaseUrl("https://api.anthropic.com/v1")).toBe("https://api.anthropic.com");
    expect(workspaceBaseUrl("https://proxy.example/anthropic/v1/")).toBe("https://proxy.example/anthropic");
    const { client: sdk, sent } = client(session, { ANTHROPIC_WORKSPACE_BASE_URL: "https://proxy.example/v1" });
    await sdk.beta.sessions.retrieve("sesn_1");
    expect(sent[0]!.url).toBe("https://proxy.example/v1/sessions/sesn_1?beta=true");
  });

  test("does not borrow ANTHROPIC_API_KEY: without its own key it throws and sends nothing", async () => {
    let requests = 0;
    const fetcher = (async () => { requests++; return session(); }) as unknown as typeof fetch;
    const without = loadConfig({ ANTHROPIC_API_KEY: "fixture", RUNTIME_STATE_PATH: "", LOG_DIR: "" });
    await withEnv({ ANTHROPIC_API_KEY: "fixture" }, async () => {
      let failure: unknown;
      try {
        createWorkspaceClient(without, { fetch: fetcher });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(ProviderError);
      expect((failure as ProviderError).kind).toBe("authentication");
    });
    expect(requests).toBe(0);
  });
});

describe("an SDK error", () => {
  test("becomes a fixed classification that keeps nothing the provider wrote", async () => {
    const error = await thrown(() => rejected(401,
      { type: "authentication_error", message: "invalid x-api-key sk-ant-leaked" }, { "request-id": "req_011abc" }));
    const failure = toProviderError(error, "request", "claude-haiku-5-5");
    expect(failure).toMatchObject({ kind: "authentication", retryable: false, status: 401 });
    expect(failure.diagnostics).toMatchObject({
      phase: "request", response_status: 401, request_id: "req_011abc",
      provider: "anthropic_workspace", model: "claude-haiku-5-5", type: "authentication_error",
    });
    expect(failure.message + JSON.stringify(failure.diagnostics)).not.toContain("leaked");
    expect((failure as { cause?: unknown }).cause).toBeUndefined();
    expect(providerFailureNotice(failure)).toBe(
      "プロバイダの認証・権限エラーです。APIキーと利用権限を確認してください。（送信時・HTTP 401）");
  });

  test("is classified by status and by the error type in the body", async () => {
    const kind = async (status: number, type: string) => {
      const failure = toProviderError(await thrown(() => rejected(status, { type, message: "m" })), "request");
      return [failure.kind, failure.retryable];
    };
    expect(await kind(403, "permission_error")).toEqual(["authentication", false]);
    expect(await kind(404, "not_found_error")).toEqual(["not_found", false]);
    expect(await kind(400, "invalid_request_error")).toEqual(["invalid_request", false]);
    expect(await kind(409, "conflict_error")).toEqual(["invalid_request", false]);
    expect(await kind(429, "rate_limit_error")).toEqual(["transient", true]);
    expect(await kind(529, "overloaded_error")).toEqual(["transient", true]);
    expect(await kind(500, "api_error")).toEqual(["transient", true]);
    // Out of credit is a quota problem, not a malformed request.
    expect(await kind(400, "billing_error")).toEqual(["quota", false]);
    expect(await kind(402, "invalid_request_error")).toEqual(["quota", false]);
    // A body that is not the API's error envelope leaves the status to decide.
    const html = await thrown(() => new Response("<html>bad gateway</html>", { status: 502 }));
    expect(toProviderError(html, "stream")).toMatchObject({ kind: "transient", retryable: true, status: 502 });
  });

  test("reads the error code the documentation names, which the SDK's types lack", async () => {
    const error = await thrown(() => rejected(400, {
      type: "invalid_request_error", message: "a workflow run is open", details: { error_code: "workflow_run_open" },
    }));
    expect(apiErrorInfo(error)).toEqual({
      status: 400, type: "invalid_request_error", code: "workflow_run_open", message: "a workflow run is open",
    });
    expect(toProviderError(error, "request").diagnostics.code).toBe("workflow_run_open");
    expect(apiErrorInfo(new Error("not from the SDK"))).toEqual({ message: "" });
  });

  test("from a failed connection is retryable and drops the cause", async () => {
    const error = await thrown(() => { throw new TypeError("connect ECONNREFUSED 10.0.0.7:443"); });
    const failure = toProviderError(error, "stream", "claude-opus-5-5");
    expect(failure).toMatchObject({ kind: "transient", retryable: true });
    expect(failure.status).toBeUndefined();
    expect(failure.diagnostics).toEqual({
      reason: "transport_error", phase: "stream", provider: "anthropic_workspace", model: "claude-opus-5-5",
    });
    expect((failure as { cause?: unknown }).cause).toBeUndefined();
    expect(providerFailureNotice(failure)).toBe(
      "プロバイダとの通信を再試行しましたが、応答を完了できませんでした。（受信中・接続切断）");
  });

  test("for an abort carries no reason, so it is only ever a dropped connection here", () => {
    // Callers throw `signal.reason` first; this is what is left when they did not abort.
    expect(toProviderError(new APIUserAbortError(), "request")).toMatchObject({ kind: "transient", retryable: true });
  });

  test("is passed through when it already is one, and anything else is thrown back", () => {
    const known = new ProviderError("refusal", false);
    expect(toProviderError(known, "stream")).toBe(known);
    const bug = new TypeError("undefined is not a function");
    expect(() => toProviderError(bug, "request")).toThrow(bug);
  });
});

describe("a session that is gone", () => {
  test("is a provider error that says whether the message had been sent", () => {
    const gone = new SessionGone(true, "terminated");
    expect(gone).toBeInstanceOf(ProviderError);
    expect(gone).toMatchObject({ kind: "transient", retryable: false, sent: true, why: "terminated" });
    expect(providerFailureNotice(gone)).toBe(
      "プロバイダとの通信を再試行しましたが、応答を完了できませんでした。（session_terminated）");
    expect(new SessionGone(false, "not_found")).toMatchObject({ sent: false, why: "not_found" });
  });
});

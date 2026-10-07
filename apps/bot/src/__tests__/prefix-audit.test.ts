import { describe, test, expect } from "bun:test";
import { PrefixAudit, requestSegments, type RequestTrace } from "../prefix-audit";
import { LlmClient, type RequestRecord } from "../llm";
import { Agent } from "../agent";
import { loadConfig } from "../config";
import type { Context, Json, ToolDef } from "../types";

const root = { channel: "c", agent: "root", round: 0 };
const body = (messages: Json[], extra: Json = {}): Json => ({
  model: "m",
  tools: [{ type: "function", function: { name: "lookup" } }],
  messages,
  ...extra,
});
const user = (content: string) => ({ role: "user", content });
/** A delivered request: compared, then recorded as the lineage's latest. */
function sent(audit: PrefixAudit, trace: RequestTrace, request: Json) {
  const { report, commit } = audit.observe(trace, request);
  commit();
  return report;
}

describe("prefix audit", () => {
  test("segments follow cache order and name the item kind", () => {
    const kinds = requestSegments({
      model: "m", tools: [{ name: "a" }], instructions: "be brief",
      input: [{ role: "user", content: "hi" }, { type: "function_call_output", call_id: "1" }],
    }).map(s => s.kind);
    expect(kinds).toEqual(["settings", "tool", "system", "item:user", "item:function_call_output"]);
  });
  test("a first request has nothing to compare with", () => {
    const report = sent(new PrefixAudit(), root, body([user("a")]));
    expect(report).toMatchObject({ against: "none", shared_bytes: 0, diverged: null });
  });
  test("appending keeps the whole earlier request as a shared prefix", () => {
    const audit = new PrefixAudit();
    const first = sent(audit, root, body([user("a")]));
    const next = sent(audit, { ...root, round: 1 }, body([user("a"), { role: "assistant", content: "b" }]));
    expect(next).toMatchObject({ against: "lineage", diverged: null, shared_segments: first.segments });
    expect(next.shared_bytes).toBe(first.bytes);
  });
  test("an inserted item is reported at its position, with the bytes before it", () => {
    const audit = new PrefixAudit();
    sent(audit, root, body([user("a"), user("b")]));
    const report = sent(audit, root, body([user("a"), { role: "developer", content: "note" }, user("b")]));
    expect(report.diverged).toBe("item:developer");
    // settings + one tool + the first user message still match.
    expect(report.shared_segments).toBe(3);
  });
  test("a changed tool list or effort diverges before any message", () => {
    const audit = new PrefixAudit();
    sent(audit, root, body([user("a")]));
    expect(sent(audit, root, body([user("a")], { tools: [] })).diverged).toBe("item:user");
    sent(audit, root, body([user("a")]));
    expect(sent(audit, root, body([user("a")], { reasoning_effort: "high" })).diverged).toBe("settings");
  });
  test("dropping the head of the history shares only the static prefix", () => {
    const audit = new PrefixAudit();
    sent(audit, root, body([user("turn 1"), user("turn 2")]));
    const report = sent(audit, root, body([user("turn 2"), user("turn 3")]));
    expect(report).toMatchObject({ diverged: "item:user", shared_segments: 2 });
  });
  test("a child's first request is compared with its root, later ones with itself", () => {
    const audit = new PrefixAudit();
    sent(audit, root, body([user("a"), user("b")]));
    const child = { channel: "c", agent: "child-1", round: 0, child: true };
    const first = sent(audit, child, body([user("a"), user("task")]));
    expect(first).toMatchObject({ against: "root", diverged: "item:user", shared_segments: 3 });
    const second = sent(audit, { ...child, round: 1 }, body([user("a"), user("task"), user("more")]));
    expect(second).toMatchObject({ against: "lineage", diverged: null });
  });
  test("lineages in other channels are never compared", () => {
    const audit = new PrefixAudit();
    sent(audit, root, body([user("a")]));
    expect(sent(audit, { ...root, channel: "other" }, body([user("a")])).against).toBe("none");
    const child = { channel: "third", agent: "child-1", round: 0, child: true };
    expect(sent(audit, child, body([user("a")])).against).toBe("none");
  });
  test("a request that was never delivered is not a prefix for the next one", () => {
    const audit = new PrefixAudit();
    sent(audit, root, body([user("a")]));
    audit.observe(root, body([user("a"), user("b"), user("c")]));
    const retry = sent(audit, root, body([user("a"), user("b"), user("c")]));
    expect(retry.shared_segments).toBe(3);
    expect(retry.shared_bytes).toBeLessThan(retry.bytes);
  });
  test("only a child falls back to its root", () => {
    const audit = new PrefixAudit();
    sent(audit, root, body([user("a")]));
    expect(sent(audit, { channel: "c", agent: "compaction", round: 0 }, body([user("a")])).against).toBe("none");
  });
  test("a block appended to the last merged turn is an append", () => {
    const audit = new PrefixAudit();
    const turn = (...texts: string[]) => ({ role: "user", content: texts.map(text => ({ type: "text", text })) });
    sent(audit, root, body([turn("prompt")]));
    expect(sent(audit, root, body([turn("prompt", "steer")])).diverged).toBeNull();
    expect(sent(audit, root, body([turn("changed", "steer")])).diverged).toBe("item:user");
  });
  test("a root stays comparable while its children keep arriving", () => {
    const audit = new PrefixAudit(2);
    sent(audit, root, body([user("a")]));
    sent(audit, { ...root, channel: "d" }, body([user("a")]));
    for (const agent of ["child-1", "child-2", "child-3"])
      expect(sent(audit, { channel: "c", agent, round: 0, child: true }, body([user("a")])).against).toBe("root");
  });
  test("the least recently used lineage is evicted at capacity", () => {
    const audit = new PrefixAudit(2);
    sent(audit, { ...root, channel: "1" }, body([user("a")]));
    sent(audit, { ...root, channel: "2" }, body([user("a")]));
    sent(audit, { ...root, channel: "1" }, body([user("a")]));
    sent(audit, { ...root, channel: "3" }, body([user("a")]));
    expect(sent(audit, { ...root, channel: "1" }, body([user("a")])).against).toBe("lineage");
    expect(sent(audit, { ...root, channel: "2" }, body([user("a")])).against).toBe("none");
  });
});

describe("request records", () => {
  const tool: ToolDef = {
    type: "function",
    function: { name: "lookup", description: "Find a record", parameters: { type: "object", properties: {} } },
  };
  const ctx: Context = { channelId: "chan", userId: "2", botId: "3", thread: false, depth: 0, delivered: false };
  const selection = { provider: "custom", model: "test-model", effort: "none" };
  const config = () => loadConfig({
    PROVIDER: "custom", LLM_BASE_URL: "https://example.com/v1", LLM_API_KEY: "secret-test", LLM_MODEL: "test-model",
  });

  test("each round of the agent loop is recorded as an append to the previous one", async () => {
    const records: RequestRecord[] = [];
    const bodies: string[] = [], unaudited: string[] = [];
    let round = 0;
    const client = new LlmClient(config(), async (_url, init) => (bodies.push(String(init?.body)), Response.json({
      choices: [{
        message: ++round === 1
          ? { role: "assistant", content: "", tool_calls: [{ id: "a", type: "function", function: { name: "lookup", arguments: "{}" } }] }
          : { role: "assistant", content: "Finished" },
      }],
      usage: { prompt_tokens: 12, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 8 } },
    })), { onCompletion: record => records.push(record) });
    const bare = new LlmClient(config(), async (_url, init) => {
      unaudited.push(String(init?.body));
      return Response.json({ choices: [{ message: { role: "assistant", content: "Finished" } }] });
    });
    await bare.complete(selection, [{ role: "user", content: "secret prompt text" }], [tool]);
    await new Agent(client).run({
      selection, messages: [{ role: "user", content: "secret prompt text" }], tools: [tool], context: { ...ctx },
      maxRounds: 4, temperature: 0.7, nativeSearch: false, execute: async () => ({ ok: true }),
    });
    expect(records.map(r => [r.channel, r.agent, r.round])).toEqual([["chan", "root", 0], ["chan", "root", 1]]);
    expect(records[0]).toMatchObject({ provider: "custom", protocol: "chat", usage_reported: true });
    expect(records[0]!.usage.cached_tokens).toBe(8);
    expect(records[0]!.prefix).toMatchObject({ against: "none" });
    expect(records[1]!.prefix).toMatchObject({ against: "lineage", diverged: null, shared_bytes: records[0]!.prefix!.bytes });
    expect(JSON.stringify(records)).not.toContain("secret prompt text");
    expect(JSON.stringify(records)).not.toContain("secret-test");
    // Auditing reads the body; the provider receives the same bytes without it.
    expect(bodies[0]).toBe(unaudited[0]!);
    expect(Object.keys(records[0]!).sort()).toEqual([
      "agent", "channel", "latency_ms", "model", "prefix", "protocol", "provider", "round", "usage", "usage_reported",
    ]);
  });
  test("a child is logged under a random id, never its model-chosen task name", async () => {
    const records: RequestRecord[] = [];
    const client = new LlmClient(config(), async () => Response.json({
      choices: [{ message: { role: "assistant", content: "done" } }],
    }), { onCompletion: record => records.push(record) });
    const run = () => new Agent(client).run({
      selection, messages: [{ role: "user", content: "task" }], tools: [],
      context: { ...ctx, depth: 1, agentPath: "/root/check_pasted_token" },
      maxRounds: 2, temperature: 0.7, nativeSearch: false, execute: async () => null,
    });
    await run();
    await run();
    expect(records[0]!.agent).toMatch(/^child-[0-9a-f]{8}$/);
    // Two runs that reuse a path are separate request chains.
    expect(records[1]!.agent).not.toBe(records[0]!.agent);
    expect(JSON.stringify(records)).not.toContain("check_pasted_token");
  });
  test("a failing log hook does not discard the completion", async () => {
    const client = new LlmClient(config(), async () => Response.json({
      choices: [{ message: { role: "assistant", content: "kept" } }],
    }), { onCompletion: () => { throw new Error("log sink closed"); } });
    const completion = await client.complete(selection, [{ role: "user", content: "hi" }], []);
    expect(completion.message.content).toBe("kept");
  });
  test("a request the provider rejected does not become the lineage's prefix", async () => {
    const records: RequestRecord[] = [];
    let calls = 0;
    const client = new LlmClient(config(), async () => ++calls === 2
      ? new Response("no", { status: 401 })
      : Response.json({ choices: [{ message: { role: "assistant", content: "ok" } }] }),
      { onCompletion: record => records.push(record) });
    const trace = { channel: "chan", agent: "root", round: 0 };
    const long = [{ role: "user" as const, content: "a" }, { role: "user" as const, content: "b" }];
    await client.complete(selection, [long[0]!], [], { trace });
    await expect(client.complete(selection, long, [], { trace })).rejects.toThrow("HTTP 401");
    await client.complete(selection, long, [], { trace });
    expect(records[1]!.prefix!.shared_bytes).toBeLessThan(records[1]!.prefix!.bytes);
  });
  test("a response without usage is marked instead of reading as zero tokens", async () => {
    const records: RequestRecord[] = [];
    const client = new LlmClient(config(), async () => Response.json({
      choices: [{ message: { role: "assistant", content: "ok" } }],
    }), { onCompletion: record => records.push(record) });
    await client.complete(selection, [{ role: "user", content: "hi" }], []);
    expect(records[0]).toMatchObject({ usage_reported: false });
    // No trace was given, so there is no lineage to audit.
    expect(records[0]!.prefix).toBeUndefined();
  });
});

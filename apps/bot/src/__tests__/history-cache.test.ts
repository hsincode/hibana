import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { Agent } from "../agent";
import { loadConfig } from "../config";
import { History } from "../history";
import { jevTaskModeMessage } from "../jev-task";
import { LlmClient, type RequestRecord } from "../llm";
import { MultiAgentSession } from "../multi-agent";
import { Runtime } from "../runtime";
import { emptyUsage, type Context, type Message, type ToolDef } from "../types";

// A `gpt-` model keeps developer notes in place on the chat protocol, like the
// Responses protocol does, so a note missing from history shows as a divergence.
const selection = { provider: "custom", model: "gpt-test", effort: "none" };
const config = (env: Record<string, string> = {}) => loadConfig({
  PROVIDER: "custom", LLM_BASE_URL: "https://example.com/v1", LLM_API_KEY: "secret-test", LLM_MODEL: "gpt-test", ...env,
});
const tool: ToolDef = {
  type: "function",
  function: { name: "lookup", description: "Find a record", parameters: { type: "object", properties: {} } },
};
const ctx: Context = { channelId: "chan", userId: "2", botId: "3", thread: false, depth: 0, delivered: false };
const prefix: Message[] = [
  { role: "system", content: "You are Hibana." },
  { role: "developer", content: "Policy rebuilt from settings each turn." },
];
const turn = (text: string, size = 30): Message[] => [
  { role: "user", content: text, turnStart: true },
  { role: "assistant", content: "x".repeat(size) },
];
afterEach(() => { setSystemTime(); });

/** Runs turns the way Hibana.turn does: seed from history, run, store the tail. */
async function conversation(turns: number, taskMode: boolean, team = false) {
  const records: RequestRecord[] = [];
  let call = 0;
  const client = new LlmClient(config(), async () => Response.json({
    choices: [{
      message: call++ % 2 === 0
        ? { role: "assistant", content: "", tool_calls: [{ id: `call-${call}`, type: "function", function: { name: "lookup", arguments: "{}" } }] }
        : { role: "assistant", content: `answer ${call}` },
    }],
    usage: { prompt_tokens: 10, completion_tokens: 2 },
  }), { onCompletion: record => records.push(record) });
  const history = new History(config());
  for (let i = 0; i < turns; i++) {
    const messages: Message[] = [...prefix, ...history.get(ctx.channelId, undefined, "key", false, 3600)];
    const seed = messages.length;
    messages.push({ role: "user", content: `request ${i}`, turnStart: true });
    const agent = new Agent(client);
    const options = {
      selection, messages, tools: [tool], context: { ...ctx }, maxRounds: 4, temperature: 0.7, nativeSearch: false,
      jevTaskMode: () => taskMode,
      // Longer than the 8000 characters history used to keep.
      execute: async () => "y".repeat(20000),
    };
    // Subagents are on by default, so the usual root runs inside a session.
    const result = team
      ? await new MultiAgentSession(new Runtime(config()), agent, () => [tool]).runRoot(options)
      : await agent.run(options);
    history.put(ctx.channelId, result.messages.slice(seed), result.usage);
  }
  return records;
}

describe("turn boundary", () => {
  for (const team of [false, true])
    for (const taskMode of [false, true])
      test(`a new turn only appends to the previous turn's last request (${team ? "Multi-Agent root" : "single agent"}, Jev task mode ${taskMode ? "on" : "off"})`, async () => {
        const records = await conversation(8, taskMode, team);
        expect(records).toHaveLength(16);
        // Every request after the first repeats the whole previous request,
        // including the first request of each later turn.
        expect(records.slice(1).map(r => [r.prefix!.against, r.prefix!.diverged])).toEqual(Array(15).fill(["lineage", null]));
      });
});

describe("history window", () => {
  test("short conversations keep every turn, however long they pause", () => {
    setSystemTime(new Date("2026-10-01T00:00:00Z"));
    const h = new History(config());
    h.get("1", undefined, "key", false, 3600);
    for (let i = 0; i < 8; i++) h.put("1", turn(`t${i}`), emptyUsage());
    setSystemTime(new Date("2026-10-01T05:00:00Z"));
    const kept = h.get("1", undefined, "key", false, 3600);
    expect(kept.filter(m => m.turnStart).map(m => m.content)).toEqual(["t0", "t1", "t2", "t3", "t4", "t5", "t6", "t7"]);
  });
  test("over budget, old turns are dropped in one step and the head then stays put", () => {
    const h = new History(config({ HISTORY_MAX_TOKENS: "1000", HISTORY_KEEP_TOKENS: "500" }));
    h.get("1", undefined, "key", false, 3600);
    const heads: string[] = [];
    for (let i = 0; i < 12; i++) {
      // About 220 estimated tokens per turn.
      h.put("1", turn(`t${i}`, 600), emptyUsage());
      const kept = h.get("1", undefined, "key", false, 3600);
      expect(kept[0]!.turnStart).toBe(true);
      expect(h.info("1").estimated_tokens).toBeLessThanOrEqual(1000);
      heads.push(String(kept[0]!.content));
    }
    // The head moves only at a trim, never on every turn.
    const moves = heads.filter((head, i) => i > 0 && head !== heads[i - 1]).length;
    expect(moves).toBeGreaterThan(0);
    expect(moves).toBeLessThanOrEqual(4);
    expect(heads.at(-1)).not.toBe("t0");
  });
  test("a thread is reset after idling past its age, not thinned turn by turn", () => {
    setSystemTime(new Date("2026-10-01T00:00:00Z"));
    const h = new History(config());
    h.get("1", undefined, "key", true, 60);
    for (let i = 0; i < 4; i++) {
      h.put("1", turn(`t${i}`), emptyUsage());
      setSystemTime(new Date(Date.parse("2026-10-01T00:00:00Z") + (i + 1) * 40_000));
    }
    // 160 s after the first turn, but never more than 60 s idle.
    expect(h.get("1", undefined, "key", true, 60).filter(m => m.turnStart)).toHaveLength(4);
    setSystemTime(new Date("2026-10-01T01:00:00Z"));
    expect(h.get("1", undefined, "key", true, 60)).toEqual([]);
  });
  test("a keep size near the limit is capped, so a trim always frees room", () => {
    expect(config({ HISTORY_MAX_TOKENS: "1000", HISTORY_KEEP_TOKENS: "990" }).historyKeepTokens).toBe(500);
  });
  test("Japanese text counts about one token a character", () => {
    const h = new History(config());
    h.get("1", undefined, "key", false, 3600);
    h.put("1", [{ role: "user", content: "あ".repeat(900), turnStart: true }], emptyUsage());
    expect(h.info("1").estimated_tokens).toBeGreaterThan(900);
  });
  test("a rejected conversation is halved from its oldest turns", () => {
    const h = new History(config());
    h.get("1", undefined, "key", false, 3600);
    for (let i = 0; i < 8; i++) h.put("1", turn(`t${i}`, 600), emptyUsage());
    h.shrink("1");
    const kept = h.get("1", undefined, "key", false, 3600).filter(m => m.turnStart).map(m => m.content);
    expect(kept).toEqual(["t4", "t5", "t6", "t7"]);
  });
  test("a thread over the limit is summarized before anything is dropped", async () => {
    const h = new History(config({ HISTORY_MAX_TOKENS: "1000", THREAD_COMPACTION_TOKENS: "1000" }));
    let summarized = "";
    const llm = { complete: async (_s: unknown, messages: Message[]) => {
      summarized = messages[1]!.content!;
      return { message: { role: "assistant", content: "summary" }, usage: emptyUsage(), incomplete: false };
    } };
    h.get("1", undefined, "key", true, 3600);
    for (let i = 0; i < 9; i++) h.put("1", turn(`t${i}`, 600), emptyUsage());
    h.get("1", undefined, "key", true, 3600);
    await h.compact("1", llm as never, selection);
    expect(summarized).toContain("t0");
  });
  test("tool results are stored as they were sent", () => {
    const h = new History(config());
    h.get("1", undefined, "key", false, 3600);
    h.put("1", [
      { role: "user", content: "go", turnStart: true },
      { role: "assistant", content: null, tool_calls: [{ id: "a", type: "function", function: { name: "lookup", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "a", content: "z".repeat(20000) },
      { role: "assistant", content: "done" },
    ], emptyUsage());
    expect(h.get("1", undefined, "key", false, 3600)[2]!.content).toHaveLength(20000);
  });
});

describe("thread compaction", () => {
  test("a compacted thread is not summarized again on the next turn", async () => {
    const h = new History(config({ THREAD_COMPACTION_TOKENS: "1000" }));
    let summaries = 0;
    const llm = { complete: async () => (summaries++, { message: { role: "assistant", content: "summary" }, usage: emptyUsage(), incomplete: false }) };
    h.get("1", undefined, "key", true, 3600);
    for (let i = 0; i < 9; i++) h.put("1", turn(`t${i}`, 600), emptyUsage());
    await h.compact("1", llm as never, selection);
    expect(summaries).toBe(1);
    const afterFirst = h.get("1", undefined, "key", true, 3600);
    expect(afterFirst[0]!.content).toStartWith("Conversation summary:");
    for (let i = 9; i < 11; i++) {
      h.put("1", turn(`t${i}`, 600), emptyUsage());
      await h.compact("1", llm as never, selection);
    }
    expect(summaries).toBe(1);
    // The head is unchanged, so later turns still extend the same prefix.
    expect(h.get("1", undefined, "key", true, 3600)[0]).toEqual(afterFirst[0]!);
  });
  test("a summary followed by one oversized turn is left alone", async () => {
    const h = new History(config({ THREAD_COMPACTION_TOKENS: "1000" }));
    let summaries = 0;
    const llm = { complete: async () => (summaries++, { message: { role: "assistant", content: "summary" }, usage: emptyUsage(), incomplete: false }) };
    h.get("1", undefined, "key", true, 3600);
    h.put("1", turn("small"), emptyUsage());
    h.put("1", turn("huge", 6000), emptyUsage());
    await h.compact("1", llm as never, selection);
    expect(summaries).toBe(1);
    // Only the summary precedes the oversized turn now: nothing new to fold in.
    await h.compact("1", llm as never, selection);
    expect(summaries).toBe(1);
  });
});

describe("Jev task mode note", () => {
  const notes = async (messages: Message[], mode: boolean) => {
    const client = new LlmClient(config(), async () => Response.json({ choices: [{ message: { role: "assistant", content: "ok" } }] }));
    const result = await new Agent(client).run({
      selection, messages, tools: [], context: { ...ctx }, maxRounds: 2, temperature: 0.7, nativeSearch: false,
      jevTaskMode: () => mode, execute: async () => null,
    });
    return result.messages.filter(m => m.content?.includes("Jev action-selection mode")).map(m => m.content!.includes("mode is ON"));
  };
  const ask: Message = { role: "user", content: "hi", turnStart: true };
  test("off is the default and needs no note", async () => {
    expect(await notes([ask], false)).toEqual([]);
  });
  test("a note is added when the mode differs from the last one in the conversation", async () => {
    expect(await notes([ask], true)).toEqual([true]);
    expect(await notes([ask, jevTaskModeMessage(true), ask], true)).toEqual([true]);
    expect(await notes([ask, jevTaskModeMessage(true), ask], false)).toEqual([true, false]);
    expect(await notes([ask, jevTaskModeMessage(true), jevTaskModeMessage(false), ask], true)).toEqual([true, false, true]);
  });
});

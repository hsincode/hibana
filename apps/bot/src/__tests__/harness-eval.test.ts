import { describe, expect, test } from "bun:test";
import { anthropicCost } from "@hibana/shared/catalog";
import { blind, exclusion, replay, replayPrompt, select, summarize, totals, type ArmResult, type Case } from "../harness-eval";
import type { RequestRecord } from "../llm";

// The comparison itself calls the real API and is run by hand (#69). These
// keep what decides its numbers honest: which turns are replayed, how a turn's
// cost is added up, how the pairs are blinded and how verdicts map back.
const meta = "\n\n[author: Aki; user_id: 111; channel_id: 222; message_id: 333]";
const turn = (extra: Partial<Case> = {}): Case => ({
  id: 1, at: 10 * 3_600_000, scope: "guild", channel: "c1", provider: "anthropic", model: "claude-haiku-5-5", effort: "medium",
  failed: false, latency_ms: 1200, prompt: `こんにちは${meta}`, reply: "やあ", ...extra,
});
const result = (extra: Partial<ArmResult>): ArmResult => ({
  case: 1, arm: "codex", first: true, model: "claude-haiku-5-5", effort: "medium", scope: "guild", ms: 1000,
  requests: 1, input: 100, cache_read: 0, cache_write: 0, output: 10, searches: 0, fetches: 0, cost: 0.01, models: ["claude-haiku-5-5"],
  tools: {}, blocked: [], asked: false, status_messages: 0, error: null, reply: "ok", ...extra,
});

describe("which production turns are replayed", () => {
  const hour = 3_600_000;
  test("leaves out what a new conversation cannot reproduce, with the reason", () => {
    expect(exclusion(turn(), undefined, 6 * hour)).toBeNull();
    expect(exclusion(turn({ prompt: "/retry" }), undefined, 6 * hour)).toBe("no message text");
    expect(exclusion(turn({ prompt: meta }), undefined, 6 * hour)).toBe("no message text");
    expect(exclusion(turn({ prompt: `これ見て${meta}\nAttachments: {"id":"1","filename":"a.png","url":"https://example.test/a.png","bytes":3}` }), undefined, 6 * hour))
      .toBe("has attachments");
    expect(exclusion(turn({ model: "gpt-5.5" }), undefined, 6 * hour)).toBe("model is not on Anthropic's API");
    expect(exclusion(turn({ model: null }), undefined, 6 * hour)).toBe("model is not on Anthropic's API");
    // The log has the message but not the conversation it continued.
    expect(exclusion(turn(), turn().at - hour, 6 * hour)).toBe("follows another turn in the channel");
    expect(exclusion(turn(), turn().at - 7 * hour, 6 * hour)).toBeNull();
  });

  test("judges a follow-up per channel in time order, whatever order the file is in", () => {
    const cases = [
      turn({ id: 3, at: 20 * hour, channel: "c1" }), // 9 hours after id 2: a new conversation
      turn({ id: 2, at: 11 * hour, channel: "c1" }), // 1 hour after id 1: a follow-up
      turn({ id: 1, at: 10 * hour, channel: "c1" }),
      turn({ id: 4, at: 10.5 * hour, channel: "c2" }), // another channel is not a follow-up
      turn({ id: 5, at: 30 * hour, channel: "c3", model: "gpt-5.5", provider: "codex_plus" }),
    ];
    const picked = select(cases, { gapHours: 6, seed: 1 });
    expect(picked.chosen.map((c) => c.id).sort()).toEqual([1, 3, 4]);
    expect(picked.eligible).toBe(3);
    expect(picked.excluded).toEqual({ "follows another turn in the channel": 1, "model is not on Anthropic's API": 1 });
  });

  test("a limit takes the same seeded sample every time", () => {
    const cases = Array.from({ length: 40 }, (_, i) => turn({ id: i + 1, channel: `c${i}`, at: i * hour }));
    const first = select(cases, { gapHours: 6, seed: 7, limit: 5 }).chosen.map((c) => c.id);
    expect(first).toHaveLength(5);
    expect(select(cases, { gapHours: 6, seed: 7, limit: 5 }).chosen.map((c) => c.id)).toEqual(first);
    expect(select(cases, { gapHours: 6, seed: 8, limit: 5 }).chosen.map((c) => c.id)).not.toEqual(first);
    // Not simply the oldest five.
    expect(first).not.toEqual([1, 2, 3, 4, 5]);
    expect(select(cases, { gapHours: 6, seed: 7, ids: [9, 3] }).chosen.map((c) => c.id)).toEqual([3, 9]);
  });

  test("sends the message with the replay's own ids, not the real ones", () => {
    const sent = replayPrompt(`調べて\n続き${meta}`);
    expect(sent).toStartWith("調べて\n続き\n\n[author: Aki; user_id: ");
    expect(sent).not.toContain("111");
    expect(sent).not.toContain("222");
    expect(sent).not.toContain("333");
    expect(replayPrompt("声の入力")).toBe("声の入力");
  });
});

describe("what a turn cost", () => {
  const record = (model: string, usage: Partial<RequestRecord["usage"]>, searches?: number): RequestRecord => ({
    provider: "anthropic", model, protocol: "anthropic", usage_reported: true, latency_ms: 1,
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cached_tokens: 0, cache_write_tokens: 0, ...usage },
    ...(searches && { usage_detail: { web_search_requests: searches } }),
  });
  test("adds every request of the turn, a subagent's on another model included", () => {
    const records = [
      record("claude-opus-5-5", { prompt_tokens: 12_000, cached_tokens: 9_000, cache_write_tokens: 2_000, completion_tokens: 400 }, 2),
      record("claude-haiku-5-5", { prompt_tokens: 5_000, completion_tokens: 300 }),
    ];
    const sum = totals(records);
    expect(sum).toMatchObject({ requests: 2, input: 17_000, cache_read: 9_000, cache_write: 2_000, output: 700, searches: 2, fetches: 0 });
    expect(sum.models).toEqual(["claude-opus-5-5", "claude-haiku-5-5"]);
    expect(sum.cost).toBeCloseTo(
      anthropicCost("claude-opus-5-5", { prompt: 12_000, cache_read: 9_000, cache_write: 2_000, output: 400 })! +
      anthropicCost("claude-haiku-5-5", { prompt: 5_000, cache_read: 0, cache_write: 0, output: 300 })!, 10);
    expect(totals([])).toMatchObject({ requests: 0, cost: 0, models: [] });
  });
});

describe("blinding and the summary", () => {
  test("pairs only the cases that have both arms, the same way for the same seed", () => {
    const results = [
      ...[1, 2, 3, 4, 5, 6, 7, 8].flatMap((id) => [result({ case: id, arm: "codex" }), result({ case: id, arm: "claude" })]),
      result({ case: 9, arm: "codex" }),
    ];
    const key = blind(results, 3);
    expect(key.map((k) => k.id).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(blind(results, 3)).toEqual(key);
    // Both harnesses appear on the left somewhere, or the side would give it away.
    expect(new Set(key.map((k) => k.left)).size).toBe(2);
  });

  test("compares time and cost over the cases both arms finished, and maps left/right back to the harness", () => {
    const results = [
      result({ case: 1, arm: "codex", ms: 10_000, cost: 0.02 }), result({ case: 1, arm: "claude", ms: 5_000, cost: 0.01 }),
      result({ case: 2, arm: "codex", ms: 4_000, cost: 0.01 }), result({ case: 2, arm: "claude", ms: 8_000, cost: 0.03 }),
      // The old harness failed quickly here: that must not count as a fast turn.
      result({ case: 3, arm: "codex", ms: 200, cost: 0, error: "boom", reply: "" }), result({ case: 3, arm: "claude", ms: 6_000, cost: 0.02 }),
      result({ case: 4, arm: "codex" }),
    ];
    const key = [{ id: 1, left: "claude" as const }, { id: 2, left: "codex" as const }, { id: 3, left: "claude" as const }];
    const out = summarize(results, { key, verdicts: { "1": "left", "2": "left", "3": "skip" } });
    expect(out.pairs).toBe(3);
    expect(out.both_finished).toBe(2);
    expect(out.codex.failed).toBe(1);
    expect(out.claude.failed).toBe(0);
    expect(out.codex.seconds.median).toBe(7);
    expect(out.claude.seconds.median).toBe(6.5);
    expect(out.codex.cost.total).toBeCloseTo(0.03, 10);
    expect(out.claude.cost.total).toBeCloseTo(0.04, 10);
    expect(out.ratio).toMatchObject({ claude_faster: 1, claude_cheaper: 1 });
    expect(out.ratio.seconds_median).toBeCloseTo((0.5 + 2) / 2, 10);
    // Case 1: left was claude. Case 2: left was codex. Case 3: not comparable.
    expect(out.quality).toEqual({ claude: 1, codex: 1, same: 0, skipped: 1, unjudged: 0 });
    expect(summarize(results).quality).toBeUndefined();
    expect(summarize(results, { key, verdicts: { "1": "right", "2": "same" } }).quality)
      .toEqual({ claude: 0, codex: 1, same: 1, skipped: 0, unjudged: 1 });
  });
});

describe("a replay", () => {
  test("runs one question through each harness without the API when dry", async () => {
    for (const scope of ["guild", "dm"] as const)
      for (const arm of ["codex", "claude"] as const) {
        const out = await replay(turn({ scope }), arm, true, { perArm: 1, minutes: 1, dry: true });
        expect(out).toMatchObject({ case: 1, arm, scope, error: null, reply: "dry run", requests: 0, cost: 0, status_messages: 0, blocked: [], asked: false });
      }
  });
});

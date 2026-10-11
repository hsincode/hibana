import { describe, expect, test } from "bun:test";
import { anthropicCost } from "@hibana/shared/catalog";
import { amount, blind, dryReply, earlierTurns, exclusion, replay, replayPrompt, reviewPage, select, summarize, totals, type ArmResult, type Case } from "../harness-eval";
import type { RequestRecord } from "../llm";

// The comparison itself calls the real API and is run by hand (#69). These
// keep what decides its numbers honest: which turns are replayed, what each
// harness is given, how a turn's cost is added up, how the pairs are blinded
// and how verdicts map back.
const meta = "\n\n[author: Aki; user_id: 111; channel_id: 222; message_id: 333]";
const turn = (extra: Partial<Case> = {}): Case => ({
  id: "c1-0", at: 1000, scope: "guild", channel: "c1", provider: "anthropic", model: "claude-haiku-5-5", effort: "medium",
  history: [], summarized: false, trimmed: false, earlier_tools: false, prompt: `こんにちは${meta}`, extra_messages: 0, reply: "やあ", tools: [],
  production: { latency_ms: 1200 }, ...extra,
});
const result = (extra: Partial<ArmResult>): ArmResult => ({
  case: "c1-0", arm: "codex", first: true, model: "claude-haiku-5-5", effort: "medium", scope: "guild", ms: 1000,
  requests: 1, input: 100, cache_read: 0, cache_write: 0, output: 10, searches: 0, fetches: 0, cost: 0.01, models: ["claude-haiku-5-5"],
  tools: {}, blocked: [], asked: false, status_messages: 0, files: [], retries: 0, rejected: [], error: null, reply: "ok", setup_failed: false, ...extra,
});

describe("which production turns are replayed", () => {
  test("leaves out what the replay cannot reproduce, with the reason", () => {
    expect(exclusion(turn())).toBeNull();
    expect(exclusion(turn({ prompt: meta }))).toBe("no message text");
    expect(exclusion(turn({ prompt: `これ見て${meta}\nAttachments: {"id":"1","filename":"a.png","url":"https://example.test/a.png","bytes":3}` })))
      .toBe("has attachments");
    expect(exclusion(turn({ model: "gpt-5.5" }))).toBe("model is unknown or not on Anthropic's API");
    // An auto-routed conversation whose route is not known any more.
    expect(exclusion(turn({ model: "auto" }))).toBe("model is unknown or not on Anthropic's API");
    expect(exclusion(turn({ model: null }))).toBe("model is unknown or not on Anthropic's API");
    expect(exclusion(turn({ extra_messages: 1 }))).toBe("more than one message in the turn");
    expect(exclusion(turn({ earlier_tools: true, history: [{ role: "user", content: "動画を作って" }, { role: "assistant", content: "送りました" }] })))
      .toBe("an earlier turn used tools");
    // A follow-up of a plain conversation is replayed: the conversation comes with it.
    expect(exclusion(turn({ history: [{ role: "user", content: "前の質問" }, { role: "assistant", content: "前の答え" }] }))).toBeNull();
  });

  test("counts what it leaves out and takes the same seeded sample every time", () => {
    const cases = [
      ...Array.from({ length: 40 }, (_, i) => turn({ id: `c${i}-0`, channel: `c${i}`, at: i })),
      turn({ id: "x-0", model: "gpt-5.5" }), turn({ id: "y-0", extra_messages: 2 }),
    ];
    const all = select(cases, { seed: 7 });
    expect(all.eligible).toBe(40);
    expect(all.excluded).toEqual({ "model is unknown or not on Anthropic's API": 1, "more than one message in the turn": 1 });
    const first = select(cases, { seed: 7, limit: 5 }).chosen.map((c) => c.id);
    expect(first).toHaveLength(5);
    expect(select(cases, { seed: 7, limit: 5 }).chosen.map((c) => c.id)).toEqual(first);
    expect(select(cases, { seed: 8, limit: 5 }).chosen.map((c) => c.id)).not.toEqual(first);
    // Not simply the oldest five.
    expect(first).not.toEqual(["c0-0", "c1-0", "c2-0", "c3-0", "c4-0"]);
    expect(select(cases, { seed: 7, ids: ["c9-0", "c3-0", "x-0"] }).chosen.map((c) => c.id).sort()).toEqual(["c3-0", "c9-0"]);
  });

  test("a trial can take a fixed number of every model", () => {
    const cases = [
      ...Array.from({ length: 10 }, (_, i) => turn({ id: `h${i}-0`, at: i })),
      ...Array.from({ length: 3 }, (_, i) => turn({ id: `o${i}-0`, at: 20 + i, model: "claude-opus-5-5", effort: "high" })),
      turn({ id: "s0-0", at: 30, model: "claude-sonnet-5-5" }),
    ];
    const picked = select(cases, { seed: 1, perModel: 2 }).chosen.map((c) => c.model);
    expect(picked.filter((m) => m === "claude-haiku-5-5")).toHaveLength(2);
    expect(picked.filter((m) => m === "claude-opus-5-5")).toHaveLength(2);
    expect(picked.filter((m) => m === "claude-sonnet-5-5")).toHaveLength(1);
  });

  test("sends the message with the replay's own ids, not the real ones", () => {
    const sent = replayPrompt(`調べて\n続き${meta}`);
    expect(sent).toStartWith("調べて\n続き\n\n[author: Aki; user_id: ");
    expect(sent).not.toContain("111");
    expect(sent).not.toContain("222");
    expect(sent).not.toContain("333");
    expect(replayPrompt("声の入力")).toBe("声の入力");
  });

  test("gives both harnesses the earlier conversation as the turns it was", () => {
    const turns = earlierTurns([
      { role: "user", content: `一つ目${meta}` }, { role: "assistant", content: "答え一" },
      { role: "user", content: "二つ目" }, // its turn failed in production: no answer was stored
      { role: "user", content: "三つ目" }, { role: "assistant", content: "答え三" },
    ]);
    expect(turns.map((t) => t.map((m) => m.role))).toEqual([["user", "assistant"], ["user"], ["user", "assistant"]]);
    expect(turns[0]![0]).toMatchObject({ turnStart: true });
    expect(turns[0]![0]!.content).not.toContain("111");
    expect(turns[2]![1]).toEqual({ role: "assistant", content: "答え三" });
    // A summary that opens the stored conversation is kept, as its own turn.
    expect(earlierTurns([{ role: "assistant", content: "ここまでの要約" }, { role: "user", content: "次" }]).map((t) => t.map((m) => m.role)))
      .toEqual([["assistant"], ["user"]]);
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
    const ids = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const results = [
      ...ids.flatMap((id) => [result({ case: id, arm: "codex" }), result({ case: id, arm: "claude" })]),
      result({ case: "only-one", arm: "codex" }),
    ];
    const key = blind(results, 3);
    expect(key.map((k) => k.id).sort()).toEqual(ids);
    expect(blind(results, 3)).toEqual(key);
    // Both harnesses appear on the left somewhere, or the side would give it away.
    expect(new Set(key.map((k) => k.left)).size).toBe(2);
  });

  test("dealing again keeps the side of every pair already dealt, whatever the seed", () => {
    const row = (id: string) => [result({ case: id, arm: "codex" }), result({ case: id, arm: "claude" })];
    const first = blind(["a", "b", "c", "d", "e", "f"].flatMap(row), 1);
    // The owner has judged these; later the run gains two cases and `review` runs again.
    for (const seed of [2, 3, 4, 5, 6, 7, 8, 9]) {
      const again = blind(["a", "b", "c", "d", "e", "f", "g", "h"].flatMap(row), seed, first);
      expect(again.slice(0, first.length)).toEqual(first);
      expect(again.map((k) => k.id).sort()).toEqual(["a", "b", "c", "d", "e", "f", "g", "h"]);
    }
  });

  test("compares time and cost over the cases both arms finished, and maps left/right back to the harness", () => {
    const results = [
      result({ case: "a", arm: "codex", ms: 10_000, cost: 0.02 }), result({ case: "a", arm: "claude", ms: 5_000, cost: 0.01 }),
      result({ case: "b", arm: "codex", ms: 4_000, cost: 0.01 }), result({ case: "b", arm: "claude", ms: 8_000, cost: 0.03 }),
      // The old harness failed quickly here: that must not count as a fast turn.
      result({ case: "c", arm: "codex", ms: 200, cost: 0, error: "boom", reply: "" }), result({ case: "c", arm: "claude", ms: 6_000, cost: 0.02 }),
      result({ case: "d", arm: "codex" }),
    ];
    const key = [{ id: "a", left: "claude" as const }, { id: "b", left: "codex" as const }, { id: "c", left: "claude" as const }];
    const out = summarize(results, { key, verdicts: { a: "left", b: "left", c: "skip" } });
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
    // "a": left was claude. "b": left was codex. "c": not comparable.
    expect(out.quality).toEqual({ claude: 1, codex: 1, same: 0, skipped: 1, unjudged: 0 });
    expect(summarize(results).quality).toBeUndefined();
    expect(summarize(results, { key, verdicts: { a: "right", b: "same" } }).quality)
      .toEqual({ claude: 0, codex: 1, same: 1, skipped: 0, unjudged: 1 });
  });
});

describe("the spending limits on the command line", () => {
  test("a missing or mistyped number is an error, not a limit that never applies", () => {
    expect(amount("budget", undefined, 5)).toBe(5);
    expect(amount("limit", undefined)).toBeUndefined();
    expect(amount("budget", "7.5", 5)).toBe(7.5);
    // `--budget $5` in a shell: the next flag is read as the value.
    for (const bad of ["--run", "", "five", "NaN", "0", "-1", "Infinity"])
      expect(() => amount("budget", bad, 5)).toThrow("--budget needs a positive number");
  });
});

describe("the judging page", () => {
  const pair = {
    id: "a-0", history: [{ role: "user" as const, content: "前の質問" }], incomplete: false, prompt: "質問", unavailable: ["publish_site"], production: "本番の返答",
    left: "左の返答 </script><img src=x onerror=alert(1)>", right: null, leftFiles: [{ href: "review-files/a-0/left/1.png", name: "図 'x'.png" }], rightFiles: [],
  };
  const page = reviewPage({ run: "trial", deal: "d1", pairs: [pair] });
  const script = /<script>([\s\S]*)<\/script>/.exec(page)![1]!;

  test("its script is valid JavaScript after the template is filled in", () => {
    // A backslash lost in the template would leave a broken string or regex.
    expect(() => new Function(script)).not.toThrow();
    expect(script).toContain("[\\s\\S]");
  });

  test("a reply cannot close the script element or add markup", () => {
    expect(page.match(/<\/script>/g)).toHaveLength(1);
    expect(script).not.toContain("<img src=x");
    expect(script).toContain("\\u003cimg src=x");
  });

  test("renders escaped text, the delivered files, and hides the production reply until judged", () => {
    const html: Record<string, unknown>[] = [];
    const element = (): Record<string, unknown> => {
      const node: Record<string, unknown> = {
        classList: { toggle() {} }, dataset: {}, addEventListener() {}, append() {}, hidden: false, value: "",
        querySelectorAll: () => [], querySelector: (selector: string) => (selector === ".production" ? production : node),
      };
      html.push(node);
      return node;
    };
    const production: Record<string, unknown> = { hidden: false };
    const document = { getElementById: () => element(), createElement: () => element() };
    new Function("document", "localStorage", script)(document, { getItem: () => null, setItem() {} });
    const section = String(html.find((node) => typeof node.innerHTML === "string")!.innerHTML);
    expect(section).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(section).not.toContain("<img src=x");
    expect(section).toContain("<img src='review-files/a-0/left/1.png'");
    expect(section).toContain("図 &#39;x&#39;.png");
    expect(section).toContain("publish_site");
    expect(section).toContain("返答なし");
    expect(production.hidden).toBe(true);
  });
});

describe("a replay", () => {
  const options = { perArm: 1, minutes: 1, fake: dryReply };

  test("a turn the bot gave up on is a failure, not a fast finished turn", async () => {
    // The bot catches a failed turn, tells the channel and returns no reply.
    for (const arm of ["codex", "claude"] as const) {
      const out = await replay(turn(), arm, true, { ...options, fake: () => { throw new Error("provider is down"); } });
      expect(out.reply).toBe("");
      expect(out.error).not.toBeNull();
      // The notice it sent to the channel is not a progress message.
      expect(out.status_messages).toBe(0);
    }
  });

  test("a long reply sent in several messages is not counted as progress", async () => {
    const out = await replay(turn(), "claude", true, { ...options, fake: () => "あ".repeat(5000) });
    expect(out.error).toBeNull();
    expect(out.status_messages).toBe(0);
  });

  test("the Claude harness gets its context block where a real conversation has it: first", async () => {
    const history: Case["history"] = [{ role: "user", content: "前の質問" }, { role: "assistant", content: "前の答え" }];
    let roles = "";
    const shape = (messages: Parameters<typeof dryReply>[0]) => {
      roles = messages.filter((m) => m.role !== "system").map((m) => (m.content?.startsWith("<hibana_context>") ? "context" : m.role)).join(" ");
      return "ok";
    };
    await replay(turn({ history }), "claude", true, { ...options, fake: shape });
    expect(roles).toBe("context user assistant user");
    await replay(turn(), "claude", true, { ...options, fake: shape });
    expect(roles).toBe("context user");
  });

  test("records the effort that was sent when the log did not have one", async () => {
    const out = await replay(turn({ effort: null }), "codex", true, options);
    expect(out.effort).not.toBeNull();
    expect((await replay(turn({ effort: "low" }), "codex", true, options)).effort).toBe("low");
  });

  test("runs one question through each harness without the API when dry", async () => {
    for (const scope of ["guild", "dm"] as const)
      for (const arm of ["codex", "claude"] as const) {
        const out = await replay(turn({ scope }), arm, true, options);
        expect(out).toMatchObject({ case: "c1-0", arm, scope, error: null, reply: "dry run: 1 messages", requests: 0, cost: 0, blocked: [], asked: false });
      }
  });

  test("both harnesses are sent the earlier conversation before the question", async () => {
    const history: Case["history"] = [
      { role: "user", content: `前の質問${meta}` }, { role: "assistant", content: "前の答え" },
      { role: "user", content: "その次" }, { role: "assistant", content: "次の答え" },
    ];
    for (const arm of ["codex", "claude"] as const) {
      const out = await replay(turn({ history }), arm, true, options);
      expect(out.error).toBeNull();
      // Four earlier messages and the question itself.
      expect(out.reply).toBe("dry run: 5 messages");
    }
  });
});

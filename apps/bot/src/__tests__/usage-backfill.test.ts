import { describe, expect, test } from "bun:test";
import { emptyGuild } from "@hibana/shared/settings";
import {
  calibrate,
  entry,
  historyTurns,
  logTurns,
  parseLogLine,
  reduceMessage,
  snowflakeTime,
  summarize,
  type HistoryMessage,
  type LogLine,
  type RawMessage,
} from "../usage-backfill";

const line = (
  o: Partial<LogLine> & { msg: string; time: number },
): LogLine => ({
  pid: 1,
  ...o,
});
const started = (
  time: number,
  channel: string,
  message_id: string,
  extra = {},
) =>
  line({
    time,
    msg: "Turn started",
    channel,
    message_id,
    provider: "anthropic",
    model: "claude-opus-5-5",
    ...extra,
  });
const completed = (time: number, channel: string, extra = {}) =>
  line({
    time,
    msg: "Turn completed",
    channel,
    provider: "anthropic",
    model: "claude-opus-5-5",
    ...extra,
  });

describe("parseLogLine", () => {
  test("keeps the fields a turn needs and drops the rest", () => {
    const l = parseLogLine(
      JSON.stringify({
        level: 30,
        time: 5,
        pid: 7,
        hostname: "h",
        channel: "c",
        message_id: "m",
        provider: "p",
        model: "x",
        usage: { prompt_tokens: 1 },
        msg: "Turn started",
      }),
    );
    expect(l).toEqual({
      time: 5,
      pid: 7,
      msg: "Turn started",
      channel: "c",
      message_id: "m",
      provider: "p",
      model: "x",
      failure_code: undefined,
    });
  });
  test("skips what is not a log line", () => {
    expect(parseLogLine("")).toBeNull();
    expect(parseLogLine("not json")).toBeNull();
    expect(parseLogLine(JSON.stringify({ msg: "no time" }))).toBeNull();
  });
});

describe("logTurns", () => {
  test("a success is posted when it ends, with the model the route chose", () => {
    const r = logTurns([
      started(100, "c1", "m1", { model: "auto" }),
      line({
        time: 110,
        msg: "Auto route selected",
        channel: "c1",
        message_id: "m1",
        model: "claude-haiku-5-5",
      }),
      completed(500, "c1", { model: "claude-haiku-5-5" }),
    ]);
    expect(r.turns).toEqual([
      {
        channel: "c1",
        messageId: "m1",
        started: 100,
        at: 500,
        provider: "anthropic",
        model: "claude-haiku-5-5",
        failed: false,
      },
    ]);
  });
  test("a failure is posted at its start, and keeps the routed model", () => {
    const r = logTurns([
      started(100, "c1", "m1", { model: "auto" }),
      line({
        time: 110,
        msg: "Auto route selected",
        channel: "c1",
        message_id: "m1",
        model: "claude-sonnet-5-5",
      }),
      line({
        time: 300,
        msg: "Hibana operation failed",
        failure_code: "provider_error",
      }),
    ]);
    expect(r.turns).toHaveLength(1);
    expect(r.turns[0]).toMatchObject({
      at: 100,
      failed: true,
      model: "claude-sonnet-5-5",
    });
    expect(r.ambiguous).toBe(0);
  });
  test("an error that is not a turn's failure ends nothing", () => {
    const r = logTurns([
      started(100, "c1", "m1"),
      line({ time: 150, msg: "Hibana operation failed" }),
      completed(200, "c1"),
    ]);
    expect(r.turns).toHaveLength(1);
    expect(r.turns[0].failed).toBe(false);
  });
  test("completions end the oldest open turn of their channel", () => {
    const r = logTurns([
      started(100, "c1", "m1"),
      started(110, "c2", "m2"),
      started(120, "c1", "m3"),
      completed(200, "c2"),
      completed(300, "c1"),
      completed(400, "c1"),
    ]);
    expect(r.turns.map((t) => [t.messageId, t.at])).toEqual([
      ["m1", 300],
      ["m2", 200],
      ["m3", 400],
    ]);
  });
  test("a stop or a crash leaves nothing posted", () => {
    const r = logTurns([
      started(100, "c1", "m1"),
      line({ time: 200, msg: "Stopping Hibana" }),
      line({ time: 300, msg: "Hibana ready", pid: 2 }),
      started(400, "c1", "m2", { pid: 2 }),
      line({ time: 500, msg: "Hibana ready", pid: 3 }),
      started(600, "c1", "m3", { pid: 3 }),
    ]);
    expect(r.turns).toHaveLength(0);
    expect(r.aborted).toBe(2);
    expect(r.open).toBe(1);
  });
  test("a failure with two turns open is counted as ambiguous", () => {
    const r = logTurns([
      started(100, "c1", "m1"),
      started(110, "c2", "m2"),
      line({
        time: 200,
        msg: "Hibana operation failed",
        failure_code: "timeout",
      }),
      completed(300, "c2"),
    ]);
    expect(r.ambiguous).toBe(1);
    expect(r.turns.map((t) => [t.messageId, t.failed])).toEqual([
      ["m1", true],
      ["m2", false],
    ]);
  });
});

const msg = (
  at: number,
  authorId: string,
  o: Partial<HistoryMessage> = {},
): HistoryMessage => ({
  id: `m${at}`,
  at,
  authorId,
  ours: authorId === "bot",
  trigger: authorId !== "bot",
  until: at,
  ...o,
});
const MIN = 60_000;

describe("historyTurns", () => {
  test("a message the bot answers is one turn by its author", () => {
    expect(historyTurns([msg(0, "a"), msg(MIN, "bot")])).toEqual([
      { messageId: "m0", userId: "a", at: 0 },
    ]);
  });
  test("no answer, or one past the window, is no turn", () => {
    expect(historyTurns([msg(0, "a")])).toEqual([]);
    expect(historyTurns([msg(0, "a"), msg(31 * MIN, "bot")])).toEqual([]);
  });
  test("messages the rule would not answer are not turns", () => {
    expect(
      historyTurns([msg(0, "a", { trigger: false }), msg(MIN, "bot")]),
    ).toEqual([]);
  });
  test("two people waiting are two turns; one person twice is one", () => {
    const turns = historyTurns([
      msg(0, "a"),
      msg(1000, "a"),
      msg(2000, "b"),
      msg(MIN, "bot"),
      msg(2 * MIN, "bot"),
    ]);
    expect(turns.map((t) => [t.userId, t.messageId])).toEqual([
      ["a", "m0"],
      ["b", "m2000"],
    ]);
  });
  test("a message while the person's turn is still edited steers it", () => {
    const turns = historyTurns([
      msg(0, "a"),
      msg(MIN, "bot", { until: 10 * MIN }),
      msg(5 * MIN, "a"),
      msg(10 * MIN, "bot"),
      msg(20 * MIN, "a"),
      msg(21 * MIN, "bot"),
    ]);
    expect(turns.map((t) => t.at)).toEqual([0, 20 * MIN]);
  });
});

describe("reduceMessage", () => {
  const raw = (o: Partial<RawMessage>): RawMessage => ({
    id: "1234567890123456789",
    type: 0,
    content: "",
    pinned: false,
    edited_timestamp: null,
    author: { id: "u1" },
    mentions: [],
    ...o,
  });
  const where = { dm: false, thread: false };
  const guild = emptyGuild();
  const run = (o: Partial<RawMessage>, w = where) =>
    reduceMessage(raw(o), "111", w, guild, []);
  test("the bot's rule decides: a mention, a trigger word, or a DM", () => {
    expect(run({ content: "hi", mentions: [{ id: "111" }] }).trigger).toBe(
      true,
    );
    expect(run({ content: "hibana 天気は?" }).trigger).toBe(true);
    expect(run({ content: "hello" }).trigger).toBe(false);
    expect(run({ content: "hello" }, { dm: true, thread: false }).trigger).toBe(
      true,
    );
  });
  test("bots, system messages and /image are never turns", () => {
    expect(
      run({ content: "hibana", author: { id: "u2", bot: true } }).trigger,
    ).toBe(false);
    expect(run({ content: "hibana", type: 7 }).trigger).toBe(false);
    expect(
      run({ content: "<@111> /image a cat", mentions: [{ id: "111" }] })
        .trigger,
    ).toBe(false);
  });
  test("the bot's own message is an answer, until its last edit", () => {
    const m = run({
      author: { id: "111", bot: true },
      edited_timestamp: "2026-10-01T00:00:00.000Z",
    });
    expect(m.ours).toBe(true);
    expect(m.trigger).toBe(false);
    expect(m.until).toBe(Date.parse("2026-10-01T00:00:00.000Z"));
    expect(m.at).toBe(snowflakeTime("1234567890123456789"));
  });
});

describe("calibrate", () => {
  test("compares turns, days and users without naming anyone", () => {
    const day = 86_400_000;
    const c = calibrate(
      [
        { messageId: "m1", userId: "a", at: 0 },
        { messageId: "m2", userId: "b", at: day },
      ],
      [
        { messageId: "m1", userId: "a", at: 0 },
        { messageId: "m9", userId: "c", at: 0 },
      ],
    );
    expect(c).toEqual({
      logged: 2,
      found: 2,
      matched: 1,
      dayError: 2,
      usersLogged: 2,
      usersFound: 2,
      usersShared: 1,
    });
  });
});

describe("entry and summarize", () => {
  test("an entry is what /internal/logs counts, with no text", () => {
    const e = entry(
      {
        at: 1,
        guildId: null,
        channelId: "c",
        userId: "u",
        failed: true,
        model: "m",
        provider: "p",
      },
      "logs",
    );
    expect(e).toEqual({
      at: 1,
      guild_id: null,
      channel_id: "c",
      user_id: "u",
      username: "u",
      prompt: "",
      reply: null,
      provider: "p",
      model: "m",
      error: "failed",
      failure_code: null,
      source: "logs",
    });
    expect(
      entry({ at: 1, guildId: "g", channelId: "c", userId: "u" }, "history"),
    ).toMatchObject({
      provider: null,
      model: null,
      error: null,
    });
  });
  test("months run from the 5th, like the dashboard", () => {
    const at = (d: string) => Date.parse(`${d}T12:00:00Z`);
    const rows = summarize([
      entry(
        { at: at("2026-09-04"), guildId: "g", channelId: "c", userId: "a" },
        "history",
      ),
      entry(
        { at: at("2026-09-05"), guildId: "g", channelId: "c", userId: "a" },
        "history",
      ),
      entry(
        {
          at: at("2026-10-04"),
          guildId: "g",
          channelId: "c",
          userId: "b",
          failed: true,
        },
        "logs",
      ),
    ]);
    expect(rows).toEqual([
      { month: "2026-08", turns: 1, from_logs: 0, failed: 0, users: 1 },
      { month: "2026-09", turns: 2, from_logs: 1, failed: 1, users: 2 },
    ]);
  });
});

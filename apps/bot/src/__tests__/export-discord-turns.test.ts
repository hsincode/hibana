import { describe, expect, test } from "bun:test";
import { attachmentsOf, collect, discordReader, finalReply, promptOf, turnsFromLog, Unavailable, usable, type Read, type Turn } from "../export-discord-turns";

// The export runs by hand on the machine that has the bot's log, with the
// bot's token (#69). These keep what it does there honest without Discord:
// which turns it takes from the log, which messages it reads, what it writes,
// and what it does when Discord does not answer.
const EPOCH = 1_420_070_400_000;
const T0 = 1_791_000_000_000;
/** A Discord id made `ms` after T0, so ids order and date as they would. */
const id = (ms: number) => String(BigInt(T0 - EPOCH + ms) << 22n);
const line = (entry: object) => JSON.stringify(entry);
const MIN = 60_000;

describe("turns in the log", () => {
  test("follows each channel's turn from its start to its end", () => {
    const turns = turnsFromLog([
      line({ msg: "Turn started", time: 1000, channel: "c1", message_id: "m1", provider: "anthropic", model: "auto", effort: null }),
      line({ msg: "Auto route selected", time: 1100, channel: "c1", message_id: "m1", model: "claude-haiku-5-5", effort: "xhigh" }),
      // Another channel's turn runs at the same time.
      line({ msg: "Turn started", time: 1200, channel: "c2", message_id: "m2", provider: "chatgpt", model: "gpt-6.1-sol", effort: "medium" }),
      line({ msg: "LLM request completed", time: 1300, channel: "c1", agent: "root", round: 0, child: false }),
      // A subagent's request and a thread's summary are not the turn's own.
      line({ msg: "LLM request completed", time: 1350, channel: "c1", agent: "root/child-1", round: 0, child: true }),
      line({ msg: "LLM request completed", time: 1360, channel: "c1", agent: "compaction", round: 0 }),
      line({ msg: "LLM request completed", time: 1400, channel: "c1", agent: "root", round: 1, child: false }),
      line({ msg: "Turn completed", time: 1500, channel: "c1", provider: "anthropic", model: "claude-haiku-5-5", latency_ms: 500 }),
      line({ msg: "LLM request completed", time: 1600, channel: "c2", agent: "root", child: false }),
      line({ msg: "Turn completed", time: 1700, channel: "c2", provider: "chatgpt", model: "gpt-6.1-sol", latency_ms: 500 }),
      // A turn that failed never logs its end; a /retry has no message.
      line({ msg: "Turn started", time: 2000, channel: "c1", message_id: "m3", provider: "anthropic", model: "claude-opus-5-5", effort: "medium" }),
      line({ msg: "Turn started", time: 3000, channel: "c1", provider: "anthropic", model: "claude-opus-5-5", effort: "medium" }),
      line({ msg: "Turn completed", time: 3500, channel: "c1", provider: "anthropic", model: "claude-opus-5-5", latency_ms: 500 }),
      "not json", line({ msg: "Turn completed", time: 9, channel: "c9" }),
    ]);
    expect(turns.map((t) => [t.channel, t.message_id, t.requests, Boolean(t.completed)])).toEqual([
      ["c1", "m1", 2, true], ["c2", "m2", 1, true], ["c1", "m3", 0, false], ["c1", "", 0, true],
    ]);
    expect(turns[0]).toMatchObject({ route: { model: "claude-haiku-5-5", effort: "xhigh" }, completed: { at: 1500, latency_ms: 500 }, last_request: 1400 });
    // Only a finished turn on a Claude model that a message started is taken.
    expect(turns.map(usable)).toEqual([true, false, false, false]);
    expect(usable({ channel: "c", message_id: "m", started: 0, requests: 1, provider: "claude_kiro", model: "claude-opus-5-5", completed: { at: 1 } })).toBe(true);
  });

  test("a turn older than the log's first request line has an unknown number of requests, not none", () => {
    const turns = turnsFromLog([
      line({ msg: "Turn started", time: 1000, channel: "c1", message_id: "old" }),
      line({ msg: "Turn completed", time: 1500, channel: "c1", provider: "anthropic", model: "claude-opus-5-5" }),
      // The bot begins to log its requests here.
      line({ msg: "LLM request completed", time: 5000, channel: "c9", agent: "root", child: false }),
      line({ msg: "Turn started", time: 6000, channel: "c1", message_id: "new" }),
      line({ msg: "LLM request completed", time: 6100, channel: "c1", agent: "root", child: false }),
      line({ msg: "LLM request completed", time: 6200, channel: "c1", agent: "root", child: false }),
      line({ msg: "Turn completed", time: 6500, channel: "c1", provider: "anthropic", model: "claude-opus-5-5" }),
    ]);
    expect(turns.map((t) => t.requests)).toEqual([null, 2]);
  });

  test("two turns started from one message are both left out", () => {
    const turns = turnsFromLog([
      line({ msg: "Turn started", time: 1000, channel: "c1", message_id: "m1", provider: "anthropic", model: "claude-opus-5-5" }),
      line({ msg: "Turn completed", time: 1500, channel: "c1", provider: "anthropic", model: "claude-opus-5-5" }),
      // A message sent into the end of that turn runs as a turn under the first message's id.
      line({ msg: "Turn started", time: 1600, channel: "c1", message_id: "m1", provider: "anthropic", model: "claude-opus-5-5" }),
      line({ msg: "Turn completed", time: 2000, channel: "c1", provider: "anthropic", model: "claude-opus-5-5" }),
    ]);
    expect(turns.map((t) => [t.shared, usable(t)])).toEqual([[true, false], [true, false]]);
  });
});

describe("what is read back from Discord", () => {
  test("the reply is what the bot posted after the turn's last request", () => {
    expect(finalReply([])).toBeNull();
    expect(finalReply([{ id: id(1000), content: "答え" }])).toBe("答え");
    const posted = [
      { id: id(1000), content: "Auto Routing: **Opus 5.5 Medium**" },
      { id: id(58_000), content: "調べます" }, // the progress message, posted two seconds before the reply
      { id: id(60_000), content: "一つ目" }, { id: id(64_500), content: "二つ目" }, // the reply; its second piece was held back
    ];
    expect(finalReply(posted, T0 + 59_500)).toBe("一つ目\n二つ目");
    // Given out of order, as the API returns them newest first.
    expect(finalReply([...posted].reverse(), T0 + 59_500)).toBe("一つ目\n二つ目");
  });

  test("without that time, the reply is the last run of messages with no pause between them", () => {
    expect(finalReply([
      { id: id(1000), content: "Auto Routing: **Opus 5.5 Medium**" },
      { id: id(2000), content: "ファイルを調べています" },
      { id: id(60_000), content: "一つ目" }, { id: id(60_700), content: "二つ目" },
    ])).toBe("一つ目\n二つ目");
    // The same when the log's time matches nothing that was posted.
    expect(finalReply([{ id: id(2000), content: "進捗" }, { id: id(60_000), content: "答え" }], T0 + 900_000)).toBe("答え");
  });

  test("a route notice on the reply's first line is taken off, not the reply with it", () => {
    expect(finalReply([{ id: id(1000), content: "Auto Routing: **Haiku 5.5**\n答えです" }])).toBe("答えです");
    expect(finalReply([{ id: id(1000), content: "Auto Routing: **Haiku 5.5**" }])).toBeNull();
    // A message with only a file has no text.
    expect(finalReply([{ id: id(1000), content: "答え" }, { id: id(1500), content: "" }])).toBe("答え");
  });

  test("writes the message as the bot gave it to the model, with the appended ids left out", () => {
    expect(promptOf({ id: "1", content: "<@99> 調べて", author: { id: "20", global_name: "Aki", username: "aki" } }))
      .toBe("<@99> 調べて\n\n[author: Aki; user_id: 0; channel_id: 0; message_id: 0]");
    const withFile = promptOf({ id: "1", content: "これ", author: { id: "20", global_name: null, username: "aki" }, attachments: [{ id: "555", filename: "a.png", size: 3 }] });
    expect(withFile).toEndWith('[author: aki; user_id: 0; channel_id: 0; message_id: 0]\nAttachments: {"id":"0","filename":"a.png","url":"","bytes":3}');
    expect(withFile).not.toContain("555");
  });

  test("the files of the message it replies to count as its own, and an unseen one is unknown", () => {
    const reply = { id: "2", content: "これを説明して", author: { id: "20", username: "aki" }, message_reference: { message_id: "1" } };
    expect(attachmentsOf({ id: "1", content: "x" })).toEqual([]);
    expect(attachmentsOf({ ...reply, referenced_message: { attachments: [{ id: "777", filename: "cat.png", size: 9 }] } })).toHaveLength(1);
    expect(promptOf({ ...reply, referenced_message: { attachments: [{ id: "777", filename: "cat.png", size: 9 }] } })).toContain('Attachments: {"id":"0","filename":"cat.png"');
    // The message it replied to was deleted: what it had attached is not known.
    expect(attachmentsOf({ ...reply, referenced_message: null })).toBeNull();
    expect(attachmentsOf(reply)).toBeNull();
  });

  const BOT = "990000000000000001";
  const USER = "424242424242424242";
  const turn = (channel: string, message: string, at: number, extra: Partial<Turn> = {}): Turn => ({
    channel, message_id: message, started: at, provider: "anthropic", model: "claude-haiku-5-5", effort: "medium", requests: 1,
    completed: { at: at + 5000, provider: "anthropic", model: "claude-haiku-5-5", latency_ms: 5000 }, ...extra,
  });
  type Posted = { id: string; author: string; content: string; attachments?: object[]; edited_timestamp?: string; message_reference?: object; referenced_message?: object | null };
  /** A fake Discord: channels, their messages, and every path that was read. */
  function discord(channels: Record<string, { guild?: string; messages: Posted[] }>) {
    const paths: string[] = [];
    const read: Read = async (path) => {
      paths.push(path);
      if (path === "/users/@me") return { id: BOT };
      const [, channelId, rest] = /^\/channels\/([^/?]+)(.*)$/.exec(path)!;
      const channel = channels[channelId!];
      if (!channel) return undefined;
      if (!rest) return { id: channelId, ...(channel.guild && { guild_id: channel.guild }) };
      const shape = ({ author, ...m }: Posted) => ({ attachments: [], ...m, author: { id: author, bot: author === BOT, global_name: "Aki", username: "aki" } });
      const one = /^\/messages\/(\d+)$/.exec(rest);
      if (one) { const m = channel.messages.find((x) => x.id === one[1]); return m ? shape(m) : undefined; }
      const after = /^\/messages\?after=(\d+)&limit=100$/.exec(rest)!;
      return channel.messages.filter((m) => BigInt(m.id) > BigInt(after[1]!)).map(shape).reverse();
    };
    return { read, paths };
  }
  const C = "777000111", OTHER = "777000222", LOST = "777000333";

  test("exports each usable turn with the exchanges right before it, and reads nothing else", async () => {
    const q1 = id(0), q2 = id(10 * MIN), q3 = id(120 * MIN);
    const turns = [
      turn(C, q1, T0, { requests: 3 }),
      turn(C, q2, T0 + 10 * MIN),
      // More than thirty minutes later: not given the earlier exchanges.
      turn(C, q3, T0 + 120 * MIN),
      // Another provider's channel is never read.
      turn(OTHER, id(1), T0, { provider: "chatgpt", model: "gpt-6.1-sol", completed: { at: T0 + 1, provider: "chatgpt", model: "gpt-6.1-sol" } }),
      // A channel the bot can no longer see.
      turn(LOST, id(2), T0),
    ];
    const { read, paths } = discord({
      [C]: { guild: "880000000000000001", messages: [
        { id: q1, author: USER, content: "最初の質問" }, { id: id(4000), author: BOT, content: "最初の答え" },
        { id: id(5 * MIN), author: "424243", content: "関係ない発言" },
        { id: q2, author: USER, content: "続きの質問" }, { id: id(10 * MIN + 4000), author: BOT, content: "続きの答え" },
        { id: q3, author: USER, content: "あとの質問", edited_timestamp: "2026-10-10T00:00:00Z" }, { id: id(120 * MIN + 4000), author: BOT, content: "あとの答え" },
      ] },
      [OTHER]: { guild: "880000000000000001", messages: [] },
    });
    const counts: string[] = [];
    const cases = await collect(turns, read, (key) => counts.push(key));
    expect(cases).toHaveLength(3);
    expect(cases[0]).toMatchObject({ scope: "guild", model: "claude-haiku-5-5", effort: "medium", source: "discord", history: [], earlier_tools: false, after_unknown: false,
      extra_messages: 0, attachments_unknown: false, edited: false, reply: "最初の答え", requests: 3, production: { latency_ms: 5000 } });
    expect(String(cases[0]!.prompt)).toStartWith("最初の質問\n\n[author: Aki;");
    expect(cases[1]).toMatchObject({ reply: "続きの答え", earlier_tools: true });
    expect((cases[1]!.history as { role: string; content: string }[]).map((h) => [h.role, h.content.split("\n")[0]])).toEqual([["user", "最初の質問"], ["assistant", "最初の答え"]]);
    expect(cases[2]).toMatchObject({ history: [], earlier_tools: false, after_unknown: false, edited: true, reply: "あとの答え" });
    // The ids of the channel, the server, the messages and the people are not written.
    const written = JSON.stringify(cases);
    for (const real of [C, "880000000000000001", q1, q2, q3, USER, BOT]) expect(written).not.toContain(real);
    expect(new Set(cases.map((c) => c.id)).size).toBe(3);
    expect(counts).toContain("channels that can no longer be read");
    // Three kinds of address, and none for the other provider's channel.
    expect(paths.every((p) => p === "/users/@me" || new RegExp(`^/channels/(${C}|${LOST})(/messages(/\\d+|\\?after=\\d+&limit=100))?$`).test(p))).toBe(true);
    expect(paths.some((p) => p.includes(OTHER))).toBe(false);
  });

  test("the reply is the one posted while the turn ran, even when the next question came first", async () => {
    // A asks; B asks while the bot is still working; A's reply comes after B's question.
    const qa = id(0), qb = id(20_000);
    const turns = [
      turn(C, qa, T0, { completed: { at: T0 + 60_000, provider: "anthropic", model: "claude-haiku-5-5" }, last_request: T0 + 58_000 }),
      turn(C, qb, T0 + 60_500, { completed: { at: T0 + 70_000, provider: "anthropic", model: "claude-haiku-5-5" }, last_request: T0 + 69_000 }),
    ];
    const { read } = discord({ [C]: { messages: [
      { id: qa, author: USER, content: "A の質問" }, { id: id(3000), author: BOT, content: "調べています" },
      { id: qb, author: "424243", content: "B の質問" },
      { id: id(59_000), author: BOT, content: "A への答え" }, { id: id(69_500), author: BOT, content: "B への答え" },
    ] } });
    const cases = await collect(turns, read);
    expect(cases.map((c) => c.reply)).toEqual(["A への答え", "B への答え"]);
    // B's question is another person's: it was not sent into A's turn.
    expect(cases[0]).toMatchObject({ extra_messages: 0 });
    expect((cases[1]!.history as { content: string }[]).map((h) => h.content.split("\n")[0])).toEqual(["A の質問", "A への答え"]);
  });

  test("counts what the same person sent while the turn ran", async () => {
    const q = id(0);
    const { read } = discord({ [C]: { messages: [
      { id: q, author: USER, content: "X を調べて" }, { id: id(20_000), author: USER, content: "やっぱり Y も" },
      { id: id(50_000), author: BOT, content: "X と Y です" }, { id: id(90_000), author: USER, content: "ありがとう" },
    ] } });
    const [only] = await collect([turn(C, q, T0, { completed: { at: T0 + 55_000, provider: "anthropic", model: "claude-haiku-5-5" } })], read);
    expect(only).toMatchObject({ extra_messages: 1, reply: "X と Y です" });
  });

  test("a turn right after one that cannot be rebuilt says so, and is not given a partial conversation", async () => {
    const q1 = id(0), q2 = id(5 * MIN), q3 = id(8 * MIN), q4 = id(200 * MIN), q5 = id(203 * MIN);
    const failed: Turn = { channel: C, message_id: q1, started: T0, provider: "anthropic", model: "claude-haiku-5-5", requests: 4 };
    const { read } = discord({ [C]: { messages: [
      { id: q1, author: USER, content: "調べて報告して" },
      { id: q2, author: USER, content: "続けて" }, { id: id(5 * MIN + 4000), author: BOT, content: "報告です" },
      { id: q3, author: USER, content: "ありがとう" }, { id: id(8 * MIN + 4000), author: BOT, content: "どういたしまして" },
      // q4's own message was deleted afterwards.
      { id: q5, author: USER, content: "その次" }, { id: id(203 * MIN + 4000), author: BOT, content: "はい" },
    ] } });
    const cases = await collect([failed, turn(C, q2, T0 + 5 * MIN), turn(C, q3, T0 + 8 * MIN), turn(C, q4, T0 + 200 * MIN), turn(C, q5, T0 + 203 * MIN)], read);
    expect(cases.map((c) => [String(c.prompt).split("\n")[0], c.after_unknown, (c.history as unknown[]).length])).toEqual([
      ["続けて", true, 0],
      // Its chain reaches the failed turn through "続けて".
      ["ありがとう", true, 2],
      ["その次", true, 0],
    ]);
  });

  test("a change of model starts the conversation over, and an older turn's tool use is taken as unknown", async () => {
    const q1 = id(0), q2 = id(5 * MIN), q3 = id(10 * MIN);
    const opus = { provider: "anthropic", model: "claude-opus-5-5" };
    const { read } = discord({ [C]: { messages: [
      { id: q1, author: USER, content: "一つ目" }, { id: id(4000), author: BOT, content: "答え一" },
      { id: q2, author: USER, content: "二つ目" }, { id: id(5 * MIN + 4000), author: BOT, content: "答え二" },
      { id: q3, author: USER, content: "三つ目" }, { id: id(10 * MIN + 4000), author: BOT, content: "答え三" },
    ] } });
    const cases = await collect([
      turn(C, q1, T0, { model: "claude-opus-5-5", completed: { at: T0 + 5000, ...opus } }),
      turn(C, q2, T0 + 5 * MIN, { requests: null }),
      turn(C, q3, T0 + 10 * MIN),
    ], read);
    expect(cases.map((c) => [(c.history as unknown[]).length, c.earlier_tools, c.after_unknown])).toEqual([[0, false, false], [0, false, false], [2, true, false]]);
  });

  test("a reply to a message that cannot be seen is marked, since its attachments are unknown", async () => {
    const q = id(0);
    const { read } = discord({ [C]: { messages: [
      { id: q, author: USER, content: "これを説明して", message_reference: { message_id: "1" }, referenced_message: null }, { id: id(4000), author: BOT, content: "説明です" },
    ] } });
    expect((await collect([turn(C, q, T0)], read))[0]).toMatchObject({ attachments_unknown: true });
  });

  test("stops at once when Discord does not return the bot's account", async () => {
    await expect(collect([turn(C, id(0), T0)], async () => undefined)).rejects.toThrow("bot's own account");
  });
});

describe("reading from Discord", () => {
  const TOKEN = "secret-token-value";
  const answer = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(body === undefined ? "<html>" : JSON.stringify(body), { status, headers });
  /** A reader over scripted answers, with what it asked for and how long it waited. */
  function reader(answers: (Response | Error)[]) {
    const asked: { url: string; init: RequestInit | undefined }[] = [];
    const waits: number[] = [];
    const counts: string[] = [];
    const read = discordReader(TOKEN, {
      fetch: (async (url: string, init?: RequestInit) => {
        asked.push({ url, init });
        const next = answers.shift() ?? answer(200, { ok: true });
        if (next instanceof Error) throw next;
        return next;
      }) as unknown as typeof fetch,
      sleep: async (ms) => { waits.push(ms); },
      count: (key) => counts.push(key),
    });
    return { read, asked, waits, counts };
  }

  test("only ever sends a GET to Discord, with the token in the header alone", async () => {
    const { read, asked } = reader([answer(200, { id: "1" })]);
    expect(await read("/channels/123/messages/456")).toEqual({ id: "1" });
    expect(asked).toHaveLength(1);
    expect(asked[0]!.url).toBe("https://discord.com/api/v10/channels/123/messages/456");
    expect(asked[0]!.url).not.toContain(TOKEN);
    expect(asked[0]!.init).toEqual({ headers: { Authorization: `Bot ${TOKEN}` } });
  });

  test("what is not there is absent; anything else that fails stops the run", async () => {
    expect(await reader([answer(404, { message: "Unknown Message" })]).read("/x")).toBeUndefined();
    expect(await reader([answer(403, { message: "Missing Access" })]).read("/x")).toBeUndefined();
    await expect(reader([answer(401, {})]).read("/x")).rejects.toThrow(Unavailable);
    await expect(reader([answer(400, {})]).read("/x")).rejects.toThrow("Discord answered 400");
    // Five answers of 5xx in a row: not "the message is gone".
    await expect(reader(Array.from({ length: 5 }, () => answer(503, {}))).read("/x")).rejects.toThrow("after several attempts");
  });

  test("waits as long as Discord asks, and gives up the run when it asks for long or says nothing", async () => {
    const short = reader([answer(429, { retry_after: 2.5 }, { "retry-after": "4" }), answer(200, { id: "1" })]);
    expect(await short.read("/x")).toEqual({ id: "1" });
    // The longer of the two waits that were named.
    expect(short.waits).toContain(4250);
    expect(short.asked).toHaveLength(2);
    const long = reader([answer(429, { retry_after: 600 })]);
    await expect(long.read("/x")).rejects.toThrow("limiting requests");
    expect(long.asked).toHaveLength(1);
    // A block page instead of JSON: the address is being held back.
    await expect(reader([answer(429, undefined)]).read("/x")).rejects.toThrow("limiting requests");
  });

  test("waits for a route's allowance to come back before asking again", async () => {
    const { read, waits } = reader([answer(200, { id: "1" }, { "x-ratelimit-remaining": "0", "x-ratelimit-reset-after": "1.5" })]);
    expect(await read("/x")).toEqual({ id: "1" });
    expect(waits).toContain(1600);
  });

  test("a network error is tried again and then reported by its kind, without the address", async () => {
    const reset = Object.assign(new Error("ECONNRESET https://discord.com/api/v10/channels/111222333/messages/444555666"), { code: "ECONNRESET", path: "https://discord.com/api/v10/channels/111222333/messages/444555666" });
    const once = reader([reset, answer(200, { id: "1" })]);
    expect(await once.read("/channels/111222333/messages/444555666")).toEqual({ id: "1" });
    expect(once.counts).toEqual(["network errors (ECONNRESET)"]);
    const always = reader(Array.from({ length: 5 }, () => reset));
    const failure = await always.read("/channels/111222333/messages/444555666").catch((e: Error) => e);
    expect(failure).toBeInstanceOf(Unavailable);
    expect((failure as Error).message).not.toContain("111222333");
    expect(always.counts.join()).not.toContain("111222333");
  });
});

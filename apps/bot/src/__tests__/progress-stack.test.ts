import { describe, expect, test } from "bun:test";
import { Serial } from "../io";
import { progressStack } from "../progress-stack";

/** A channel that keeps what it shows now and everything done to it. */
function channel() {
  const shown = new Map<string, string>();
  const log: string[] = [];
  const failing = new Set<string>();
  let sent = 0;
  const send = async (content: string) => {
    if (failing.has("send")) {
      failing.delete("send");
      throw new Error("Missing Access");
    }
    const id = String(++sent);
    shown.set(id, content);
    log.push(`send ${id}: ${content}`);
    return {
      edit: async ({ content }: { content: string }) => {
        if (failing.has(`edit ${id}`)) {
          failing.delete(`edit ${id}`);
          throw new Error("Unknown Message");
        }
        shown.set(id, content);
        log.push(`edit ${id}: ${content}`);
      },
      delete: async () => {
        if (failing.has(`delete ${id}`)) {
          failing.delete(`delete ${id}`);
          throw new Error("Unknown Message");
        }
        shown.delete(id);
        log.push(`delete ${id}`);
      },
    };
  };
  return { send, shown, log, failing };
}

describe("taking progress lines back (#140)", () => {
  test("a line in a message the stack has gone past is cut out of it", async () => {
    const c = channel();
    const { add, retract } = progressStack(c.send, new Serial());
    const key = {};
    await add("a".repeat(800));
    await add("再接続 1", key);
    // 800 + 1 + 8 + 1 + 1,100 does not fit: the next message starts.
    await add("b".repeat(1100));
    await retract(key);
    expect([...c.shown.values()]).toEqual(["a".repeat(800), "b".repeat(1100)]);
    expect(c.log.at(-1)).toBe(`edit 1: ${"a".repeat(800)}`);
  });

  test("a message the stack has gone past is deleted once nothing is left in it", async () => {
    const c = channel();
    const { add, retract } = progressStack(c.send, new Serial());
    const key = {};
    await add("x".repeat(1000), key);
    await add("y".repeat(1000));
    await retract(key);
    expect([...c.shown.values()]).toEqual(["y".repeat(1000)]);
    expect(c.log.at(-1)).toBe("delete 1");
  });

  test("only the lines under the key go, and both lines of a labelled text go together", async () => {
    const c = channel();
    const { add, retract } = progressStack(c.send, new Serial());
    const first = {},
      second = {};
    await add("サブエージェント: GPT 6 Luna\n再接続 1", first);
    await add("調べます。");
    await add("再接続 2", second);
    await retract(first);
    expect([...c.shown.values()]).toEqual(["調べます。\n再接続 2"]);
    await retract(second);
    expect([...c.shown.values()]).toEqual(["調べます。"]);
  });

  test("a line that was never shown is dropped without a write, and the next write shows the rest", async () => {
    const c = channel();
    const { add, retract } = progressStack(c.send, new Serial());
    const key = {};
    c.failing.add("send");
    await expect(add("計画します。")).rejects.toThrow("Missing Access");
    c.failing.add("send");
    await expect(add("再接続 1", key)).rejects.toThrow("Missing Access");
    await retract(key);
    expect(c.log).toEqual([]);
    await add("続けます。");
    expect(c.log).toEqual(["send 1: 計画します。\n続けます。"]);
  });

  test("a failed delete leaves the message to the next write, which replaces its content", async () => {
    const c = channel();
    const { add, retract } = progressStack(c.send, new Serial());
    const key = {};
    await add("再接続 1", key);
    c.failing.add("delete 1");
    // Neither rejects: taking a line back must not end the turn.
    await retract(key);
    expect([...c.shown.values()]).toEqual(["再接続 1"]);
    await add("続けます。");
    expect([...c.shown.values()]).toEqual(["続けます。"]);
    expect(c.log.at(-1)).toBe("edit 1: 続けます。");
  });

  test("a failed edit does not keep the other messages from being corrected", async () => {
    const c = channel();
    const { add, retract } = progressStack(c.send, new Serial());
    const key = {};
    await add("a".repeat(1000));
    await add("再接続 1", key);
    await add("b".repeat(1000));
    await add("再接続 2", key);
    c.failing.add("edit 1");
    await retract(key);
    expect([...c.shown.values()]).toEqual([
      `${"a".repeat(1000)}\n再接続 1`,
      "b".repeat(1000),
    ]);
  });

  test("taking back a key that showed nothing changes nothing", async () => {
    const c = channel();
    const { add, retract } = progressStack(c.send, new Serial());
    await add("計画します。");
    await retract({});
    expect(c.log).toEqual(["send 1: 計画します。"]);
  });
});

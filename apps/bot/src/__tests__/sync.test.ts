import { describe, expect, test } from "bun:test";
import { isAbortError, isClosedControllerError } from "../io";
import { consumeSse } from "../sync";

describe("closed fetch-body errors", () => {
  test("matches Bun's webstreams adapter TypeError", () => {
    const error = new TypeError(
      "Invalid state: Controller is already closed",
    ) as TypeError & { code: string };
    error.code = "ERR_INVALID_STATE";
    expect(isClosedControllerError(error)).toBe(true);
    expect(isClosedControllerError(new TypeError("other"))).toBe(false);
    expect(isClosedControllerError(new Error("Controller is already closed"))).toBe(
      false,
    );
    expect(isAbortError(new DOMException("Aborted", "AbortError"))).toBe(true);
    expect(isAbortError(new DOMException("Timed out", "TimeoutError"))).toBe(
      true,
    );
    expect(isAbortError(error)).toBe(false);
  });
});

describe("consumeSse", () => {
  test("delivers hello and update frames then returns on close", async () => {
    const frames: string[] = [];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encode = (s: string) => controller.enqueue(new TextEncoder().encode(s));
        encode('event: hello\ndata: {"version":1}\n\n');
        encode('event: update\ndata: {"version":2}\n\n');
        controller.close();
      },
    });
    await consumeSse(stream, async (event) => {
      frames.push(event.split("\n")[0]!);
    });
    expect(frames).toEqual(["event: hello", "event: update"]);
  });

  test("cancel after the peer already closed does not throw", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
    await consumeSse(stream, async () => {});
  });

  test("rejects an oversized buffered event", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(65537)));
      },
    });
    await expect(consumeSse(stream, async () => {})).rejects.toThrow(
      "Oversized SSE event",
    );
  });
});

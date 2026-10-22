import { afterAll, beforeAll } from "bun:test";

/**
 * Keeps a test file of the Anthropic Workspace path off the network
 * (decision record: #76). Its tests answer every request themselves, through
 * a `fetch` they hand to the client. Should a change ever drop that `fetch`,
 * the SDK would send with the global one: to the real host, with the test's
 * key. While the file's tests run, the global `fetch` reaches this machine
 * only and throws for everything else, before anything is sent.
 */
export function offline() {
  const real = globalThis.fetch;
  beforeAll(() => {
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const { hostname } = new URL(url);
      if (hostname !== "127.0.0.1" && hostname !== "localhost")
        throw new TypeError(
          `A test reached for ${url} through the global fetch. Nothing was sent.`,
        );
      return real(input, init);
    }) as typeof fetch;
  });
  afterAll(() => {
    globalThis.fetch = real;
  });
}

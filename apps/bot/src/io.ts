import { mkdir, rename, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
export async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw e;
  }
}
export async function atomicJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
  });
  await rename(temporary, path);
}
export class Serial {
  private pending: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.pending.then(fn, fn);
    this.pending = task.catch(() => {});
    return task;
  }
}
export class Semaphore {
  private active = 0;
  private waiting: (() => void)[] = [];
  constructor(private readonly limit: number) {}
  async run<T>(fn: () => Promise<T>) {
    if (this.active >= this.limit)
      await new Promise<void>((r) => this.waiting.push(r));
    else this.active++;
    try {
      return await fn();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}
export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });

/**
 * Bun 1.4.x throws this uncaught from `webstreams_adapters` when a fetch body
 * is reset after the web controller already closed. Vercel cutting the settings
 * stream was the production trigger while the bot still held one open; the
 * guard in main.ts stays for any other body the peer resets.
 */
export function isClosedControllerError(error: unknown): boolean {
  if (!(error instanceof TypeError)) return false;
  const code = (error as { code?: string }).code;
  return (
    code === "ERR_INVALID_STATE" ||
    error.message.includes("Controller is already closed")
  );
}
/** Bound semaphore wait as well as the HTTP request; queued work checks abort. */
export async function withAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort: () => void = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try { return await Promise.race([work, cancelled]); }
  finally { signal.removeEventListener("abort", abort); }
}

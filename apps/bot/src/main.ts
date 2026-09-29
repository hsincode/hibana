import { createWriteStream, type WriteStream } from "node:fs";
import { Writable } from "node:stream";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import pino from "pino";
import { loadConfig } from "./config";
import { isClosedControllerError } from "./io";
import { Hibana } from "./bot";

const config = loadConfig();
const redact = {
  paths: [
    "token",
    "apiKey",
    "password",
    "authorization",
    "req.headers.authorization",
    "*.apiKey",
    "*.token",
  ],
  censor: "[REDACTED]",
};
let log = pino({ level: config.logLevel, redact });
let fileStream: WriteStream | undefined;
if (config.logDir) {
  await mkdir(config.logDir, { recursive: true, mode: 0o700 });
  const prune = async () => {
    for (const name of await readdir(config.logDir)) {
      if (!/^hibana-\d{4}-\d{2}-\d{2}\.log$/.test(name)) continue;
      const path = join(config.logDir, name);
      if (Date.now() - (await stat(path)).mtimeMs > 14 * 86400000)
        await rm(path);
    }
  };
  await prune();
  let day = "";
  const destination = new Writable({
    write(chunk, encoding, callback) {
      const today = new Date().toISOString().slice(0, 10);
      if (today !== day) {
        fileStream?.end();
        day = today;
        fileStream = createWriteStream(
          join(config.logDir, `hibana-${day}.log`),
          { flags: "a", mode: 0o600 },
        );
        fileStream.on("error", (error) =>
          process.stderr.write(`Log write failed: ${error.message}\n`),
        );
        void prune().catch((error) =>
          process.stderr.write(`Log retention failed: ${String(error)}\n`),
        );
      }
      fileStream!.write(chunk, encoding, callback);
    },
  });
  log = pino(
    { level: config.logLevel, redact },
    pino.multistream([{ stream: process.stdout }, { stream: destination }]),
  );
}
if (process.argv.includes("--check")) {
  log.info(
    { provider: config.selection.provider, model: config.selection.model },
    "Hibana configuration is valid",
  );
  process.exit(0);
}
const bot = new Hibana(config, log);
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  log.info("Stopping Hibana");
  const timeout = setTimeout(() => process.exit(1), 25000);
  timeout.unref();
  await bot.close();
  clearTimeout(timeout);
  log.flush();
  fileStream?.end();
};
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
process.on("uncaughtException", (error) => {
  if (isClosedControllerError(error)) {
    log.error(
      { error: error.message },
      "Bun stream adapter closed a fetch body; continuing",
    );
    return;
  }
  log.fatal(
    { error: error instanceof Error ? error.message : String(error) },
    "Uncaught exception",
  );
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  if (isClosedControllerError(reason)) {
    log.error(
      { error: message },
      "Bun stream adapter closed a fetch body; continuing",
    );
    return;
  }
  log.error({ error: message }, "Unhandled rejection");
});
try {
  await bot.start();
} catch (error) {
  log.error(
    { error: error instanceof Error ? error.message : String(error) },
    "Hibana failed to start",
  );
  await bot.close();
  process.exitCode = 1;
}

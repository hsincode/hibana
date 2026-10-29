// The recording page's files (#138): `index.html` as it is, and `player.ts`
// bundled for the browser. Built once a process, the first time a recording
// is published; a failed build is tried again the next time.
import { join } from "node:path";

let built: Promise<{ html: string; js: string }> | undefined;

export function recordingPlayer() {
  built ??= (async () => {
    const result = await Bun.build({
      entrypoints: [join(import.meta.dir, "player.ts")],
      target: "browser",
      format: "esm",
      minify: true,
    });
    if (!result.success)
      throw new AggregateError(result.logs, "Recording player build failed");
    const js = await result.outputs[0]!.text();
    const html = await Bun.file(join(import.meta.dir, "index.html")).text();
    return { html, js };
  })().catch((error) => {
    built = undefined;
    throw error;
  });
  return built;
}

import { normalizeTool } from "./harness";
import type { Json } from "./types";

// Bound remote requests and workspace reads even when a model emits a large
// batch. Unknown tools, shell commands and browser sessions stay exclusive.
export const MAX_PARALLEL_TOOLS = 6;
const parallelTools = new Set([
  "websearch", "web_fetch", "web_fetch_exa", "web_search_advanced_exa",
  "read_file", "Read", "list_files", "grep_files", "Grep", "Glob",
  "run_jev", "tool_search", "ToolSearch", "search_tool",
]);

export function supportsParallelTool(name: string, args: Json = {}): boolean {
  const normalized = normalizeTool(name, args);
  // Read can attach pixels instead of text. Visual observations need a parent
  // review boundary before Jev can choose anything based on that image.
  if (normalized.name === "Read" && /\.(png|jpe?g|gif|webp)$/i.test(String(normalized.args.path ?? normalized.args.file_path)))
    return false;
  return parallelTools.has(normalized.name);
}

export async function runToolBatch<T>(
  calls: readonly T[],
  parallel: (call: T) => boolean,
  execute: (call: T) => Promise<void>,
) {
  const pending = new Set<Promise<void>>();
  let failure: { error: unknown } | undefined;
  const checkFailure = () => { if (failure) throw failure.error; };
  const drain = async () => {
    await Promise.all(pending);
    checkFailure();
  };
  try {
    for (const call of calls) {
      checkFailure();
      if (!parallel(call)) {
        // A mutation is a barrier on both sides: later reads must see its
        // result, and earlier observations must finish before it changes state.
        await drain();
        await execute(call);
        continue;
      }
      if (pending.size >= MAX_PARALLEL_TOOLS) await Promise.race(pending);
      checkFailure();
      const task = Promise.resolve().then(() => execute(call))
        .catch(error => { failure ??= { error }; })
        .finally(() => { pending.delete(task); });
      pending.add(task);
    }
    await drain();
  } finally {
    // Checkpoint failure must not leave sibling tools running after the turn
    // releases its workspace. Tool failures themselves are ordinary results.
    await Promise.all(pending);
  }
}

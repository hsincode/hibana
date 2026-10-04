import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

// A tag such as `@v4` can be moved to another commit, so the same workflow
// file could run different code tomorrow. Dependabot keeps the pins current.
test("every action in the workflows is pinned to a full commit SHA", async () => {
  const dir = join(import.meta.dir, "../.github/workflows");
  const unpinned: string[] = [];
  let seen = 0;
  for (const file of await readdir(dir)) {
    if (!/\.ya?ml$/.test(file)) continue;
    const lines = (await readFile(join(dir, file), "utf8")).split("\n");
    lines.forEach((line, index) => {
      const uses = /^\s*(?:-\s*)?uses:\s*(\S+)/.exec(line)?.[1];
      if (!uses || uses.startsWith("./")) return; // a local action runs from this commit
      seen += 1;
      if (!/@[0-9a-f]{40}$/.test(uses)) unpinned.push(`${file}:${index + 1} ${uses}`);
    });
  }
  expect(seen).toBeGreaterThan(0);
  expect(unpinned).toEqual([]);
});

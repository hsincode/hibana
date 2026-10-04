import { expect, test } from "bun:test";
import { CONTRACT_PATH, currentContract, type Contract } from "./contract";

test("the API still offers everything in contract.json, and contract.json lists everything it offers", async () => {
  const recorded = (await Bun.file(CONTRACT_PATH).json()) as Contract;
  const current = await currentContract();
  const removed: string[] = [];
  const added: string[] = [];
  for (const key of Object.keys(recorded) as (keyof Contract)[]) {
    for (const entry of recorded[key]) if (!current[key].includes(entry)) removed.push(`${key}: ${entry}`);
    for (const entry of current[key]) if (!recorded[key].includes(entry)) added.push(`${key}: ${entry}`);
  }
  // Removed: the previous bot or dashboard may still use it (docs/adr/0006).
  // Deploy the clients without it first; then delete it from contract.json in
  // the pull request that removes it from the API.
  expect(removed).toEqual([]);
  // Added: record it with `bun apps/api/src/contract.ts --write`, so that a
  // later removal shows up as a change to contract.json.
  expect(added).toEqual([]);
});

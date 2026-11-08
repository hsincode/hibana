// The app settings (#161): one value for every server and DM, which the
// settings API hands out as `app_settings` in the snapshot.
import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyAppSettings, emptyGuild } from "@hibana/shared/settings";
import { loadConfig } from "../config";
import { Runtime } from "../runtime";

const runtime = (env: Record<string, string> = {}) =>
  new Runtime(
    loadConfig({
      ANTHROPIC_API_KEY: "fixture",
      RUNTIME_STATE_PATH: "",
      ...env,
    }),
  );

test("the snapshot's app settings serve every server and DM, apart from the server rows", () => {
  const rt = runtime();
  rt.replace({
    guilds: {
      // A row stored before #161 still holds a copy; it is not read.
      g1: { ...emptyGuild(), temperature: 0.1, voice_mode: "s2s" } as never,
      g2: { ...emptyGuild(), thread_only: true },
    },
    app_settings: {
      ...emptyAppSettings(),
      temperature: 1.4,
      exa_mode: "off",
      filler_removal: false,
    },
  });
  for (const id of ["g1", "g2", undefined]) {
    const settings = rt.resolve(id, "u1");
    expect(settings.temperature).toBe(1.4);
    expect(settings.exa_mode).toBe("off");
    expect(settings.voice_mode).toBe("stt");
    expect(settings.filler_removal).toBe(false);
    expect("temperature" in rt.guild(id)).toBe(false);
  }
  expect(rt.app().voice_mode).toBe("stt");
  // A server's own settings stay its own.
  expect(rt.guild("g2").thread_only).toBe(true);
  expect(rt.guild("g1").thread_only).toBe(false);
});

test("a field the settings API has not sent takes the bot's own environment", () => {
  const rt = runtime({ LLM_TEMPERATURE: "0.5" });
  rt.replace({ guilds: {} });
  expect(rt.app().temperature).toBe(0.5);
  rt.replace({ guilds: {}, app_settings: { exa_mode: "off" } as never });
  expect(rt.app()).toMatchObject({ temperature: 0.5, exa_mode: "off" });
});

test("a state file from before #161 starts them from what most of its servers have", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hibana-app-settings-"));
  const statePath = join(dir, "state.json");
  try {
    await writeFile(
      statePath,
      JSON.stringify({
        guilds: {
          a: { ...emptyGuild(), temperature: 1 },
          b: { ...emptyGuild(), temperature: 1 },
          c: { ...emptyGuild(), temperature: 0.2 },
        },
      }),
    );
    const rt = runtime({
      RUNTIME_STATE_PATH: statePath,
      LLM_TEMPERATURE: "0.5",
    });
    await rt.load();
    expect(rt.app().temperature).toBe(1);
    expect(rt.resolve("c").temperature).toBe(1);
    const saved = JSON.parse(await readFile(statePath, "utf8"));
    expect(saved.app_settings.temperature).toBe(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("without the settings API, a Moderator's change is kept in the state file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hibana-app-settings-"));
  const statePath = join(dir, "state.json");
  try {
    const rt = runtime({ RUNTIME_STATE_PATH: statePath });
    rt.snapshot.user_roles = { mod: "moderator", member: "premium" };
    await expect(rt.patchApp({ exa_mode: "off" }, "member")).rejects.toThrow(
      "Moderator と Administrator だけ",
    );
    expect(rt.app().exa_mode).not.toBe("off");
    await expect(rt.patchApp({ temperature: 5 }, "mod")).rejects.toThrow();
    const next = await rt.patchApp({ exa_mode: "off" }, "mod");
    expect(next.exa_mode).toBe("off");
    const saved = JSON.parse(await readFile(statePath, "utf8"));
    expect(saved.app_settings.exa_mode).toBe("off");
    const again = runtime({ RUNTIME_STATE_PATH: statePath });
    await again.load();
    expect(again.app().exa_mode).toBe("off");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

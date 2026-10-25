// Slash commands of the meeting recording (#118): `/recording start|stop`
// and the server's Text Generation Model, `/text-model`.
import { describe, expect, test } from "bun:test";
import { commands, handleCommand } from "../commands";
import { loadConfig } from "../config";
import type { Recorder } from "../recording";
import { Runtime } from "../runtime";

const runtime = (env: Record<string, string> = {}) =>
  new Runtime(
    loadConfig({
      ANTHROPIC_API_KEY: "fixture",
      XAI_API_KEY: "fixture",
      VOICE_ENABLED: "true",
      ...env,
    }),
  );

/** Runs one slash command; only what `handleCommand` reads is faked. */
async function slash(
  rt: Runtime,
  name: string,
  options: { subcommand?: string; strings?: Record<string, string> } = {},
  recorder?: Partial<Recorder>,
  user = "u1",
) {
  let reply = "";
  const i = {
    commandName: name,
    user: { id: user },
    guildId: "g1",
    channelId: "t1",
    client: { user: { id: "bot" } },
    channel: { isThread: () => false },
    options: {
      getString: (key: string) => options.strings?.[key] ?? null,
      getBoolean: () => null,
      getSubcommand: () => options.subcommand ?? null,
    },
    deferReply: async () => {},
    reply: async () => {},
    editReply: async (text: string) => {
      reply = text;
    },
  };
  await handleCommand(
    i as never,
    rt,
    {} as never,
    {} as never,
    { leave: () => {} } as never,
    async () => {},
    {} as never,
    undefined,
    recorder as Recorder,
  );
  return reply;
}

describe("registration", () => {
  test("with voice on, /recording has start and stop, and /text-model picks an Anthropic API model and effort", () => {
    const list = commands(runtime());
    const recording = list.find((c) => c.name === "recording")!;
    expect(
      (recording.options as { type: number; name: string }[]).map((o) => [
        o.type,
        o.name,
      ]),
    ).toEqual([
      [1, "start"],
      [1, "stop"],
    ]);
    const model = list.find((c) => c.name === "text-model")!;
    const [preset, effort] = model.options as {
      name: string;
      choices: { name: string; value: string }[];
    }[];
    expect(preset!.choices.map((c) => c.value)).toEqual([
      "anthropic-haiku-5-5",
      "anthropic-sonnet-5-5",
      "anthropic-opus-5-5",
    ]);
    expect(preset!.choices[0]!.name).toBe("Anthropic / Claude Haiku 5.5");
    expect(effort!.choices.map((c) => c.value)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  test("with voice off, neither is offered", () => {
    const names = commands(
      new Runtime(loadConfig({ ANTHROPIC_API_KEY: "fixture" })),
    ).map((c) => c.name);
    expect(names).not.toContain("recording");
    expect(names).not.toContain("text-model");
  });
});

describe("/recording", () => {
  test("start records from the channel the command was sent in; stop ends it", async () => {
    const calls: unknown[][] = [];
    const recorder = {
      start: async (...args: unknown[]) => {
        calls.push(["start", ...args]);
        return { ok: true, voice_channel_id: "vc1", max_minutes: 180 };
      },
      stop: async (...args: unknown[]) => {
        calls.push(["stop", ...args]);
        return { ok: true };
      },
    } as unknown as Recorder;
    const started = await slash(
      runtime(),
      "recording",
      { subcommand: "start" },
      recorder,
    );
    expect(started).toContain("録音を始めました");
    expect(started).toContain('"voice_channel_id": "vc1"');
    const stopped = await slash(
      runtime(),
      "recording",
      { subcommand: "stop" },
      recorder,
    );
    expect(stopped).toContain("要約");
    expect(calls).toEqual([
      ["start", "g1", "t1", "u1"],
      ["stop", "g1", "u1"],
    ]);
  });

  test("a refusal is shown as the error", async () => {
    const recorder = {
      start: async () => {
        throw new Error(
          "録音するボイスチャンネルに入ってから実行してください。",
        );
      },
    } as unknown as Recorder;
    expect(
      await slash(runtime(), "recording", { subcommand: "start" }, recorder),
    ).toBe("エラー: 録音するボイスチャンネルに入ってから実行してください。");
  });
});

describe("/text-model", () => {
  test("without options it shows the server's model: Haiku 5.5 medium by default", async () => {
    const reply = await slash(runtime(), "text-model");
    expect(reply).toContain('"preset": "anthropic-haiku-5-5"');
    expect(reply).toContain('"effort": "medium"');
  });

  test("a member with the plan changes the model or the effort alone; the other is kept", async () => {
    const rt = runtime();
    rt.snapshot.user_roles.u1 = "premium";
    await slash(rt, "text-model", {
      strings: { preset: "anthropic-sonnet-5-5" },
    });
    expect(rt.guild("g1").text_model).toEqual({
      preset: "anthropic-sonnet-5-5",
      effort: "medium",
    });
    await slash(rt, "text-model", { strings: { effort: "high" } });
    expect(rt.guild("g1").text_model).toEqual({
      preset: "anthropic-sonnet-5-5",
      effort: "high",
    });
  });

  test("Anthropic API presets are Premium and up to pick (#35), as on the dashboard", async () => {
    const rt = runtime();
    const reply = await slash(rt, "text-model", {
      strings: { preset: "anthropic-opus-5-5" },
    });
    expect(reply).toContain("エラー");
    expect(rt.guild("g1").text_model.preset).toBe("anthropic-haiku-5-5");
  });
});

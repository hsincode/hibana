import { expect, test } from "bun:test";
import { Client } from "discord.js";
import pino from "pino";
import { Agent } from "../agent";
import { evaluateRoute, routeInput } from "../auto-route";
import { loadConfig } from "../config";
import {
  JevClient,
  JevImagesRejected,
  JEV_MODEL,
  jevInputSchema,
} from "../jev";
import {
  discordResizeUrl,
  fitsJev,
  imageInfo,
  jevSize,
  JEV_IMAGES_HEADER,
  MAX_JEV_IMAGES,
  placeImages,
  prepareJevImages,
  type Download,
  type JevImage,
} from "../jev-images";
import { jevTaskSchema, runJevTask } from "../jev-task";
import { evaluateTriage, triageInput } from "../jev-triage";
import { LlmClient } from "../llm";
import { solidPng } from "../png";
import { Runtime } from "../runtime";
import { ToolRegistry } from "../tools";
import type { Context, Json, Message } from "../types";

const config = (env: NodeJS.ProcessEnv = {}) =>
  loadConfig({
    PROVIDER: "codex_plus",
    CODEX_PLUS_API_KEY: "plus-fixture",
    ANTHROPIC_API_KEY: "anthropic-fixture",
    JEV_API_KEY: "jev-fixture",
    SANDBOX_ENABLED: "false",
    SKILLS_ENABLED: "false",
    RUNTIME_STATE_PATH: "",
    ...env,
  });
const context = (): Context => ({
  guildId: "g1",
  channelId: "c1",
  userId: "member",
  botId: "bot",
  thread: false,
  depth: 0,
  delivered: false,
});
const dataUrl = (png: Buffer) =>
  `data:image/png;base64,${png.toString("base64")}`;
const usage = { input_tokens: 10, output_tokens: 1, cost: 0.0001 };
const fitting = solidPng(320, 320, [255, 0, 0]);
const image = (reference = "<<image 1 test>>"): JevImage => ({
  reference,
  format: "png",
  data_base64: fitting.toString("base64"),
});
const question = {
  seen: { type: "noul" as const, instructions: "Is the image red?" },
};

// A baseline JPEG header: SOI, APP0, then SOF0 with height 300 and width 400.
const jpeg = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01,
  0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01,
  0x2c, 0x01, 0x90, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
]);

test("image headers give the format and size Jev checks, and refuse what it cannot read", () => {
  expect(imageInfo(fitting)).toEqual({
    format: "png",
    width: 320,
    height: 320,
  });
  expect(imageInfo(jpeg)).toEqual({ format: "jpg", width: 400, height: 300 });
  // An animated PNG declares acTL before IDAT.
  const ihdrEnd = 8 + 25;
  const actl = Buffer.from([
    0,
    0,
    0,
    8,
    ...Buffer.from("acTL"),
    0,
    0,
    0,
    1,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
  ]);
  expect(
    imageInfo(
      Buffer.concat([
        fitting.subarray(0, ihdrEnd),
        actl,
        fitting.subarray(ihdrEnd),
      ]),
    ),
  ).toBeUndefined();
  expect(
    imageInfo(Buffer.from("GIF89a........................")),
  ).toBeUndefined();
  expect(imageInfo(Buffer.from("iVBORw0KGgo=", "base64"))).toBeUndefined();
});

test("Jev's size limits and the scaled size keep the aspect ratio", () => {
  expect(fitsJev({ width: 256, height: 1568 })).toBe(true);
  expect(fitsJev({ width: 255, height: 1000 })).toBe(false);
  expect(fitsJev({ width: 1569, height: 1000 })).toBe(false);
  expect(fitsJev({ width: 256, height: 256 })).toBe(false); // under 78,400 pixels
  expect(fitsJev({ width: 1568, height: 1568 })).toBe(true);
  expect(jevSize(1920, 1080)).toEqual({ width: 1568, height: 882 });
  expect(jevSize(4000, 200)).toBeUndefined();
  expect(
    discordResizeUrl(
      "https://cdn.discordapp.com/attachments/1/2/a.png?ex=1&is=2&hm=3",
      1568,
      882,
    ),
  ).toBe(
    "https://media.discordapp.net/attachments/1/2/a.png?ex=1&is=2&hm=3&width=1568&height=882",
  );
  expect(
    discordResizeUrl("https://example.com/attachments/1/2/a.png", 1568, 882),
  ).toBeUndefined();
  expect(
    discordResizeUrl("https://cdn.discordapp.com/avatars/1/a.png", 1568, 882),
  ).toBeUndefined();
});

test("images are prepared in order, scaled through Discord when too large, and skipped otherwise", async () => {
  const big = solidPng(1920, 1080, [0, 0, 255]);
  const scaled = solidPng(1568, 882, [0, 0, 255]);
  const fetched: string[] = [];
  const download: Download = async (url) => {
    fetched.push(url);
    if (url.includes("width=1568")) return scaled;
    return url.includes("big") ? big : fitting;
  };
  const images = await prepareJevImages(
    [
      dataUrl(fitting),
      "https://cdn.discordapp.com/attachments/1/2/big.png",
      "https://example.com/big.png", // too large, and not Discord's to scale
      dataUrl(solidPng(100, 100, [0, 0, 0])), // too small
      "https://cdn.discordapp.com/attachments/1/2/fifth.png", // beyond the four
    ],
    undefined,
    download,
  );
  expect(images).toHaveLength(MAX_JEV_IMAGES);
  expect(images[0]?.data_base64).toBe(fitting.toString("base64"));
  expect(images[1]?.data_base64).toBe(scaled.toString("base64"));
  expect(images[2]).toBeUndefined();
  expect(images[3]).toBeUndefined();
  expect(fetched).toEqual([
    "https://cdn.discordapp.com/attachments/1/2/big.png",
    "https://example.com/big.png",
    "https://media.discordapp.net/attachments/1/2/big.png?width=1568&height=882",
  ]);
  // One random tag per call keeps references unique and unlike request text.
  expect(images[0]!.reference).toMatch(/^<<image 1 [0-9a-f]{8}>>$/);
  expect(images[1]!.reference).toBe(
    images[0]!.reference.replace("image 1", "image 2"),
  );
});

test("a slow image misses the deadline without holding the others", async () => {
  const started = performance.now();
  const images = await prepareJevImages(
    ["https://cdn.discordapp.com/attachments/1/2/slow.png", dataUrl(fitting)],
    undefined,
    () => new Promise(() => {}),
    50,
  );
  expect(images[0]).toBeUndefined();
  expect(images[1]).toBeDefined();
  expect(performance.now() - started).toBeLessThan(1000);
});

test("placeholders become references in values only, and every image must be used", () => {
  const input = {
    state: { "{{image:1}}": "{{image:1}} and {{ image:2 }}" },
    questions: { q: { criteria: ["{{image:2}}"] } },
  };
  expect(placeImages(input, ["<<a>>", "<<b>>"])).toEqual({
    state: { "{{image:1}}": "<<a>> and <<b>>" },
    questions: { q: { criteria: ["<<b>>"] } },
  });
  expect(() => placeImages({ state: "{{image:3}}" }, ["<<a>>"])).toThrow(
    "{{image:3}} has no image",
  );
  expect(() =>
    placeImages({ state: "{{image:1}}" }, ["<<a>>", "<<b>>"]),
  ).toThrow("images[1] is never referenced");
  expect(placeImages({ state: "no images" }, [])).toEqual({
    state: "no images",
  });
});

test("the client sends images as assets with the opt-in header, and nothing new without them", async () => {
  const requests: { headers: Headers; body: Json }[] = [];
  const reply =
    (status = 200) =>
    async (_url: string, init?: RequestInit) => {
      requests.push({
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)),
      });
      return status === 200
        ? Response.json({
            model: "typesafe/jev-1.14",
            answers: { seen: { type: "noul", noul: 0.9 } },
            usage,
          })
        : new Response("bad image", { status });
    };
  const withImage = {
    state: { picture: "<<image 1 test>>" },
    questions: question,
  };
  await new JevClient(config(), reply()).decide(withImage, undefined, [
    image(),
  ]);
  expect(requests[0]!.headers.get(JEV_IMAGES_HEADER)).toBe("true");
  expect(requests[0]!.body).toEqual({
    model: JEV_MODEL,
    ...withImage,
    assets: {
      "<<image 1 test>>": {
        type: "image",
        format: "png",
        data_base64: fitting.toString("base64"),
      },
    },
  });

  const plain = { state: "text", questions: question };
  await new JevClient(config(), reply()).decide(plain);
  expect(requests[1]!.headers.has(JEV_IMAGES_HEADER)).toBe(false);
  expect(requests[1]!.body).toEqual({
    model: JEV_MODEL,
    ...jevInputSchema.parse(plain),
  });

  // A client error on an image request is not retried and is told apart.
  await expect(
    new JevClient(config(), reply(400)).decide(withImage, undefined, [image()]),
  ).rejects.toBeInstanceOf(JevImagesRejected);
  expect(requests).toHaveLength(3);
  const textOnly = await new JevClient(config(), reply(400))
    .decide(plain)
    .catch((e) => e);
  expect(textOnly).not.toBeInstanceOf(JevImagesRejected);
  expect(textOnly.message).toBe("Jev: HTTP 400");

  // Jev rejects an unreferenced asset, so it never leaves Hibana.
  await expect(
    new JevClient(config(), reply()).decide(plain, undefined, [image()]),
  ).rejects.toThrow("must be referenced");
  expect(requests).toHaveLength(4);
});

const request: Message[] = [
  { role: "user", content: "Hello" },
  { role: "assistant", content: "Hi" },
  {
    role: "user",
    content: "この画面のエラーを直して",
    images: ["https://cdn.discordapp.com/attachments/1/2/a.png"],
  },
];
const triaged = {
  model: JEV_MODEL,
  cost: 0.0001,
  usage: {
    prompt_tokens: 1,
    completion_tokens: 1,
    total_tokens: 2,
    cached_tokens: 0,
  },
  answers: {
    needs_research: { type: "noul" as const, noul: 0.2 },
    needs_artifact_work: { type: "noul" as const, noul: 0.8 },
    needs_review: { type: "noul" as const, noul: 0.6 },
  },
};

test("triage shows Jev the request's images and judges from text alone if they are rejected", async () => {
  const seen: { input: Json; images: number }[] = [];
  const decide: JevClient["decide"] = async (input, _signal, images = []) => {
    seen.push({ input: input as Json, images: images.length });
    if (images.length) throw new JevImagesRejected("Jev: HTTP 400");
    return triaged;
  };
  const result = await evaluateTriage(
    request,
    decide,
    AbortSignal.timeout(1000),
    [image()],
  );
  expect(seen[0]!.images).toBe(1);
  expect((seen[0]!.input.state as Json).attached_image_contents).toEqual([
    "<<image 1 test>>",
  ]);
  // The retry is exactly the input from before #83.
  expect(seen[1]).toEqual({
    input: triageInput(request) as unknown as Json,
    images: 0,
  });
  expect(triageInput(request).state).not.toHaveProperty(
    "attached_image_contents",
  );
  expect(result.images).toBe(0);
  expect(result.triage.needs_artifact_work).toBe(0.8);

  // Other failures are not a reason to judge again.
  await expect(
    evaluateTriage(
      request,
      async () => {
        throw new Error("Jev: HTTP 503");
      },
      AbortSignal.timeout(1000),
      [image()],
    ),
  ).rejects.toThrow("503");
});

test("routing keeps its calibrated questions and adds the images to the state only", async () => {
  let sent: Json | undefined;
  const decide: JevClient["decide"] = async (input, _signal, images = []) => {
    sent = input as Json;
    expect(images).toHaveLength(1);
    return {
      model: JEV_MODEL,
      cost: 0.0001,
      usage: triaged.usage,
      answers: {
        difficulty: { type: "score", score: 3.2 },
        requested_model: { type: "choice", choice: "none" },
      },
    };
  };
  const result = await evaluateRoute(
    request,
    decide,
    AbortSignal.timeout(1000),
    [image()],
  );
  expect(result.images).toBe(1);
  expect(sent!.questions).toEqual(routeInput(request).questions);
  expect((sent!.state as Json).attached_image_contents).toEqual([
    "<<image 1 test>>",
  ]);
});

test("the registry loads the latest request's images for routing, unless image input is off", async () => {
  const run = async (env: NodeJS.ProcessEnv) => {
    const runtime = new Runtime(config(env));
    runtime.snapshot.user_roles.owner = "premium";
    await runtime.patch("g1", { preset: "anthropic-auto" }, "owner");
    const client = new Client({ intents: [] });
    const records: Json[] = [];
    const registry = new ToolRegistry(
      runtime,
      client,
      new Agent(new LlmClient(runtime.config)),
      pino(
        { level: "info" },
        {
          write: (line) => {
            records.push(JSON.parse(line));
          },
        },
      ),
    );
    const fetched: string[] = [];
    registry.jevImageDownload = async (url) => {
      fetched.push(url);
      return fitting;
    };
    let images = -1;
    registry.jev.decide = async (_input, _signal, sent = []) => {
      images = sent.length;
      return {
        model: JEV_MODEL,
        cost: 0.0001,
        usage: triaged.usage,
        answers: {
          difficulty: { type: "score", score: 1 },
          requested_model: { type: "choice", choice: "none" },
        },
      };
    };
    try {
      await registry.route(context(), request);
      return {
        images,
        fetched,
        log: records.find((r) => r.msg === "Jev route finished")!,
      };
    } finally {
      await registry.close();
      client.destroy();
    }
  };
  const on = await run({});
  expect(on.images).toBe(1);
  expect(on.fetched).toEqual([
    "https://cdn.discordapp.com/attachments/1/2/a.png",
  ]);
  expect(on.log.images).toBe(1);
  const off = await run({ JEV_IMAGES_ENABLED: "false" });
  expect(off.images).toBe(0);
  expect(off.fetched).toEqual([]);
});

async function registryFor(env: NodeJS.ProcessEnv = {}) {
  const runtime = new Runtime(config(env));
  const client = new Client({ intents: [] });
  const registry = new ToolRegistry(
    runtime,
    client,
    new Agent(new LlmClient(runtime.config)),
  );
  const notices: string[] = [];
  const ctx: Context = {
    ...context(),
    images: ["https://cdn.discordapp.com/attachments/1/2/a.png"],
    notify: async (text) => {
      notices.push(text);
    },
  };
  return {
    registry,
    ctx,
    notices,
    close: async () => {
      await registry.close();
      client.destroy();
    },
  };
}
const runJev = {
  state: { screen: "{{image:1}}" },
  questions: question,
  images: ["attachment:1"],
};

test("run_jev sends the attached image in place of its placeholder", async () => {
  const f = await registryFor();
  f.registry.jevImageDownload = async () => fitting;
  let sent: { input: Json; images: JevImage[] } | undefined;
  f.registry.jev.decide = async (input, _signal, images = []) => {
    sent = { input: input as Json, images: [...images] };
    return {
      model: JEV_MODEL,
      cost: 0.0001,
      usage: triaged.usage,
      answers: { seen: { type: "noul", noul: 0.9 } },
    };
  };
  try {
    await f.registry.execute("run_jev", runJev, f.ctx);
    expect(sent!.images).toHaveLength(1);
    expect(sent!.input.state).toEqual({ screen: sent!.images[0]!.reference });
    expect(sent!.input).not.toHaveProperty("images");
    expect(f.notices).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("run_jev fails rather than judge a picture it could not send", async () => {
  const f = await registryFor();
  let calls = 0;
  f.registry.jev.decide = async () => {
    calls++;
    throw new JevImagesRejected("Jev: HTTP 400");
  };
  try {
    f.registry.jevImageDownload = async () => solidPng(100, 100, [0, 0, 0]);
    await expect(f.registry.execute("run_jev", runJev, f.ctx)).rejects.toThrow(
      "Jev cannot take this image",
    );
    await expect(
      f.registry.execute(
        "run_jev",
        { ...runJev, images: ["attachment:2"] },
        f.ctx,
      ),
    ).rejects.toThrow("no such image");
    await expect(
      f.registry.execute(
        "run_jev",
        { ...runJev, state: "no placeholder" },
        f.ctx,
      ),
    ).rejects.toThrow("never referenced");
    // None of these reached Jev or posted a notice.
    expect(calls).toBe(0);
    expect(f.notices).toHaveLength(0);
    f.registry.jevImageDownload = async () => fitting;
    await expect(f.registry.execute("run_jev", runJev, f.ctx)).rejects.toThrow(
      "Jev did not accept the images",
    );
    expect(calls).toBe(1);
  } finally {
    await f.close();
  }
  const off = await registryFor({ JEV_IMAGES_ENABLED: "false" });
  try {
    await expect(
      off.registry.execute("run_jev", runJev, off.ctx),
    ).rejects.toThrow("JEV_IMAGES_ENABLED=false");
  } finally {
    await off.close();
  }
});

const visualPlan = () =>
  jevTaskSchema.parse({
    objective: "Check the screen",
    state: "Screenshot taken",
    actions: [
      {
        id: "inspect",
        description: "Inspect the screenshot",
        tool: "view_image",
        arguments: { path: "screen.png" },
      },
      {
        id: "follow",
        description: "Act on what the screen shows",
        tool: "websearch",
        arguments: { query: "error" },
        depends_on: ["inspect"],
      },
    ],
  });
const pick = (choice: string) => ({
  model: JEV_MODEL,
  usage: triaged.usage,
  cost: 0.001,
  answers: { action: { type: "choice" as const, choice } },
});
const loadScreen = async (tool: string, _args: Json, c: Context) => {
  if (tool !== "view_image") return { ok: true };
  (c.pendingImages ??= []).push(dataUrl(fitting));
  return { ok: true, image_attached: true };
};

test("the task loop shows Jev a loaded image and goes on to the actions that depend on it", async () => {
  const ctx = { ...context(), notify: async () => {} };
  const decisions: {
    images: number;
    observations: Json[];
    instructions: string;
  }[] = [];
  const executed: string[] = [];
  const result = await runJevTask(visualPlan(), {
    context: ctx,
    assertEnabled: () => {},
    prepareImages: (urls, signal) => prepareJevImages(urls, signal),
    decide: async (input, _signal, images = []) => {
      const state = input.state as Json;
      decisions.push({
        images: images.length,
        observations: state.observations as Json[],
        instructions: (input.questions.action as { instructions: string })
          .instructions,
      });
      if (images.length)
        expect(JSON.stringify(input)).toContain(images[0]!.reference);
      return pick("a0");
    },
    execute: async (tool, args, c) => {
      executed.push(tool);
      return loadScreen(tool, args, c);
    },
  });
  expect(executed).toEqual(["view_image", "websearch"]);
  expect(result.status).toBe("completed_plan");
  expect(decisions.map((d) => d.images)).toEqual([0, 1]);
  expect(decisions[1]!.observations[0]!.images).toHaveLength(1);
  // The instruction gains a sentence only once there are images.
  expect(decisions[0]!.instructions).not.toContain("images in observations");
  expect(decisions[1]!.instructions).toContain("images in observations");
  // The parent still receives the image.
  expect(ctx.pendingImages).toEqual([dataUrl(fitting)]);
});

test("the task loop returns to the parent when Jev cannot see the image", async () => {
  const run = async (options: Partial<Parameters<typeof runJevTask>[1]>) => {
    const executed: string[] = [];
    const result = await runJevTask(visualPlan(), {
      context: { ...context(), notify: async () => {} },
      assertEnabled: () => {},
      decide: async () => pick("a0"),
      execute: async (tool, args, c) => {
        executed.push(tool);
        return loadScreen(tool, args, c);
      },
      ...options,
    });
    return { result, executed };
  };
  const reason =
    "Image loaded for parent review; inspect it and supply visual observations in the next plan";
  // Image input off, as before #83.
  const off = await run({});
  expect(off.executed).toEqual(["view_image"]);
  expect(off.result).toMatchObject({
    status: "needs_replan",
    reason,
    remaining: ["follow"],
  });
  // The image does not fit Jev's limits.
  const unfit = await run({ prepareImages: async () => [undefined] });
  expect(unfit.executed).toEqual(["view_image"]);
  expect(unfit.result).toMatchObject({ status: "needs_replan", reason });
  // Jev rejects the image on the next decision.
  const rejected = await run({
    prepareImages: (urls, signal) => prepareJevImages(urls, signal),
    decide: async (_input, _signal, images = []) => {
      if (images.length) throw new JevImagesRejected("Jev: HTTP 400");
      return pick("a0");
    },
  });
  expect(rejected.executed).toEqual(["view_image"]);
  expect(rejected.result).toMatchObject({
    status: "needs_replan",
    reason,
    remaining: ["follow"],
  });
});

test("a task run gives Jev at most four images", async () => {
  const actions = Array.from({ length: 5 }, (_, i) => ({
    id: `shot${i}`,
    description: "Inspect a screenshot",
    tool: "view_image",
    arguments: { path: `s${i}.png` },
    ...(i ? { depends_on: [`shot${i - 1}`] } : {}),
  }));
  let prepared = 0;
  const result = await runJevTask(
    jevTaskSchema.parse({ objective: "Check screens", state: "x", actions }),
    {
      context: { ...context(), notify: async () => {} },
      assertEnabled: () => {},
      prepareImages: async (urls, signal) => {
        prepared += urls.length;
        return prepareJevImages(urls, signal);
      },
      decide: async (_input, _signal, images = []) => {
        expect(images.length).toBeLessThanOrEqual(MAX_JEV_IMAGES);
        return pick("a0");
      },
      execute: loadScreen,
    },
  );
  expect(prepared).toBe(4);
  expect(result.status).toBe("needs_replan");
  expect(result.remaining).toEqual([]);
});

test("the manual image check asks one question per color and grades the answers", async () => {
  const { runImageCheck } = await import("../jev-image-check");
  let images = 0;
  const result = await runImageCheck(
    async (input, _signal, sent = []) => {
      images = sent.length;
      for (const image of sent)
        expect(JSON.stringify(input)).toContain(image.reference);
      return {
        model: JEV_MODEL,
        cost: 0.0001,
        usage: triaged.usage,
        answers: {
          image_1: { type: "choice", choice: "blue" },
          image_2: { type: "choice", choice: "red" },
          image_3: { type: "choice", choice: "unknown" },
        },
      };
    },
    ["blue", "red", "green"],
  );
  expect(images).toBe(3);
  expect(result.ok).toBe(false);
  expect(result.answers.map((a) => a.answer)).toEqual([
    "blue",
    "red",
    "unknown",
  ]);
});

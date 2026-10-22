import { z } from "zod";
import type { Config } from "./config";
import { sleep } from "./io";
import { normalizeUsage, retryDelay } from "./llm";
import { JEV_IMAGES_HEADER, MAX_JEV_IMAGES, type JevImage } from "./jev-images";

export const JEV_MODEL = "~typesafe/jev-latest";
const instruction = z.string().trim().min(1).max(4000);
const question = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("noul"),
      instructions: instruction,
      criteria: z.object({ true: instruction, false: instruction }).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("choice"),
      instructions: instruction,
      criteria: z
        .record(z.string().min(1).max(80), instruction)
        .refine(
          (v) => Object.keys(v).length >= 2 && Object.keys(v).length <= 20,
          "choice needs 2–20 criteria",
        ),
    })
    .strict(),
  z
    .object({
      type: z.literal("score"),
      instructions: instruction,
      criteria: z.array(instruction).min(2).max(10),
    })
    .strict(),
]);

// Bound batches and option labels so distributions fit in a tool result;
// these are Hibana limits, not the provider's maximum batch size.
export const jevInputSchema = z
  .object({
    state: z.union([
      z.string().min(1),
      z.record(z.unknown()),
      z.array(z.unknown()),
    ]),
    questions: z
      .record(z.string().min(1).max(80), question)
      .refine(
        (v) => Object.keys(v).length >= 1 && Object.keys(v).length <= 16,
        "Jev needs 1–16 independent questions",
      ),
  })
  .refine(
    (v) => JSON.stringify(v).length <= 60000,
    "Jev input is too large; send relevant excerpts only",
  );

// One-line Discord notices distinguish ordinary evaluation from the task loop.
export const JEV_NOTICE_HEADER = "サブ: Jev を呼び出します";
export const JEV_TASK_NOTICE_HEADER = "サブ: Jev でタスクを進めます。";

const probability = z.number().min(0).max(1);
const distribution = {
  confidence: probability.optional(),
  probabilities: z.record(probability).optional(),
};
const responseSchema = z.object({
  model: z.string().min(1),
  answers: z.record(
    z.discriminatedUnion("type", [
      z.object({ type: z.literal("noul"), noul: probability }),
      z.object({
        type: z.literal("choice"),
        choice: z.string(),
        ...distribution,
      }),
      z.object({
        type: z.literal("score"),
        score: z.number().finite(),
        ...distribution,
        legend: z.record(z.unknown()).optional(),
      }),
    ]),
  ),
  usage: z.object({
    input_tokens: z.number().nonnegative(),
    output_tokens: z.number().nonnegative(),
    cost: z.number().nonnegative().optional(),
  }),
});

/** Jev answered an image request with a client error. Image input is
 *  experimental, and the OpenRouter route has not been run with it (#83), so
 *  each caller chooses whether to judge again without the images. */
export class JevImagesRejected extends Error {}

/** Every image must appear in the request: Jev rejects an unreferenced asset. */
function assets(input: unknown, images: readonly JevImage[]) {
  if (images.length > MAX_JEV_IMAGES)
    throw new Error(`Jev takes at most ${MAX_JEV_IMAGES} images`);
  const text = JSON.stringify(input);
  if (images.some((i) => !text.includes(i.reference)))
    throw new Error("Every Jev image must be referenced in the request");
  return Object.fromEntries(
    images.map(({ reference, format, data_base64 }) => [
      reference,
      { type: "image", format, data_base64 },
    ]),
  );
}

export class JevClient {
  constructor(
    private config: Config,
    private fetcher: (
      url: string,
      init?: RequestInit,
    ) => Promise<Response> = fetch,
  ) {}

  async decide(
    input: z.infer<typeof jevInputSchema>,
    signal?: AbortSignal,
    images: readonly JevImage[] = [],
  ) {
    if (!this.config.jevApiKey) throw new Error("Missing JEV_API_KEY");
    const parsed = jevInputSchema.parse(input);
    // Without images the request is exactly what it was before #83.
    const body = JSON.stringify({
      model: JEV_MODEL,
      ...parsed,
      ...(images.length ? { assets: assets(parsed, images) } : {}),
    });
    // Jev returns typed decisions, not chat text. The endpoint deliberately
    // sits outside /api/v1 and must never enter the normal LLM tool loop.
    for (let attempt = 0; attempt < 3; attempt++) {
      signal?.throwIfAborted();
      let res: Response;
      try {
        res = await this.fetcher("https://openrouter.ai/api/alpha/decisions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.config.jevApiKey}`,
            ...(images.length ? { [JEV_IMAGES_HEADER]: "true" } : {}),
          },
          body,
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(60000)])
            : AbortSignal.timeout(60000),
          redirect: "error",
        });
      } catch {
        signal?.throwIfAborted();
        // Transport errors may contain request details. Return only a safe
        // summary to the parent agent, which can finish without this evaluator.
        if (attempt === 2) throw new Error("Jev request failed");
        await sleep(retryDelay(null, attempt), signal);
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel();
        if (
          [408, 429, 500, 502, 503, 504, 529].includes(res.status) &&
          attempt < 2
        ) {
          await sleep(
            retryDelay(res.headers.get("retry-after"), attempt),
            signal,
          );
          continue;
        }
        if (images.length && [400, 413, 415, 422].includes(res.status))
          throw new JevImagesRejected(`Jev: HTTP ${res.status}`);
        throw new Error(`Jev: HTTP ${res.status}`);
      }
      const response = responseSchema.safeParse(
        await res.json().catch(() => null),
      );
      if (!response.success)
        throw new Error("Jev returned an invalid Decisions response");
      const data = response.data;
      for (const [id, q] of Object.entries(input.questions)) {
        const a = data.answers[id];
        if (
          !a ||
          a.type !== q.type ||
          (a.type === "choice" &&
            q.type === "choice" &&
            !Object.hasOwn(q.criteria, a.choice)) ||
          (a.type === "score" &&
            q.type === "score" &&
            (a.score < 0 || a.score > q.criteria.length - 1))
        )
          throw new Error(
            "Jev returned an answer outside the requested criteria",
          );
      }
      if (
        Object.keys(data.answers).length !== Object.keys(input.questions).length
      )
        throw new Error("Jev returned unexpected answers");
      const result = {
        model: data.model,
        answers: data.answers,
        usage: normalizeUsage(data.usage),
        cost: data.usage.cost,
      };
      // The agent loop truncates tool output at 40k characters. Refuse an
      // oversized distribution instead of returning broken JSON as evidence.
      if (JSON.stringify(result).length > 35000)
        throw new Error(
          "Jev result is too large; use fewer questions or shorter criteria",
        );
      return result;
    }
    throw new Error("Jev retries exhausted");
  }
}

/** Judge with the images and, if Jev rejects them, once more from the text
 *  alone. For the silent judgments before a turn (triage, routing), where a
 *  judgment without the images is still the one Hibana made before #83. */
export async function decideWithImageFallback<
  T extends z.infer<typeof jevInputSchema>,
>(
  decide: JevClient["decide"],
  build: (images: readonly JevImage[]) => T,
  images: readonly JevImage[],
  signal: AbortSignal,
) {
  if (images.length) {
    try {
      return {
        result: await decide(build(images), signal, images),
        images: images.length,
      };
    } catch (error) {
      if (!(error instanceof JevImagesRejected)) throw error;
    }
  }
  return { result: await decide(build([]), signal), images: 0 };
}

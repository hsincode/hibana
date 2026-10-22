// Manual check that Jev sees images sent through OpenRouter (#83):
//   cd apps/bot && bun run jev-image-check
// It needs JEV_API_KEY and spends one Decisions call with three small images,
// so it is not part of `make ci`. Each image is a solid color, and Jev is asked
// for each color. If OpenRouter dropped the images, Jev would see only the
// opaque references and could name all three colors by chance in 1 of 64
// runs (four choices each).
import { loadConfig } from "./config";
import { JevClient, JevImagesRejected } from "./jev";
import { prepareJevImages, type JevImage } from "./jev-images";
import { solidPng } from "./png";

const colors = {
  red: [220, 30, 30],
  green: [30, 170, 60],
  blue: [30, 60, 220],
} as const;
type Color = keyof typeof colors;

export async function runImageCheck(
  decide: JevClient["decide"],
  order: Color[],
) {
  const urls = order.map(
    (c) =>
      `data:image/png;base64,${solidPng(320, 320, [...colors[c]]).toString("base64")}`,
  );
  const images = (await prepareJevImages(urls, undefined)) as JevImage[];
  const questions = Object.fromEntries(
    images.map((image, i) => [
      `image_${i + 1}`,
      {
        type: "choice" as const,
        instructions: `What single color fills the image ${image.reference}?`,
        criteria: {
          red: "The image is red.",
          green: "The image is green.",
          blue: "The image is blue.",
          unknown: "There is no image, or its color cannot be told.",
        },
      },
    ]),
  );
  const result = await decide(
    { state: { images: images.map((i) => i.reference) }, questions },
    undefined,
    images,
  );
  const answers = order.map((expected, i) => {
    const answer = result.answers[`image_${i + 1}`];
    return {
      expected,
      answer: answer?.type === "choice" ? answer.choice : null,
      confidence: answer?.type === "choice" ? answer.confidence : undefined,
    };
  });
  return {
    model: result.model,
    cost: result.cost,
    answers,
    ok: answers.every((a) => a.answer === a.expected),
  };
}

if (import.meta.main) {
  const config = loadConfig();
  if (!config.jevApiKey) throw new Error("JEV_API_KEY is required");
  const order = (Object.keys(colors) as Color[]).sort(
    () => Math.random() - 0.5,
  );
  try {
    const client = new JevClient(config);
    const result = await runImageCheck(client.decide.bind(client), order);
    console.log(JSON.stringify(result, null, 2));
    console.log(
      result.ok
        ? "Jev named every color: the images reached it."
        : "Jev did not name every color.",
    );
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    console.log(
      error instanceof JevImagesRejected
        ? `Jev rejected the image request (${error.message}).`
        : `The check failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

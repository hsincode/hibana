import { downloadPublic } from "../network";

const IMAGE_TYPES = /^image\/(png|jpeg|gif|webp)$/;
// Anthropic accepts an image of up to 5 MB once base64-encoded.
const IMAGE_BYTES = 3_700_000;

/** Turns attachment URLs into data URLs. Discord's URLs expire, and a session
 *  keeps every message it was sent: a URL left in one would stop resolving
 *  while the conversation goes on. An image that cannot be inlined is left
 *  out and named. */
export async function inlineImages(urls: readonly string[] = [], signal?: AbortSignal): Promise<{ images: string[]; note: string }> {
  const images: string[] = [];
  let skipped = 0;
  for (const url of urls) {
    if (url.startsWith("data:")) { images.push(url); continue; }
    try {
      const response = await downloadPublic(url, signal, IMAGE_BYTES);
      const type = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
      if (!response.ok || !IMAGE_TYPES.test(type)) throw new Error("not an image");
      images.push(`data:${type};base64,${Buffer.from(await response.arrayBuffer()).toString("base64")}`);
    } catch {
      signal?.throwIfAborted();
      skipped++;
    }
  }
  return {
    images,
    note: skipped ? `\n[${skipped} attached image${skipped === 1 ? "" : "s"} could not be shown to you: larger than ${Math.floor(IMAGE_BYTES / 1e6)} MB, not png/jpeg/gif/webp, or no longer downloadable. Save the attachment into the workspace to work on it.]` : "",
  };
}

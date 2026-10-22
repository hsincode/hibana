import { downloadPublic } from "./network";

// Jev reads images only as an experimental feature (#83): the request carries
// `TypeSafe-Danger-Zone-Images: true` and base64 files in `assets`, and any
// string equal to or containing an asset's reference becomes that image.
// https://docs.typesafe.ai/images
export const JEV_IMAGES_HEADER = "TypeSafe-Danger-Zone-Images";

// Hibana's bounds, not the provider's (#83). The owner gave 4 images and 3
// seconds for an image step before choosing Jev's own image input.
export const MAX_JEV_IMAGES = 4;
export const JEV_IMAGE_PREP_TIMEOUT_MS = 3000;
// Jev takes 32 MiB per request body. Four base64 images of 5 MiB stay well
// under it with the JSON around them.
export const MAX_JEV_IMAGE_BYTES = 5 * 1024 * 1024;

// Jev rejects the whole request for an image outside these limits.
const MIN_SIDE = 256,
  MAX_SIDE = 1568,
  MIN_PIXELS = 78400,
  MAX_PIXELS = 2458624;

export type JevImage = {
  reference: string;
  format: "png" | "jpg";
  data_base64: string;
};
type ImageInfo = { format: "png" | "jpg"; width: number; height: number };
export type Download = (
  url: string,
  signal: AbortSignal,
  limit: number,
) => Promise<Uint8Array>;

const u32 = (b: Uint8Array, i: number) =>
  ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;
const u16 = (b: Uint8Array, i: number) => (b[i]! << 8) | b[i + 1]!;
const ascii = (b: Uint8Array, i: number, n: number) =>
  String.fromCharCode(...b.subarray(i, i + n));

/** Format and size from the file header. Undefined for anything Jev cannot
 *  read: not PNG or JPEG, an animated PNG, or a damaged header. */
export function imageInfo(bytes: Uint8Array): ImageInfo | undefined {
  if (
    bytes.length > 24 &&
    u32(bytes, 0) === 0x89504e47 &&
    u32(bytes, 4) === 0x0d0a1a0a &&
    ascii(bytes, 12, 4) === "IHDR"
  ) {
    // An animated PNG declares acTL before its first IDAT; Jev rejects it.
    for (let i = 8; i + 8 <= bytes.length;) {
      const type = ascii(bytes, i + 4, 4);
      if (type === "acTL") return undefined;
      if (type === "IDAT") break;
      i += 12 + u32(bytes, i);
    }
    return { format: "png", width: u32(bytes, 16), height: u32(bytes, 20) };
  }
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    for (let i = 2; i + 4 <= bytes.length;) {
      if (bytes[i] !== 0xff) return undefined;
      const marker = bytes[i + 1]!;
      if (marker === 0xff) {
        i++;
        continue;
      }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
        i += 2;
        continue;
      }
      // SOF0–SOF15 carry the frame size; C4, C8 and CC are other segments.
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        ![0xc4, 0xc8, 0xcc].includes(marker)
      )
        return i + 9 <= bytes.length
          ? {
              format: "jpg",
              height: u16(bytes, i + 5),
              width: u16(bytes, i + 7),
            }
          : undefined;
      i += 2 + u16(bytes, i + 2);
    }
  }
  return undefined;
}

export const fitsJev = ({ width, height }: { width: number; height: number }) =>
  width >= MIN_SIDE &&
  width <= MAX_SIDE &&
  height >= MIN_SIDE &&
  height <= MAX_SIDE &&
  width * height >= MIN_PIXELS &&
  width * height <= MAX_PIXELS;

/** The largest size within Jev's limits with the same aspect ratio, or
 *  undefined when shrinking cannot make the image fit. */
export function jevSize(width: number, height: number) {
  const scale = Math.min(
    1,
    MAX_SIDE / width,
    MAX_SIDE / height,
    Math.sqrt(MAX_PIXELS / (width * height)),
  );
  const size = {
    width: Math.floor(width * scale),
    height: Math.floor(height * scale),
  };
  return fitsJev(size) ? size : undefined;
}

/** Discord's media proxy serves an attachment scaled down with width and
 *  height. This is not a documented API: the caller checks what comes back. */
export function discordResizeUrl(
  url: string,
  width: number,
  height: number,
): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (
    parsed.protocol !== "https:" ||
    !["cdn.discordapp.com", "media.discordapp.net"].includes(parsed.hostname) ||
    !/^\/(?:ephemeral-)?attachments\//.test(parsed.pathname)
  )
    return undefined;
  parsed.hostname = "media.discordapp.net";
  parsed.searchParams.set("width", String(width));
  parsed.searchParams.set("height", String(height));
  return parsed.href;
}

export const downloadImage: Download = async (url, signal, limit) =>
  new Uint8Array(
    await (await downloadPublic(url, signal, limit)).arrayBuffer(),
  );

async function loadOne(url: string, signal: AbortSignal, download: Download) {
  const inline = /^data:[^;,]+;base64,(.*)$/s.exec(url);
  let bytes: Uint8Array;
  if (inline) bytes = Buffer.from(inline[1]!, "base64");
  else if (/^https:\/\//i.test(url))
    bytes = await download(url, signal, MAX_JEV_IMAGE_BYTES);
  else return undefined;
  let info = imageInfo(bytes);
  if (!info) return undefined;
  if (!fitsJev(info) || bytes.length > MAX_JEV_IMAGE_BYTES) {
    const size = jevSize(info.width, info.height);
    const resized =
      size && !inline
        ? discordResizeUrl(url, size.width, size.height)
        : undefined;
    if (!resized) return undefined;
    bytes = await download(resized, signal, MAX_JEV_IMAGE_BYTES);
    info = imageInfo(bytes);
    if (!info || !fitsJev(info)) return undefined;
  }
  if (bytes.length > MAX_JEV_IMAGE_BYTES) return undefined;
  return {
    format: info.format,
    data_base64: Buffer.from(bytes).toString("base64"),
  };
}

/** Loads up to four images (Discord URLs or data URLs) for Jev within the
 *  preparation deadline. The result lines up with the input: an image that
 *  cannot be read, does not fit Jev's limits or misses the deadline is
 *  undefined, and the caller decides whether to go on without it. */
export async function prepareJevImages(
  urls: readonly string[],
  signal: AbortSignal | undefined,
  download: Download = downloadImage,
  timeoutMs = JEV_IMAGE_PREP_TIMEOUT_MS,
): Promise<(JevImage | undefined)[]> {
  const deadline = AbortSignal.any([
    ...(signal ? [signal] : []),
    AbortSignal.timeout(timeoutMs),
  ]);
  // A short random tag keeps a reference from matching text that happens to be
  // in the request: Jev replaces every occurrence, not only whole values.
  const tag = crypto.randomUUID().slice(0, 8);
  const expired = new Promise<undefined>((resolve) => {
    if (deadline.aborted) resolve(undefined);
    deadline.addEventListener("abort", () => resolve(undefined), {
      once: true,
    });
  });
  return Promise.all(
    urls.slice(0, MAX_JEV_IMAGES).map(async (url, index) => {
      const loaded = await Promise.race([
        loadOne(url, deadline, download).catch(() => undefined),
        expired,
      ]);
      return (
        loaded && { reference: `<<image ${index + 1} ${tag}>>`, ...loaded }
      );
    }),
  );
}

/** Replaces the parent's {{image:N}} placeholders with the references of the
 *  prepared images, in every string but object keys (Jev never replaces keys
 *  either). Throws for a placeholder without an image or an image that is
 *  never referenced, which Jev would reject as a whole. */
export function placeImages<T>(value: T, references: readonly string[]): T {
  const used = new Set<number>();
  const visit = (v: unknown): unknown => {
    if (typeof v === "string")
      return v.replace(/\{\{\s*image\s*:\s*(\d+)\s*\}\}/gi, (_, n: string) => {
        const reference = references[Number(n) - 1];
        if (reference === undefined)
          throw new Error(`{{image:${n}}} has no image in images`);
        used.add(Number(n));
        return reference;
      });
    if (Array.isArray(v)) return v.map(visit);
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.entries(v).map(([k, x]) => [k, visit(x)]),
      );
    return v;
  };
  const placed = visit(value) as T;
  const missing = references.findIndex((_, i) => !used.has(i + 1));
  if (missing >= 0)
    throw new Error(
      `images[${missing}] is never referenced; use {{image:${missing + 1}}}`,
    );
  return placed;
}

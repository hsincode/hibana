// Ogg Opus, written without re-encoding (#138). The bot stores the Opus
// packets Discord sends as they are; the recording's page in the browser
// muxes what its encoder makes the same way. Nothing here uses Node, so the
// player (`recording-player/`) bundles this file as it is.
// Ogg: RFC 3533. Ogg Opus: RFC 7845. Opus packets (the TOC byte): RFC 6716 §3.1.

/** 20 ms of silence (CELT, full band, one frame): what Discord itself sends
 *  at the end of speech. A pause inside speech is filled with it. */
export const OPUS_SILENCE = new Uint8Array([0xf8, 0xff, 0xfe]);
/** Opus timestamps are counted at 48 kHz, whatever the input rate. */
export const OPUS_RATE = 48000;

/** Samples (at 48 kHz) one Opus packet decodes to; 0 for one that cannot
 *  be read. */
export function opusSamples(packet: Uint8Array): number {
  if (!packet.length) return 0;
  const toc = packet[0]!;
  const config = toc >> 3;
  // Frame length in tenths of a millisecond.
  const tenths =
    config < 12
      ? [100, 200, 400, 600][config % 4]!
      : config < 16
        ? [100, 200][config % 2]!
        : [25, 50, 100, 200][config % 4]!;
  const code = toc & 3;
  const frames =
    code === 0 ? 1 : code < 3 ? 2 : packet.length > 1 ? packet[1]! & 0x3f : 0;
  return (frames * tenths * OPUS_RATE) / 10000;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++)
      r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    table[i] = r >>> 0;
  }
  return table;
})();
/** The page checksum of Ogg: polynomial 0x04c11db7, starting at 0, not
 *  reflected and not inverted. */
export function oggCrc(data: Uint8Array): number {
  let crc = 0;
  for (const byte of data)
    crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ byte) & 0xff]!) >>> 0;
  return crc;
}

const ascii = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0));

/** The identification header (RFC 7845 §5.1), mapping family 0. */
export function opusHead(channels: number, preSkip = 0, inputRate = OPUS_RATE) {
  const head = new Uint8Array(19);
  const view = new DataView(head.buffer);
  head.set(ascii("OpusHead"));
  head[8] = 1;
  head[9] = channels;
  view.setUint16(10, preSkip, true);
  view.setUint32(12, inputRate, true);
  return head;
}

/** The comment header (RFC 7845 §5.2), with no comments. */
export function opusTags(vendor = "hibana") {
  const name = ascii(vendor);
  const tags = new Uint8Array(8 + 4 + name.length + 4);
  const view = new DataView(tags.buffer);
  tags.set(ascii("OpusTags"));
  view.setUint32(8, name.length, true);
  tags.set(name, 12);
  return tags;
}

/** One packet per lacing run; a page holds this many lacing values at most. */
const MAX_LACING = 255;
/** A page is closed after about a second of 20 ms packets, so a player can
 *  seek inside a chunk. */
const PACKETS_PER_PAGE = 50;

/**
 * One Ogg Opus stream, whole: the two headers, then the audio pages, the
 * last one marked as the end. Each packet's samples come from its TOC, so
 * the granule positions match what a decoder plays.
 */
export function oggOpus(
  packets: Uint8Array[],
  options: { serial: number; channels: number; preSkip?: number },
): Uint8Array<ArrayBuffer> {
  const pages: Uint8Array[] = [];
  let sequence = 0;
  const page = (data: Uint8Array[], granule: number, flags: number) => {
    const lacing: number[] = [];
    for (const packet of data) {
      let left = packet.length;
      while (left >= 255) {
        lacing.push(255);
        left -= 255;
      }
      lacing.push(left);
    }
    const size = data.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(27 + lacing.length + size);
    const view = new DataView(out.buffer);
    out.set(ascii("OggS"));
    out[4] = 0;
    out[5] = flags;
    // Granule positions stay far below 2^53.
    view.setUint32(6, granule % 2 ** 32, true);
    view.setUint32(10, Math.floor(granule / 2 ** 32), true);
    view.setUint32(14, options.serial >>> 0, true);
    view.setUint32(18, sequence++, true);
    out[26] = lacing.length;
    out.set(lacing, 27);
    let at = 27 + lacing.length;
    for (const packet of data) {
      out.set(packet, at);
      at += packet.length;
    }
    view.setUint32(22, oggCrc(out), true);
    pages.push(out);
  };
  page([opusHead(options.channels, options.preSkip ?? 0)], 0, 0x02);
  page([opusTags()], 0, 0);
  // Counts every decoded sample: the pre-skip is taken off by the player.
  let granule = 0;
  let current: Uint8Array[] = [];
  let lacing = 0;
  const flush = (last: boolean) => {
    if (!current.length && !last) return;
    page(current, granule, last ? 0x04 : 0);
    current = [];
    lacing = 0;
  };
  for (const [i, packet] of packets.entries()) {
    const needs = Math.floor(packet.length / 255) + 1;
    if (lacing + needs > MAX_LACING || current.length >= PACKETS_PER_PAGE)
      flush(false);
    current.push(packet);
    lacing += needs;
    granule += opusSamples(packet);
    if (i === packets.length - 1) flush(true);
  }
  if (!packets.length) flush(true);
  return concat(pages);
}

export function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

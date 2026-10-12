import type { Logger } from "pino";
import type { Config, Selection } from "../config";
import type { History } from "../history";
import type { LlmClient } from "../llm";
import { ProviderError } from "../llm-errors";
import { downloadPublic } from "../network";
import { addUsage, emptyUsage, type Message, type ToolDef, type Usage } from "../types";

// What the Claude harness (#66) does to keep a conversation sendable as it
// grows, without editing what was already sent: images are stored as data, and
// a conversation that has grown past its budget is replaced as a whole by a
// summary the API writes.

const IMAGE_TYPES = /^image\/(png|jpeg|gif|webp)$/;
// Anthropic accepts an image of up to 5 MB once base64-encoded.
const IMAGE_BYTES = 3_700_000;

/** Turns attachment URLs into data URLs. Discord's URLs expire; a URL left in
 *  the conversation would fail every later request once it did, and dropping
 *  the image from history (as the other harness does) changes a turn that was
 *  already sent. An image that cannot be inlined is left out and named. */
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

/** A person's message as the Claude harness sends it: the text Discord gave,
 *  the date (the model's knowledge ends well before it), and images as data. */
export async function userMessage(text: string, images: readonly string[] | undefined, signal?: AbortSignal): Promise<Message> {
  const inlined = await inlineImages(images, signal);
  return {
    role: "user", turnStart: true,
    content: `${text}${inlined.note}\n[date: ${new Date().toISOString().slice(0, 10)}]`,
    ...(inlined.images.length && { images: inlined.images }),
  };
}

const SUMMARY_REQUEST =
  "This conversation has grown long, and it will continue from a summary of it in place of the messages so far. Write that summary now, as text only, without calling tools. Keep what is needed to carry on: what each person asked for and what is still open, decisions and their reasons, the names and paths of files created or changed, the results that later work depends on, and anything a person asked you to remember. Leave out the steps that led there.";

export class ClaudeCompaction {
  // Conversations the provider rejected as too long. Their recorded size was
  // under the budget, so the next turn has to summarize regardless.
  private oversized = new Set<string>();
  constructor(private config: Config, private history: History, private llm: LlmClient, private log?: Logger) {}

  markOversized(channelId: string) {
    this.oversized.add(channelId);
  }
  private budget(selection: Selection) {
    return /haiku/.test(selection.model) ? this.config.claudeCompactTokensHaiku : this.config.claudeCompactTokens;
  }
  /** Summarizes the stored conversation when its last request was over
   *  budget. Returns the usage it spent, or undefined when nothing was done.
   *  A failure leaves the conversation as it was: the turn goes ahead with the
   *  long history instead of failing on housekeeping. */
  async run(options: {
    channelId: string; selection: Selection; prefix: Message[]; prior: Message[]; tools: ToolDef[];
    nativeSearch: boolean; signal?: AbortSignal; turn?: string;
  }): Promise<Usage | undefined> {
    const { channelId, selection, prior } = options;
    if (!prior.length) return;
    const size = this.history.contextTokens(channelId) ?? 0;
    if (!this.oversized.has(channelId) && size <= this.budget(selection)) return;
    const usage = emptyUsage();
    const request = { nativeSearch: options.nativeSearch, signal: options.signal, claude: true,
      trace: { channel: channelId, agent: "compaction", round: 0, turn: options.turn } };
    let summary: Message[] | undefined;
    let method = "api";
    try {
      const reply = await this.llm.complete(selection, [...options.prefix, ...prior], options.tools, { ...request, compaction: true });
      addUsage(usage, reply.usage);
      // The block is signed: it goes back exactly as it came.
      if (reply.compacted) summary = [{ role: "assistant", content: "", providerBlocks: reply.message.providerBlocks }];
    } catch (error) {
      options.signal?.throwIfAborted();
      this.log?.warn({ channel: channelId, error: error instanceof Error ? error.message : String(error),
        feature: error instanceof ProviderError ? error.feature : undefined }, "Conversation summary by the API failed");
    }
    if (!summary) {
      // Without the API's own summary: ask in the conversation itself, with
      // the same prompt and tools so nothing before the question changes.
      method = "prompt";
      try {
        const reply = await this.llm.complete(selection,
          [...options.prefix, ...prior, { role: "user", internal: true, content: SUMMARY_REQUEST }], options.tools, request);
        addUsage(usage, reply.usage);
        const text = reply.message.content?.trim();
        if (text && !reply.message.tool_calls?.length)
          summary = [{ role: "user", internal: true, content: `<conversation_summary>\n${text}\n</conversation_summary>` }];
      } catch (error) {
        options.signal?.throwIfAborted();
        this.log?.warn({ channel: channelId, error: error instanceof Error ? error.message : String(error) }, "Conversation summary failed");
      }
    }
    if (summary && this.history.replace(channelId, prior, summary)) {
      this.oversized.delete(channelId);
      this.log?.info({ channel: channelId, method, context_tokens: size, usage }, "Conversation summarized");
    }
    return usage;
  }
}

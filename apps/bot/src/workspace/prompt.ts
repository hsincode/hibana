import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  BetaManagedAgentsImageBlock,
  BetaManagedAgentsTextBlock,
} from "@anthropic-ai/sdk/resources/beta/sessions/events";
import type { Runtime } from "../runtime";
import type { Context } from "../types";
import { inlineImages } from "./images";
import type { WorkspaceVariant } from "./select";

// The Anthropic Workspace prompt (#76). A session keeps the system prompt it
// was created with, and that prompt is the same bytes for every server, person
// and model, so that it can be cached: no name, no setting and no limit value
// goes into it. What depends on the server or the person travels in the
// conversation instead, as the context block at the head of a person's
// message.

const dir = join(import.meta.dir, "../../prompts/harness");
const read = (path: string) =>
  readFile(path, "utf8").catch((e) => {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw e;
  });

/** What `agent_with_overrides.system` accepts. */
const SYSTEM_MAX_CHARS = 100_000;

/** The system prompt a session is created with. `ultra` is the plain text plus
 *  the section on workflow runs. The files are read from `from`, which only
 *  tests set. */
export async function workspaceSystem(
  variant: WorkspaceVariant,
  from = dir,
): Promise<string> {
  const [plain, runs] = await Promise.all([
    read(join(from, "workspace.md")),
    variant === "ultra" ? read(join(from, "workspace-ultra.md")) : "",
  ]);
  if (!plain.trim()) throw new Error("prompts/harness/workspace.md is missing");
  // Going on with the plain text would leave an agent that can start runs
  // without a word on when to, or on the limits: fail the turn instead.
  if (variant === "ultra" && !runs.trim())
    throw new Error("prompts/harness/workspace-ultra.md is missing");
  const system = [plain.trim(), runs.trim()].filter(Boolean).join("\n\n");
  if (system.length > SYSTEM_MAX_CHARS)
    throw new Error(
      `The Workspace system prompt is ${system.length} characters; a session accepts ${SYSTEM_MAX_CHARS}`,
    );
  return system;
}

/** Who the bot is here and what kind of place this is: persona, the server's
 *  or the person's own instructions, and whether the conversation is a
 *  channel, a thread or a direct message. It is user-role text, because server
 *  members write part of it. There is no skills section (this path offers
 *  none) and no date (a session outlives the day; each message carries its
 *  own). */
export async function workspaceContextBlock(
  runtime: Runtime,
  ctx: Context,
): Promise<string> {
  const settings = runtime.resolve(ctx.guildId, ctx.userId);
  const persona = settings.context?.persona_override
    ? ""
    : (await read(runtime.config.personaFile)).trim() ||
      "You are Hibana (火花), a helpful Discord assistant. Respond naturally in Japanese unless asked otherwise.";
  const place = !ctx.guildId
    ? "This conversation takes place in direct messages."
    : `This conversation takes place in a ${ctx.thread ? "thread" : "channel"} of a Discord server. Its container is not shared with the server's other channels.`;
  const section = (tag: string, body: string) =>
    body.trim() ? `<${tag}>\n${body.trim()}\n</${tag}>` : "";
  return [
    "<hibana_context>",
    section("persona", persona),
    section("instructions", settings.context?.text ?? ""),
    section("place", place),
    "</hibana_context>",
  ]
    .filter(Boolean)
    .join("\n");
}

/** What the session row remembers of the block it was last sent. The block
 *  goes out with the first message of a session and again only when this
 *  value differs: another person's own context, edited instructions. */
export const contextDigest = (block: string): string =>
  createHash("sha256").update(block).digest("hex");

export type UserContent = Array<
  BetaManagedAgentsTextBlock | BetaManagedAgentsImageBlock
>;

const dated = (now = new Date()) => `[date: ${now.toISOString().slice(0, 10)}]`;

/** A `data:` URL as an image block. `inlineImages` lets any `data:` URL
 *  through, so the type is checked here. */
function imageBlock(url: string): BetaManagedAgentsImageBlock | undefined {
  const data = /^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/.exec(url);
  if (data)
    return {
      type: "image",
      source: { type: "base64", media_type: data[1]!, data: data[2]! },
    };
}

/** The `content` of one `user.message`: the context block when it has to be
 *  sent, then the text Discord gave with its notes and the date (the model's
 *  knowledge ends well before it), then the images as data. The block rides
 *  in the same message because a `user.message` of its own would start a turn
 *  of its own, and a `system.message` would promote text that members wrote. */
export async function userContent(input: {
  text: string;
  images?: readonly string[];
  context?: string;
  notes?: readonly string[];
  signal?: AbortSignal;
  now?: Date;
}): Promise<UserContent> {
  // Discord's URLs expire and the session keeps the message, so images go in
  // as data. One that cannot be inlined is left out and named.
  const inlined = await inlineImages(input.images, input.signal);
  const images: BetaManagedAgentsImageBlock[] = [];
  for (const url of inlined.images) {
    const block = imageBlock(url);
    if (block) images.push(block);
  }
  const dropped = inlined.images.length - images.length;
  const text = [
    `${input.text}${inlined.note}`,
    ...(dropped
      ? [
          `[${dropped} attached image${dropped === 1 ? "" : "s"} could not be shown to you: not png/jpeg/gif/webp data.]`,
        ]
      : []),
    ...(input.notes ?? []),
    dated(input.now),
  ].join("\n");
  const content: UserContent = [];
  if (input.context) content.push({ type: "text", text: input.context });
  content.push({ type: "text", text }, ...images);
  return content;
}

/** Sent in place of the person's message when a turn is picked up after a
 *  restart: the session already holds that message, and sending it again
 *  would ask for the work twice. */
export function resumeContent(now?: Date): UserContent {
  return [
    {
      type: "text",
      text:
        "[The bot restarted while you were working on the message above, and the work was interrupted. " +
        "Before redoing anything, check what is already done: the files in the container, and what was already sent to the channel. " +
        `Then finish the work and write the reply.]\n${dated(now)}`,
    },
  ];
}

/** A line for `notes` when runs of an earlier turn never ended. Their names
 *  are text the model wrote, so they are quoted and bounded. */
export function openRunsNote(names: readonly string[]): string {
  const shown = names
    .slice(0, 10)
    .map((name) =>
      JSON.stringify(name.replace(/\s+/g, " ").trim().slice(0, 64)),
    );
  const more =
    names.length > shown.length
      ? ` and ${names.length - shown.length} more`
      : "";
  return (
    `[Workflow runs from an earlier turn are still open: ${shown.join(", ")}${more}. ` +
    "Continue them if this message asks for that work to go on; otherwise stop them before doing anything else.]"
  );
}

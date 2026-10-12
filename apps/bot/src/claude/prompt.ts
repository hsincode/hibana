import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Runtime } from "../runtime";
import type { Context, Message } from "../types";

// The Claude harness's prompt (#66). The system prompt is two files and
// nothing else: it is the same bytes for every server, user and model, so the
// provider can cache it and so it never changes under a conversation (a
// changed system prompt invalidates the thinking blocks already in it).
// Everything that depends on the server or the person goes in the context
// block, which travels in the conversation instead.

const dir = join(import.meta.dir, "../../prompts/harness");
const read = (path: string) =>
  readFile(path, "utf8").catch((e) => {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw e;
  });

export async function claudeSystem(runtime: Runtime): Promise<Message> {
  const [harness, deployment] = await Promise.all([read(join(dir, "claude.md")), read(runtime.config.claudePromptFile)]);
  if (!harness.trim()) throw new Error("prompts/harness/claude.md is missing");
  return { role: "system", content: [harness.trim(), deployment.trim()].filter(Boolean).join("\n\n") };
}

/** System prompt of a subagent: its role only. It shares no text with the
 *  parent's prompt because it shares none of the parent's conversation. */
export async function subagentSystem(type: string): Promise<Message> {
  const text = await read(join(dir, type === "Explore" ? "claude-explore.md" : "claude-agent.md"));
  if (!text.trim()) throw new Error(`The prompt for ${type} subagents is missing`);
  return { role: "system", content: text.trim() };
}

const OPEN = "<hibana_context>";

/** Who the bot is here and what this place has: persona, the server's or the
 *  person's own instructions, the workspace's scope, and the skills. It is
 *  user-role text, because server members write part of it. */
export async function contextBlock(runtime: Runtime, ctx: Context, skills: string): Promise<string> {
  const settings = runtime.resolve(ctx.guildId, ctx.userId);
  const persona = settings.context?.persona_override
    ? ""
    : (await read(runtime.config.personaFile)).trim() ||
      "You are Hibana (火花), a helpful Discord assistant. Respond naturally in Japanese unless asked otherwise.";
  const scope = ctx.thread ? "this thread" : ctx.guildId ? "this server" : "this direct-message conversation";
  const section = (tag: string, body: string) => (body.trim() ? `<${tag}>\n${body.trim()}\n</${tag}>` : "");
  return [
    OPEN,
    section("persona", persona),
    section("instructions", settings.context?.text ?? ""),
    section("workspace", `/workspace belongs to ${scope}.`),
    section("skills", skills),
    "</hibana_context>",
  ].filter(Boolean).join("\n");
}

/** The context block that the conversation currently carries, if any. */
export function contextInForce(messages: readonly Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "user" && m.internal && m.content?.startsWith(OPEN)) return m.content;
  }
}

/** The block is sent when the conversation does not carry it yet and again
 *  only when it has changed (new skills, edited instructions, another person's
 *  own context), each time as a new message. Rewriting the first one instead
 *  would change the head of the conversation on every such edit. */
export function contextMessage(block: string, messages: readonly Message[]): Message | undefined {
  if (contextInForce(messages) === block) return;
  return { role: "user", internal: true, content: block };
}

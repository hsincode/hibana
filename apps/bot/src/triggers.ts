import { BUILTIN_TRIGGERS } from "@hibana/shared/catalog";
import { triggerNamesEqual, type GuildRow } from "@hibana/shared/settings";
export function commentedOut(content: string) {
  const text = content.trimStart();
  if (/^#{2,6}(?:\s|$)/.test(text)) return false;
  return /^(?:\/\/|#|\/\*|<!--|--(?:\s|$)|;)/.test(text);
}
export function triggerWords(
  guild: Pick<GuildRow, "extra_triggers" | "disabled_triggers">,
  extra: string[] = [],
): string[] {
  return [
    ...BUILTIN_TRIGGERS.filter(
      (w) => !guild.disabled_triggers.some((d) => triggerNamesEqual(w, d)),
    ),
    ...(guild.extra_triggers ?? extra),
  ];
}
export function matchesKeyword(text: string, words: string[]) {
  return words.some((word) => {
    if (!word) return false;
    if (/^[\x00-\x7f]+$/.test(word)) {
      const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(
        `(?<![a-zA-Z0-9_])${escaped}(?![a-zA-Z0-9_])`,
        "i",
      ).test(text);
    }
    return text.includes(word);
  });
}
export function shouldRespond(
  input: {
    content: string;
    bot: boolean;
    pinned: boolean;
    system: boolean;
    mention: boolean;
    dm: boolean;
    thread: boolean;
    title?: string;
    forumTitle?: string;
  },
  guild: GuildRow,
  extra: string[] = [],
) {
  if (
    input.bot ||
    input.pinned ||
    input.system ||
    guild.bot_disabled ||
    commentedOut(input.content)
  )
    return false;
  if (!input.dm && guild.thread_only && !input.thread) return false;
  const words = triggerWords(guild, extra);
  return (
    input.dm ||
    input.mention ||
    matchesKeyword(input.content, words) ||
    (input.thread &&
      matchesKeyword(`${input.title || ""}\n${input.forumTitle || ""}`, words))
  );
}
// Text prefix, not a Discord slash command. Autocomplete interrupts typing,
// so `/image ` is read from the message body. A leading mention of this bot
// is skipped because Discord stores "@Hibana /image …" as "<@id> /image …".
// Returns the prompt, "" when the prefix has no prompt, or null when the
// message is not this shortcut. Callers still apply shouldRespond first:
// the prefix alone never makes a message a trigger.
export function imagePrompt(content: string, botId: string): string | null {
  let text = content.trimStart();
  if (/^\d{1,25}$/.test(botId))
    text = text.replace(new RegExp(`^(?:<@!?${botId}>[\\s\\u3000]*)+`), "");
  if (!/^\/image(?=$|[\s\u3000])/.test(text)) return null;
  return text.slice("/image".length).trim();
}
export function splitMessage(text: string, max = 1900): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let end = rest.lastIndexOf("\n", max);
    if (end < max / 2) end = max;
    if (/[\uD800-\uDBFF]/.test(rest[end - 1] || "")) end--;
    chunks.push(rest.slice(0, end));
    rest = rest.slice(end).replace(/^\n/, "");
  }
  if (rest) chunks.push(rest);
  return chunks;
}

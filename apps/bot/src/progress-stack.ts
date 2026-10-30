import type { Serial } from "./io";

/** A posted Discord message the turn's progress is shown in. */
export type ProgressMessage = {
  edit(options: {
    content: string;
    allowedMentions: { parse: [] };
  }): Promise<unknown>;
  delete(): Promise<unknown>;
};

type Line = { text: string; transient?: object };
type Page = { message?: ProgressMessage; lines: Line[]; unshown: boolean };

/** The turn's progress. It stacks instead of being replaced (#134): each
 *  text goes under what is already shown, so the turn's steps stay readable,
 *  and a line that would not fit in 1,900 characters starts the next
 *  message. A failed send or edit leaves its lines to be shown by the next
 *  write.
 *
 *  A text added under a `transient` key is taken back by `retract` with the
 *  same key (#140): a reconnect notice goes once its request is over. Its
 *  lines are cut out of every message they are in, and a message left with
 *  no line is deleted. */
export function progressStack(
  send: (content: string) => Promise<ProgressMessage>,
  serial: Serial,
) {
  let page: Page = { lines: [], unshown: false };
  // Messages the stack has gone past, kept while they hold a line that can
  // still be taken back.
  let earlier: Page[] = [];
  const content = (p: Page) => p.lines.map((l) => l.text).join("\n");
  const show = async (p: Page) => {
    const text = content(p);
    if (p.message)
      await p.message.edit({ content: text, allowedMentions: { parse: [] } });
    else p.message = await send(text);
    p.unshown = false;
  };
  const add = (text: string, transient?: object) =>
    serial.run(async () => {
      const added = text.trim();
      if (!added) return;
      for (const raw of added.split("\n")) {
        const line = raw.slice(0, 1900);
        if (
          page.lines.length &&
          content(page).length + 1 + line.length > 1900
        ) {
          if (page.unshown) await show(page);
          if (page.lines.some((l) => l.transient)) earlier.push(page);
          page = { lines: [], unshown: false };
        }
        page.lines.push({ text: line, transient });
        page.unshown = true;
      }
      await show(page);
    });
  const retract = (transient: object) =>
    serial.run(async () => {
      for (const p of [...earlier, page]) {
        const kept = p.lines.filter((l) => l.transient !== transient);
        if (kept.length === p.lines.length) continue;
        p.lines = kept;
        // Never shown: the next write shows what is left.
        if (!p.message) continue;
        p.unshown = true;
        try {
          if (kept.length) await show(p);
          else {
            await p.message.delete();
            p.message = undefined;
            p.unshown = false;
          }
        } catch {
          // The message stays as it was. If it is the one being written to,
          // the next write replaces its content.
        }
      }
      earlier = earlier.filter((p) => p.lines.some((l) => l.transient));
    });
  return { add, retract };
}

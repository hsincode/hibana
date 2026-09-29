import { randomUUID } from "node:crypto";
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, Events, MessageFlags,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  type Client, type Interaction, type Message, type SendableChannels,
} from "discord.js";
import { z } from "zod";
import type { Context, ToolDef } from "../types";

const option = z.object({ label: z.string().min(1), description: z.string() });
export const questionsSchema = z.object({
  questions: z.array(z.object({
    id: z.string().regex(/^[a-zA-Z0-9_]+$/),
    header: z.string().min(1).max(12),
    question: z.string().min(1),
    options: z.array(option).min(2).max(3),
  })).min(1).max(3),
}).superRefine(({ questions }, ctx) => {
  if (new Set(questions.map(q => q.id)).size !== questions.length)
    ctx.addIssue({ code: "custom", message: "Question IDs must be unique" });
});

export const requestUserInputTool: ToolDef = {
  type: "function",
  function: {
    name: "request_user_input",
    description: "Ask the current user 1–3 short questions and wait for answers. Use stable question IDs, headers of at most 12 characters, and 2–3 options with labels and descriptions. Put the recommended option first and suffix its label with (Recommended). Do not add an Other option: free text is always available. Answers are returned by question ID as { answers: { id: { answers: [text] } } }.",
    parameters: {
      type: "object", required: ["questions"], additionalProperties: false,
      properties: { questions: {
        type: "array", minItems: 1, maxItems: 3,
        items: {
          type: "object", required: ["id", "header", "question", "options"], additionalProperties: false,
          properties: {
            id: { type: "string", pattern: "^[a-zA-Z0-9_]+$" },
            header: { type: "string", minLength: 1, maxLength: 12 },
            question: { type: "string", minLength: 1 },
            options: { type: "array", minItems: 2, maxItems: 3, items: {
              type: "object", required: ["label", "description"], additionalProperties: false,
              properties: { label: { type: "string", minLength: 1 }, description: { type: "string" } },
            } },
          },
        },
      } },
    },
  },
};

export async function askQuestions(
  client: Client, channel: SendableChannels, input: unknown, ctx: Context,
  timeoutMs = 300_000,
) {
  const { questions } = questionsSchema.parse(input);
  // Reject oversized prompts before sending anything; truncation could hide
  // a choice or change the meaning of a question the user is answering.
  const contents = questions.map(q => `**${q.header}**\n${q.question}\n${q.options.map((o, j) => `${j + 1}. ${o.label} — ${o.description}`).join("\n")}`);
  if (contents.some(content => content.length > 2000))
    throw new Error("Each question including its options must fit in 2000 characters");
  ctx.signal?.throwIfAborted();
  // A per-call nonce keeps old buttons and concurrent requests isolated, even
  // when the model reuses question IDs in the same channel.
  const prefix = `question:${randomUUID()}:`;
  const answers: Record<string, { answers: string[] }> = Object.create(null);
  const messages: Message[] = [];
  const pending = new Set<number>();
  let finished = false;
  let settle!: (reason: string) => void;
  const done = new Promise<string>(resolve => { settle = resolve; });
  const finish = (reason: string) => { finished = true; settle(reason); };
  const abort = () => finish("cancelled");
  const timer = setTimeout(() => finish("timeout"), timeoutMs);
  const handle = async (i: Interaction) => {
    if ((!i.isButton() && !i.isModalSubmit()) || !i.customId.startsWith(prefix)) return;
    if (i.user.id !== ctx.userId || i.channelId !== ctx.channelId || (i.guildId ?? undefined) !== ctx.guildId) {
      await i.reply({ content: "この質問には依頼したユーザーのみ回答できます。", flags: MessageFlags.Ephemeral });
      return;
    }
    const [index, action] = i.customId.slice(prefix.length).split(":");
    const n = Number(index), q = questions[n];
    if (!q || finished || answers[q.id] || pending.has(n)) {
      await i.reply({ content: "この質問の受付は終了しています。", flags: MessageFlags.Ephemeral });
      return;
    }
    if (i.isButton() && action === "other") {
      await i.showModal(new ModalBuilder().setCustomId(`${prefix}${n}:text`).setTitle(q.header)
        .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId("answer").setLabel("回答").setStyle(TextInputStyle.Paragraph).setRequired(true),
        )));
      return;
    }
    const value = i.isModalSubmit() && action === "text"
      ? i.fields.getTextInputValue("answer").trim()
      : i.isButton() ? q.options[Number(action)]?.label : undefined;
    if (!value) {
      await i.reply({ content: "回答を入力してください。", flags: MessageFlags.Ephemeral });
      return;
    }
    // Reserve before acknowledging: duplicate clicks must not race a modal
    // submission and overwrite an answer already accepted for this question.
    pending.add(n);
    await i.deferUpdate();
    if (finished) return;
    answers[q.id] = { answers: [value] };
    await messages[n]?.edit({ components: [] });
    if (Object.keys(answers).length === questions.length) finish("answered");
  };
  const listener = (i: Interaction) => { void handle(i).catch(() => finish("interaction_failed")); };
  client.on(Events.InteractionCreate, listener);
  ctx.signal?.addEventListener("abort", abort, { once: true });
  if (ctx.signal?.aborted) abort();
  try {
    for (const [n, q] of questions.entries()) {
      if (finished) break;
      messages.push(await channel.send({
        content: contents[n],
        allowedMentions: { parse: [] },
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
          ...q.options.map((o, j) => new ButtonBuilder().setCustomId(`${prefix}${n}:${j}`).setLabel(o.label.slice(0, 80)).setStyle(ButtonStyle.Primary)),
          new ButtonBuilder().setCustomId(`${prefix}${n}:other`).setLabel("自由入力").setStyle(ButtonStyle.Secondary),
        )],
      }));
    }
    const reason = await done;
    // Partial answers remain associated with their IDs; an unanswered question
    // must never look like approval or an implicitly selected default.
    return reason === "answered" ? { answers } : { answers, cancelled: true, reason };
  } finally {
    finished = true;
    clearTimeout(timer);
    client.off(Events.InteractionCreate, listener);
    ctx.signal?.removeEventListener("abort", abort);
    await Promise.allSettled(messages.map(m => m.edit({ components: [] })));
  }
}

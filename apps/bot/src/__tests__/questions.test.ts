import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Events, type Client, type SendableChannels } from "discord.js";
import { askQuestions, questionsSchema } from "../tools/questions";
import { harnessTools } from "../harness";
import type { Context } from "../types";

const question = (id = "choice") => ({ id, header: "選択", question: "どちらにしますか？", options: [
  { label: "A (Recommended)", description: "説明 A" }, { label: "B", description: "説明 B" },
] });
const ctx: Context = { channelId: "channel", guildId: "guild", userId: "user", botId: "bot", thread: false, depth: 0, delivered: false };
function fixture() {
  const client = new EventEmitter();
  const sent: any[] = [];
  const channel = { send: async (payload: any) => {
    const message = { payload, edits: [] as any[], edit: async (edit: any) => { message.edits.push(edit); } };
    sent.push(message);
    return message;
  } };
  const start = (questions = [question()], signal?: AbortSignal, timeout = 1000) => askQuestions(
    client as Client, channel as unknown as SendableChannels, { questions }, { ...ctx, signal }, timeout,
  );
  const click = (index: number, action = "0", userId = "user", guildId = "guild", text?: string) => {
    const id = sent[index].payload.components[0].components[0].data.custom_id.replace(/:0$/, `:${action}`);
    const i = {
      customId: id, user: { id: userId }, channelId: "channel", guildId,
      isButton: () => text === undefined, isModalSubmit: () => text !== undefined,
      replies: [] as any[], modal: undefined as any,
      reply: async (p: any) => { i.replies.push(p); },
      deferUpdate: async () => {}, showModal: async (m: any) => { i.modal = m; },
      fields: { getTextInputValue: () => text },
    };
    client.emit(Events.InteractionCreate, i);
    return i;
  };
  return { client, sent, start, click };
}
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
describe("Discord request_user_input", () => {
  test("exposes Codex question fields without a sandbox and validates IDs/options", () => {
    const tool = harnessTools([], false).find(t => t.function.name === "request_user_input")!;
    expect(tool.function.parameters.required).toEqual(["questions"]);
    expect(questionsSchema.safeParse({ questions: [question(), question()] }).success).toBe(false);
    expect(questionsSchema.safeParse({ questions: [{ ...question(), options: [] }] }).success).toBe(false);
    expect(questionsSchema.safeParse({ questions: [{ question: "missing fields" }] }).success).toBe(false);
  });
  test("maps separate answers to IDs, rejects other users/guilds and removes buttons", async () => {
    const f = fixture();
    const result = f.start([question("first"), question("second")]);
    await flush();
    const stranger = f.click(0, "0", "stranger");
    const wrongGuild = f.click(0, "0", "user", "another");
    await flush();
    expect(stranger.replies.length).toBe(1);
    expect(wrongGuild.replies.length).toBe(1);
    f.click(1, "1"); f.click(0);
    expect(await result).toEqual({ answers: { first: { answers: ["A (Recommended)"] }, second: { answers: ["B"] } } });
    expect(f.client.listenerCount(Events.InteractionCreate)).toBe(0);
    expect(f.sent.every(m => m.edits.at(-1).components.length === 0)).toBe(true);
  });
  test("opens a modal and returns its free text", async () => {
    const f = fixture(); const result = f.start(); await flush();
    const button = f.click(0, "other"); await flush();
    expect(button.modal.data.custom_id.endsWith(":text")).toBe(true);
    f.click(0, "text", "user", "guild", "自由な回答");
    expect(await result).toEqual({ answers: { choice: { answers: ["自由な回答"] } } });
  });
  test("cancellation preserves partial answers and cleans listeners", async () => {
    const f = fixture(); const controller = new AbortController();
    const result = f.start([question("first"), question("second")], controller.signal);
    await flush(); f.click(0); await flush(); controller.abort();
    expect(await result).toEqual({ answers: { first: { answers: ["A (Recommended)"] } }, cancelled: true, reason: "cancelled" });
    expect(f.client.listenerCount(Events.InteractionCreate)).toBe(0);
  });
  test("already aborted and oversized requests send no questions", async () => {
    const f = fixture(); const controller = new AbortController(); controller.abort();
    await expect(f.start([question()], controller.signal)).rejects.toThrow();
    await expect(f.start([{ ...question(), question: "x".repeat(2001) }])).rejects.toThrow("2000");
    expect(f.sent).toHaveLength(0);
    expect(f.client.listenerCount(Events.InteractionCreate)).toBe(0);
  });
  test("send failures propagate and release the interaction listener", async () => {
    const client = new EventEmitter();
    const channel = { send: async () => { throw new Error("Missing permissions"); } };
    await expect(askQuestions(client as Client, channel as unknown as SendableChannels,
      { questions: [question()] }, ctx)).rejects.toThrow("Missing permissions");
    expect(client.listenerCount(Events.InteractionCreate)).toBe(0);
  });
  test("timeout does not choose a default answer", async () => {
    const f = fixture();
    expect(await f.start([question()], undefined, 5)).toEqual({ answers: {}, cancelled: true, reason: "timeout" });
    expect(f.client.listenerCount(Events.InteractionCreate)).toBe(0);
  });
});

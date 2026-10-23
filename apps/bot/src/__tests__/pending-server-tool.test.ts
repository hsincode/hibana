import { expect, test } from "bun:test";
import { Agent } from "../agent";
import { LlmClient } from "../llm";
import { loadConfig } from "../config";
import type { Context, Json, Message, ToolDef } from "../types";

// When one response holds both a client tool_use and a server_tool_use, the
// API runs the server tool only once the client results come back, and the
// user turn that carries them may hold nothing but tool_result blocks. Text
// there made Anthropic answer HTTP 400 in production (#103).
const tool: ToolDef = {
  type: "function",
  function: {
    name: "lookup",
    description: "Find a record",
    parameters: { type: "object", properties: {} },
  },
};
const ctx: Context = {
  channelId: "1",
  userId: "2",
  botId: "3",
  thread: false,
  depth: 0,
  delivered: false,
};
const selection = { provider: "anthropic", model: "claude-opus-5-5" };
const mixed = [
  { type: "tool_use", id: "toolu_1", name: "lookup", input: {} },
  {
    type: "server_tool_use",
    id: "srvtoolu_1",
    name: "code_execution",
    input: { code: "print(1)" },
  },
];
const continued = [
  {
    type: "code_execution_tool_result",
    tool_use_id: "srvtoolu_1",
    content: { type: "code_execution_result", stdout: "1" },
  },
  { type: "text", text: "Filtered." },
];

function client(replies: Json[], bodies: Json[]) {
  return new LlmClient(
    loadConfig({ ANTHROPIC_API_KEY: "fixture" }),
    async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({
        usage: { input_tokens: 1, output_tokens: 1 },
        ...replies[bodies.length - 1],
      });
    },
  );
}
const lastTurn = (body: Json) => (body.messages as Json[]).at(-1)!;
const types = (turn: Json) => (turn.content as Json[]).map((b) => b.type);
const texts = (body: Json) =>
  (body.messages as Json[]).flatMap((m) =>
    (m.content as Json[]).filter((b) => b.type === "text").map((b) => b.text),
  );

test("steering waits until the pending server tool has run", async () => {
  const bodies: Json[] = [];
  const pending: Message[] = [];
  const result = await new Agent(
    client(
      [
        { content: mixed, stop_reason: "tool_use" },
        { content: continued, stop_reason: "end_turn" },
        {
          content: [{ type: "text", text: "Steered." }],
          stop_reason: "end_turn",
        },
      ],
      bodies,
    ),
  ).run({
    selection,
    messages: [{ role: "user", content: "start" }],
    tools: [tool],
    context: { ...ctx },
    maxRounds: 6,
    temperature: 0,
    nativeSearch: false,
    takeSteering: () => pending.splice(0),
    execute: async () => {
      pending.push({ role: "user", content: "change direction" });
      return { ok: true };
    },
  });
  expect(bodies).toHaveLength(3);
  // The continuation carries only the client result.
  expect(types(lastTurn(bodies[1]!))).toEqual(["tool_result"]);
  expect(texts(bodies[1]!)).not.toContain("change direction");
  // The steering follows the turn in which the server tool ran.
  expect(lastTurn(bodies[2]!)).toEqual({
    role: "user",
    content: [{ type: "text", text: "change direction" }],
  });
  expect(result.text).toBe("Steered.");
  expect(result.messages.map((m) => m.role)).toEqual([
    "user",
    "assistant",
    "tool",
    "assistant",
    "user",
    "assistant",
  ]);
});

test("a resumed checkpoint sends its new message after the pending server tool", async () => {
  const bodies: Json[] = [];
  const result = await new Agent(
    client(
      [
        { content: continued, stop_reason: "end_turn" },
        {
          content: [{ type: "text", text: "Answered." }],
          stop_reason: "end_turn",
        },
      ],
      bodies,
    ),
  ).run({
    selection,
    messages: [
      { role: "user", content: "start" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "toolu_1",
            type: "function",
            function: { name: "lookup", arguments: "{}" },
          },
        ],
        providerBlocks: mixed,
      },
      { role: "tool", tool_call_id: "toolu_1", content: '{"ok":true}' },
      { role: "user", content: "next question" },
    ],
    tools: [tool],
    context: { ...ctx },
    maxRounds: 6,
    temperature: 0,
    nativeSearch: false,
    execute: async () => ({ ok: true }),
  });
  expect(types(lastTurn(bodies[0]!))).toEqual(["tool_result"]);
  expect(lastTurn(bodies[1]!)).toEqual({
    role: "user",
    content: [{ type: "text", text: "next question" }],
  });
  expect(result.text).toBe("Answered.");
});

test("tool images also wait for the pending server tool", async () => {
  const bodies: Json[] = [];
  await new Agent(
    client(
      [
        { content: mixed, stop_reason: "tool_use" },
        { content: continued, stop_reason: "end_turn" },
        { content: [{ type: "text", text: "Seen." }], stop_reason: "end_turn" },
      ],
      bodies,
    ),
  ).run({
    selection,
    messages: [{ role: "user", content: "start" }],
    tools: [tool],
    context: { ...ctx, pendingImages: [] },
    maxRounds: 6,
    temperature: 0,
    nativeSearch: false,
    execute: async (_name, _args, c) => {
      c.pendingImages!.push("data:image/png;base64,iVBORw0KGgo=");
      return { ok: true };
    },
  });
  expect(types(lastTurn(bodies[1]!))).toEqual(["tool_result"]);
  expect(types(lastTurn(bodies[2]!))).toEqual(["text", "image"]);
});

test("a server tool that already has its result does not hold steering", async () => {
  const bodies: Json[] = [];
  const pending: Message[] = [];
  await new Agent(
    client(
      [
        {
          content: [
            mixed[1],
            {
              type: "code_execution_tool_result",
              tool_use_id: "srvtoolu_1",
              content: { type: "code_execution_result", stdout: "1" },
            },
            mixed[0],
          ],
          stop_reason: "tool_use",
        },
        { content: [{ type: "text", text: "Done." }], stop_reason: "end_turn" },
      ],
      bodies,
    ),
  ).run({
    selection,
    messages: [{ role: "user", content: "start" }],
    tools: [tool],
    context: { ...ctx },
    maxRounds: 6,
    temperature: 0,
    nativeSearch: false,
    takeSteering: () => pending.splice(0),
    execute: async () => {
      pending.push({ role: "user", content: "change direction" });
      return { ok: true };
    },
  });
  expect(bodies).toHaveLength(2);
  expect(types(lastTurn(bodies[1]!))).toEqual(["tool_result", "text"]);
});

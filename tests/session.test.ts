import { test } from "node:test";
import assert from "node:assert/strict";
import type { ModelRequest } from "../server/core/ports";
import { toolSchema } from "../lib/config";
import { agent, harness, tick, until } from "./helpers";
test("all three first-message modes have distinct behavior", async (t) => {
  const waiting = harness();
  t.after(() => waiting.session.close());
  await tick();
  assert.equal(waiting.spoken.length, 0);
  const fixed = harness({
    agent: agent({
      firstMessageMode: "assistant-speaks-first",
      firstMessage: "Welcome aboard.",
    }),
  });
  t.after(() => fixed.session.close());
  await until(() => fixed.spoken.length === 1);
  assert.equal(fixed.spoken[0], "Welcome aboard.");
  let generated = 0;
  const model = harness(
    {
      agent: agent({
        firstMessageMode: "assistant-speaks-first-with-model-generated-message",
      }),
    },
    {
      model: {
        async *stream(r) {
          generated++;
          assert.match(r.messages.at(-1)!.content, /opening/);
          assert.equal(r.tools?.length, 0);
          yield { type: "text", text: "Generated hello." };
        },
        complete: async () => "",
      },
    },
  );
  t.after(() => model.session.close());
  await until(() => model.spoken.length === 1);
  assert.equal(generated, 1);
  assert.equal(model.spoken[0], "Generated hello.");
});
test("eager turns never invoke the model or tools until a final transcript", async (t) => {
  let calls = 0;
  const h = harness(
    {},
    {
      model: {
        async *stream() {
          calls++;
          yield { type: "text", text: "Ready." };
        },
        complete: async () => "",
      },
    },
  );
  t.after(() => h.session.close());
  await tick();
  h.events.onEagerEnd("Transfer me");
  h.events.onResume();
  await tick();
  assert.equal(calls, 0);
  h.events.onEnd("Please help me");
  await until(() => h.spoken.length === 1);
  assert.equal(calls, 1);
});
test("interruption clears playback, cancels pending mark and prevents a transfer", async (t) => {
  let transfers = 0;
  const tool = {
    ...toolSchema.parse({
      type: "transferCall",
      name: "transfer",
      description: "Support",
      destinations: [
        { id: "support", number: "+14155550123", description: "Support" },
      ],
    }),
    id: "tool",
  };
  const h = harness(
    { tools: [tool] },
    {
      model: {
        async *stream() {
          yield {
            type: "tool-call",
            call: {
              id: "transfer-1",
              name: "transfer",
              arguments: '{"destinationId":"support"}',
            },
          };
        },
        complete: async () => "",
      },
      executeTool: async (_tool, _call, ctx) => {
        await ctx.speak("Transferring now.");
        ctx.signal.throwIfAborted();
        transfers++;
        return { terminal: true, result: {} };
      },
    },
  );
  t.after(() => h.session.close());
  h.setAutoMark(false);
  await tick();
  h.events.onEnd("Transfer to support please");
  await until(() =>
    h.sent.some((m) => (m as { event: string }).event === "mark"),
  );
  h.events.onPartial("Wait stop");
  await tick();
  assert.equal(transfers, 0);
  assert.ok(h.sent.some((m) => (m as { event: string }).event === "clear"));
});
test("voicemail ends only after Twilio acknowledges full playback", async (t) => {
  const h = harness({
    purpose: "voicemail",
    agent: agent({
      voicemailDetection: {
        enabled: true,
        action: "leave-message",
        message: "Please call us back.",
      },
    }),
  });
  t.after(() => h.session.close());
  h.setAutoMark(false);
  await until(() =>
    h.sent.some((m) => (m as { event: string }).event === "mark"),
  );
  assert.deepEqual(h.ended, []);
  const m = h.sent.find((m) => (m as { event: string }).event === "mark") as {
    mark: { name: string };
  };
  h.session.handleMark(m.mark.name);
  await until(() => h.ended.length > 0);
  assert.deepEqual(h.ended, ["voicemail"]);
});
test("custom function result is sent back to OpenAI and followed by speech", async (t) => {
  const tool = {
    ...toolSchema.parse({
      type: "function",
      name: "lookup",
      description: "Look up order",
      parameters: { type: "object" },
      server: { url: "https://example.com/tool" },
    }),
    id: "tool",
  };
  let rounds = 0;
  const h = harness(
    { tools: [tool] },
    {
      model: {
        async *stream(r) {
          rounds++;
          if (rounds === 1)
            yield {
              type: "tool-call",
              call: { id: "lookup1", name: "lookup", arguments: "{}" },
            };
          else {
            assert.equal(r.messages.at(-1)?.role, "tool");
            assert.match(r.messages.at(-1)!.content, /shipped/);
            yield { type: "text", text: "Your order shipped." };
          }
        },
        complete: async () => "",
      },
      executeTool: async () => ({ result: { status: "shipped" } }),
    },
  );
  t.after(() => h.session.close());
  await tick();
  h.events.onEnd("Where is my order?");
  await until(() => h.spoken.length > 0);
  assert.equal(rounds, 2);
  assert.equal(h.spoken[0], "Your order shipped.");
});
test("DTMF tool suppresses model preamble and waits for next IVR prompt", async (t) => {
  const tool = {
    ...toolSchema.parse({
      type: "dtmf",
      name: "dtmf",
      description: "Press keys",
    }),
    id: "tool",
  };
  let rounds = 0;
  const h = harness(
    { tools: [tool] },
    {
      model: {
        async *stream() {
          rounds++;
          yield { type: "text", text: "I will press one" };
          yield {
            type: "tool-call",
            call: { id: "keys1", name: "dtmf", arguments: '{"keys":"1"}' },
          };
        },
        complete: async () => "",
      },
      executeTool: async (_t, _c, ctx) => {
        await ctx.playAudio(Buffer.alloc(160, 255));
        return { result: { sent: true }, waitForUser: true };
      },
    },
  );
  t.after(() => h.session.close());
  await tick();
  h.events.onEnd("Press one for support");
  await until(() =>
    h.sent.some((m) => (m as { event: string }).event === "mark"),
  );
  await tick();
  assert.equal(rounds, 1);
  assert.deepEqual(h.spoken, []);
});
test("screening replies once then waits for human, without classifying hold as voicemail", async (t) => {
  let models = 0;
  const h = harness(
    {
      direction: "outbound",
      agent: agent({
        callScreening: {
          enabled: true,
          response: "Luna, calling about your appointment.",
        },
      }),
    },
    {
      model: {
        async *stream() {
          models++;
          yield { type: "text", text: "Hello Sam." };
        },
        complete: async () => "",
      },
    },
  );
  t.after(() => h.session.close());
  await tick();
  h.events.onEnd("Please state your name and reason for calling");
  await until(() => h.spoken.length === 1);
  await tick();
  h.events.onEnd("Please hold while I connect you");
  await tick();
  assert.equal(models, 0);
  h.events.onEnd("Hello this is Sam");
  await until(() => h.spoken.length === 2);
  assert.equal(models, 1);
});
test("interrupted tool completes its protocol record before the next user turn", async (t) => {
  const tool = {
    ...toolSchema.parse({
      type: "function",
      name: "lookup",
      description: "Lookup",
      parameters: { type: "object" },
      server: { url: "https://example.com" },
    }),
    id: "tool",
  };
  let rounds = 0,
    started = false;
  let release!: () => void;
  const wait = new Promise<void>((r) => {
    release = r;
  });
  const requests: ModelRequest[] = [];
  const h = harness(
    { tools: [tool] },
    {
      model: {
        async *stream(r) {
          requests.push(structuredClone(r));
          rounds++;
          if (rounds === 1)
            yield {
              type: "tool-call",
              call: { id: "c1", name: "lookup", arguments: "{}" },
            };
          else yield { type: "text", text: "Okay." };
        },
        complete: async () => "",
      },
      executeTool: async () => {
        started = true;
        await wait;
        return { result: "done" };
      },
    },
  );
  t.after(() => h.session.close());
  await tick();
  h.events.onEnd("Look it up");
  await until(() => started);
  h.events.onPartial("Never mind");
  h.events.onEnd("Please help with something else");
  release();
  await until(() => rounds === 2);
  const messages = requests[1].messages;
  const i = messages.findIndex((m) => m.toolCalls?.length);
  assert.equal(messages[i + 1].role, "tool");
  assert.equal(messages[i + 2].role, "user");
});

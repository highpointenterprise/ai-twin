import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assistantSchema, toolSchema } from "../lib/config";
import { ToolRegistry } from "../server/tools/registry";
import { ToolExecutor } from "../server/tools/executor";
import { AgentStore } from "../server/store/agents";
import { phraseTransfer, modelTools } from "../server/tools/definitions";
import { dtmfAudio, decodeMulaw } from "../server/speech/audio";
import { shouldInterrupt } from "../server/speech/timing";
import { env } from "../lib/env";
import { agent, telephony } from "./helpers";
const transfer = (mode = "description") =>
  toolSchema.parse({
    type: "transferCall",
    name: "transfer",
    description: "Route calls",
    routingMode: mode,
    destinations: [
      {
        id: "sales",
        number: "+14155550123",
        description: "Sales inquiries",
        transferPhrase: "sales team",
      },
    ],
  });
test("configuration rejects missing messages, invalid providers, and out-of-range timing", () => {
  const a = agent();
  assert.equal(
    assistantSchema.safeParse({
      ...a,
      firstMessage: "",
      firstMessageMode: "assistant-speaks-first",
    }).success,
    false,
  );
  assert.equal(
    assistantSchema.safeParse({ ...a, transcriber: { provider: "other" } })
      .success,
    false,
  );
  assert.equal(
    assistantSchema.safeParse({
      ...a,
      voicemailDetection: { enabled: true, action: "leave-message" },
    }).success,
    false,
  );
  assert.equal(
    assistantSchema.safeParse({ ...a, callScreening: { enabled: true } })
      .success,
    false,
  );
  assert.equal(
    assistantSchema.safeParse({ ...a, startSpeakingPlan: { waitSeconds: -1 } })
      .success,
    false,
  );
});
test("assistants, assignments, and reusable tools survive restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "twin-store-"));
  try {
    const tools = new ToolRegistry(join(dir, "tools.json"));
    const t = tools.save(transfer());
    const store = new AgentStore(agent(), join(dir, "agents.json"));
    const a = store.list()[0];
    store.update(a.id, { ...a, toolIds: [t.id] });
    store.assign("+14155550100", a.id);
    assert.equal(
      new ToolRegistry(join(dir, "tools.json")).get(t.id).name,
      "transfer",
    );
    assert.deepEqual(
      new AgentStore(agent(), join(dir, "agents.json")).agentForNumber(
        "+14155550100",
      )?.toolIds,
      [t.id],
    );
    assert.throws(() => tools.save(transfer()), /unique/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("phrase routing uses word boundaries and is excluded from model tools", () => {
  const t = { ...transfer("phrase"), id: "tool" };
  assert.equal(
    phraseTransfer([t], "Please reach the SALES team!")?.destinationId,
    "sales",
  );
  assert.equal(phraseTransfer([t], "wholesales teamwork"), undefined);
  assert.equal(modelTools([t]).length, 0);
  assert.equal(modelTools([{ ...transfer(), id: "other" }]).length, 1);
});
test("transfer waits for announcement playback before invoking Twilio", async () => {
  const events: string[] = [];
  const tel = telephony();
  tel.transferCall = async () => {
    events.push("dial");
  };
  const ex = new ToolExecutor(tel);
  const result = await ex.execute(
    { ...transfer(), id: "t" },
    { id: "c", name: "transfer", arguments: '{"destinationId":"sales"}' },
    {
      callSid: "CA-test",
      signal: new AbortController().signal,
      speak: async () => {
        events.push("spoken");
      },
      playAudio: async () => {},
    },
  );
  assert.deepEqual(events, ["spoken", "dial"]);
  assert.equal(result.terminal, true);
  await assert.rejects(
    () =>
      ex.execute(
        { ...transfer(), id: "t" },
        {
          id: "c",
          name: "transfer",
          arguments: '{"destinationId":"untrusted"}',
        },
        {
          callSid: "CA-test",
          signal: new AbortController().signal,
          speak: async () => {},
          playAudio: async () => {},
        },
      ),
    /Unknown/,
  );
});
test("DTMF encodes both frequencies and pause duration in 8 kHz mu-law", () => {
  const audio = dtmfAudio("1w2", 200, 100);
  assert.equal(audio.length, 8800);
  assert.equal(
    audio.subarray(2400, 6400).every((v) => v === 255),
    true,
  );
  const power = (frequency: number) => {
    let re = 0,
      im = 0;
    for (let i = 40; i < 1560; i++) {
      const s = decodeMulaw(audio[i]);
      re += s * Math.cos((2 * Math.PI * frequency * i) / 8000);
      im += s * Math.sin((2 * Math.PI * frequency * i) / 8000);
    }
    return re * re + im * im;
  };
  assert.ok(power(697) > power(770) * 20);
  assert.ok(power(1209) > power(1336) * 20);
  assert.throws(() => dtmfAudio("bad", 200, 100));
});
test("backchannels don't interrupt, explicit interruption phrases do", () => {
  const plan = agent().stopSpeakingPlan;
  assert.equal(shouldInterrupt("yeah", plan), false);
  assert.equal(shouldInterrupt("hold on", plan), true);
  assert.equal(shouldInterrupt("I need help", plan), true);
});
test("custom functions validate arguments and correlate correlated webhook results", async () => {
  env.FUNCTION_ALLOWED_HOSTS = "functions.example.com";
  let requests = 0;
  const t = {
    ...toolSchema.parse({
      type: "function",
      name: "lookup",
      description: "Look up order",
      parameters: {
        type: "object",
        properties: { order: { type: "string" } },
        required: ["order"],
        additionalProperties: false,
      },
      server: { url: "https://functions.example.com/tool" },
    }),
    id: "tool",
  };
  const ex = new ToolExecutor(telephony(), async (_url, options) => {
    requests++;
    const b = JSON.parse(options?.body as string);
    assert.equal(b.message.toolCallList[0].function.arguments.order, "123");
    assert.equal(b.message.call.id, "CA-test");
    return new Response(
      JSON.stringify({
        results: [{ toolCallId: "call1", result: { status: "shipped" } }],
      }),
    );
  });
  const ctx = {
    callSid: "CA-test",
    signal: new AbortController().signal,
    speak: async () => {},
    playAudio: async () => {},
  };
  await assert.rejects(
    () =>
      ex.execute(
        t,
        { id: "call1", name: "lookup", arguments: '{"order":5}' },
        ctx,
      ),
    /Invalid function arguments/,
  );
  assert.equal(requests, 0);
  const r = await ex.execute(
    t,
    { id: "call1", name: "lookup", arguments: '{"order":"123"}' },
    ctx,
  );
  assert.deepEqual(r.result, { status: "shipped" });
  assert.equal(requests, 1);
  env.FUNCTION_ALLOWED_HOSTS = "";
  await assert.rejects(
    () =>
      ex.execute(
        t,
        { id: "call1", name: "lookup", arguments: '{"order":"123"}' },
        ctx,
      ),
    /FUNCTION_ALLOWED_HOSTS/,
  );
});

test("DTMF tool API round-trips navigation and timing without changing legacy tools", async () => {
  const { toolBodySchema } = await import("../server/api/v1/schemas/tool");
  const { toToolInput, toApiToolBody } =
    await import("../server/api/v1/mappers/tool");
  const body = toolBodySchema.parse({
    type: "dtmf",
    function: { name: "keypad" },
    navigation: { ivrWaitSeconds: 45 },
    toneDurationMs: 300,
    gapMs: 150,
  });
  const result = toApiToolBody({ ...toToolInput(body), id: "keypad" });
  assert.equal(result.type, "dtmf");
  if (result.type !== "dtmf") throw new Error("Wrong tool type");
  assert.deepEqual(result.navigation, { ivrWaitSeconds: 45 });
  assert.equal(result.toneDurationMs, 300);
  assert.equal(result.gapMs, 150);
  assert.equal(
    toolSchema.parse({ type: "dtmf", name: "keypad", description: "Menu" })
      .type,
    "dtmf",
  );
  assert.equal(
    toolBodySchema.safeParse({ ...body, navigation: { ivrWaitSeconds: 0 } })
      .success,
    false,
  );
});

test("provider forwards explicit keypad selection to the model API", async (t) => {
  const { createOpenAiModel } = await import("../server/providers/openai");
  const prior = env.OPENAI_API_KEY;
  env.OPENAI_API_KEY = "test-key";
  t.after(() => {
    env.OPENAI_API_KEY = prior;
  });
  let request: any;
  const model = createOpenAiModel(
    () =>
      ({
        chat: {
          completions: {
            create: async (input: any) => {
              request = input;
              return (async function* () {
                yield {
                  choices: [],
                  usage: {
                    prompt_tokens: 1,
                    completion_tokens: 1,
                    total_tokens: 2,
                  },
                };
              })();
            },
          },
        },
      }) as any,
  );
  for await (const _ of model.stream(
    {
      messages: [],
      model: "gpt-4o",
      temperature: 0,
      tools: [
        {
          name: "dial_keypad",
          description: "Menu",
          parameters: { type: "object" },
        },
      ],
      toolChoice: "dial_keypad",
    },
    new AbortController().signal,
  )) {
  }
  assert.deepEqual(request.tool_choice, {
    type: "function",
    function: { name: "dial_keypad" },
  });
  assert.equal(request.parallel_tool_calls, false);
});

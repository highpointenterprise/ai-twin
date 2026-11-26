import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import twilio from "twilio";
import { env } from "../lib/env";
import { toolSchema } from "../lib/config";
import { verifyStreamToken } from "../lib/token";
import { CallHandling } from "../server/calls/detection";
import type { ToolContext } from "../server/core/ports";
import { DtmfService } from "../server/dtmf/service";
import { TraceStore } from "../server/observability/trace";
import { createTwilioTelephony } from "../server/providers/twilio";
import { ContextStore } from "../server/store/contexts";
import { ToolExecutor } from "../server/tools/executor";
import { agent, harness, telephony, tick, until } from "./helpers";

function fixture(t: TestContext, send: NonNullable<ReturnType<typeof telephony>["sendDigits"]> = async () => {}, timeout = 90_000) {
  env.STREAM_SECRET = "test-only-dtmf-reconnect-signing-secret";
  const traces = new TraceStore(), contexts = new ContextStore(), phone = telephony();
  phone.sendDigits = send;
  const ended: string[] = [], released: string[] = [];
  let held = false;
  const service = new DtmfService({
    telephony: phone, contexts, traces, publicBaseUrl: "https://calls.example/workspaces/owner",
    endCall: async (_sid, reason) => { ended.push(reason); },
    releaseLease: async id => { released.push(id); }, reconnectTimeoutMs: timeout,
  });
  t.after(() => service.shutdown());
  const a = agent({ callHandling: { menuSilenceMs: 200, maxRepeatedMenuSelections: 1 } });
  const handling = new CallHandling(a, traces.for("CA-test"), true, true, 0);
  handling.observe("Press two for sales", true, 0);
  assert.equal(handling.beginDtmf(200), undefined);
  const context: ToolContext = {
    callSid: "CA-test", signal: new AbortController().signal,
    handoff: value => { held = value; },
    snapshot: {
      agent: a, tools: [], brief: "Find sales", direction: "outbound", deadline: Date.now() + 120_000,
      mediaContextId: "old-context", handling: handling.checkpoint(),
      history: [{ role: "assistant", content: "", toolCalls: [{ id: "op-1", name: "keypad", arguments: '{"keys":"2"}' }] }],
    },
    speak: async () => { throw new Error("Must stay silent"); },
    playAudio: async () => { throw new Error("Must not silently fall back to audio"); },
  };
  return { service, contexts, traces, context, ended, released, held: () => held, phone };
}

test("Twilio native delivery uses the active call, Play digits, and a signed replacement stream", async () => {
  const updates: { sid: string; twiml: string }[] = [];
  const phone = createTwilioTelephony(
    () => ({ accountSid: "AC-owner", authToken: "private" }),
    credentials => {
      assert.equal(credentials.accountSid, "AC-owner");
      return { calls: (sid: string) => ({ update: async ({ twiml }: { twiml: string }) => { updates.push({ sid, twiml }); } }) } as unknown as twilio.Twilio;
    },
  );
  await phone.sendDigits!("CA-active", "12w3W#*ABCD", "wss://calls.example/media", { agentId: "agent", callId: "context", token: "signed" }, "https://calls.example/twilio/stream-status");
  assert.equal(updates.length, 1);
  assert.equal(updates[0].sid, "CA-active");
  assert.match(updates[0].twiml, /<Play digits="w12w3W#\*ABCD"\/>/);
  assert.match(updates[0].twiml, /<Connect><Stream url="wss:\/\/calls.example\/media"/);
  assert.match(updates[0].twiml, /<Parameter name="token" value="signed"\/>/);
  for (const keys of ["wW", "", "1<Hangup/>", "1".repeat(33)])
    await assert.rejects(phone.sendDigits!("CA-active", keys, "", {}, ""), /Invalid DTMF/);
  assert.equal(updates.length, 1);
});

test("native DTMF persists bound resume state before sending and suppresses duplicate commands", async t => {
  let unblock!: () => void;
  const gate = new Promise<void>(resolve => { unblock = resolve; });
  let sends = 0, contextId = "";
  const f = fixture(t, async (sid, keys, url, params) => {
    sends++;
    assert.equal(keys, "1234#");
    assert.equal(url, "wss://calls.example/workspaces/owner/media");
    assert.ok(verifyStreamToken(params.agentId, params.callId, params.token));
    contextId = params.callId;
    const snapshot = await f.contexts.getAsync(contextId);
    assert.equal(snapshot?.sid, sid);
    assert.equal(snapshot?.history?.at(-1)?.toolCallId, "op-1");
    assert.equal(snapshot?.dtmfResume?.handling.selections, 1);
    assert.ok(f.held());
    await gate;
  });
  const first = f.service.send("op-1", "1234#", f.context);
  const duplicate = f.service.send("op-1", "1234#", f.context);
  assert.equal(first, duplicate);
  await until(() => sends === 1);
  await assert.rejects(f.service.send("op-2", "2", f.context), /already in progress/);
  assert.equal(await f.contexts.takeAsync(contextId, "CA-another-user"), undefined);
  unblock();
  assert.equal((await first).terminal, true);
  const snapshot = await f.contexts.takeAsync(contextId, "CA-test");
  assert.ok(snapshot?.dtmfResume);
  f.service.resumed(snapshot.dtmfResume, "CA-test");
  assert.equal(await f.contexts.takeAsync(contextId, "CA-test"), undefined);
  const events = f.traces.for("CA-test").view().events;
  assert.ok(events.some(e => e.event === "dtmf.provider_accepted"));
  assert.ok(events.some(e => e.event === "dtmf.stream_resumed"));
  assert.ok(!JSON.stringify(events).includes("1234#"));
  assert.equal(sends, 1);
});

test("ambiguous provider failure is never retried or played as audio and reconnect can still succeed", async t => {
  let contextId = "", sends = 0;
  const f = fixture(t, async (_sid, _keys, _url, params) => {
    sends++; contextId = params.callId;
    throw Object.assign(new Error("timeout with secret data"), { status: 504, code: 999 });
  });
  const result = await f.service.send("op-1", "2", f.context);
  assert.equal(result.terminal, true);
  assert.equal((result.result as { status: string }).status, "delivery-uncertain");
  await f.service.send("op-1", "2", f.context);
  assert.equal(sends, 1);
  const snapshot = await f.contexts.takeAsync(contextId, "CA-test");
  f.service.resumed(snapshot!.dtmfResume!, "CA-test");
  assert.ok(!JSON.stringify(f.traces.for("CA-test").view()).includes("secret data"));
  assert.deepEqual(f.ended, []);
});

test("a rejected command releases the handoff and removes the unused context", async t => {
  const f = fixture(t, async () => { throw Object.assign(new Error("invalid"), { status: 400, code: 21220 }); });
  const result = await f.service.send("op-1", "2", f.context);
  assert.equal(result.waitForUser, true);
  assert.equal(result.terminal, undefined);
  assert.equal(f.held(), false);
  assert.equal(await f.contexts.idForSidAsync("CA-test"), undefined);
});

test("missing reconnect ends the call once, removes pending context and releases the old lease", async t => {
  const f = fixture(t, async () => {}, 30);
  await f.service.send("op-1", "2", f.context);
  await until(() => f.ended.length === 1);
  assert.deepEqual(f.ended, ["dtmf-reconnect-timeout"]);
  assert.deepEqual(f.released, ["old-context"]);
  assert.equal(await f.contexts.idForSidAsync("CA-test"), undefined);
});

test("cancellation or failed context persistence cannot issue a provider command", async t => {
  let sends = 0;
  const f = fixture(t, async () => { sends++; });
  f.contexts.setAsync = async () => { throw new Error("Redis unavailable"); };
  await assert.rejects(f.service.send("op-1", "2", f.context), /Redis unavailable/);
  await assert.rejects(f.service.send("op-1", "2", { ...f.context, signal: AbortSignal.abort() }));
  assert.equal(sends, 0);
  assert.equal(f.held(), false);
});

test("resumed sessions preserve history, deadlines and menu limits without repeating their opening", async t => {
  const f = fixture(t);
  await f.service.send("op-1", "2", f.context);
  const id = await f.contexts.idForSidAsync("CA-test");
  const saved = await f.contexts.takeAsync(id!, "CA-test");
  f.service.resumed(saved!.dtmfResume!, "CA-test");
  let requests = 0, sends = 0;
  const a = saved!.agent;
  const h = harness({
    ...saved!, callSid: "CA-test", streamSid: "MZ-new", mediaContextId: id,
    agent: { ...a, firstMessageMode: "assistant-speaks-first", firstMessage: "Do not repeat this" },
    tools: [{ ...toolSchema.parse({ type: "dtmf", name: "keypad", description: "Sales" }), id: "keypad" }],
  }, {
    model: { complete: async () => "", async *stream(request) {
      requests++;
      assert.ok(request.messages.some(m => m.role === "tool" && m.toolCallId === "op-1"));
      yield { type: "tool-call", call: { id: "op-2", name: "keypad", arguments: '{"keys":"2"}' } };
    } },
    executeTool: async () => { sends++; return { result: {} }; },
  });
  t.after(() => h.session.close());
  await tick();
  assert.deepEqual(h.spoken, []);
  h.events.onEnd("Press two for sales");
  await until(() => h.ended.length > 0);
  assert.equal(requests, 1);
  assert.equal(sends, 0);
  assert.deepEqual(h.ended, ["ivr-navigation-limit"]);
});

test("DTMF defaults to provider delivery and requires an explicit audio compatibility choice", async () => {
  const ex = new ToolExecutor(telephony());
  const tool = { ...toolSchema.parse({ type: "dtmf", name: "keypad", description: "Sales" }), id: "tool" };
  if (tool.type !== "dtmf") throw new Error("Expected keypad tool");
  let audio = 0;
  const context = { callSid: "CA-test", signal: new AbortController().signal, speak: async () => {}, playAudio: async () => { audio++; } };
  const call = { id: "op", name: "keypad", arguments: '{"keys":"2"}' };
  await assert.rejects(ex.execute(tool, call, context), /unavailable/);
  assert.equal(audio, 0);
  const result = await ex.execute({ ...tool, transport: "audio" }, call, context);
  assert.equal(result.waitForUser, true);
  assert.equal(audio, 1);
});

test("a live session finishes one native operation across speech events and expected socket closure", async t => {
  let sends = 0, finish!: () => void;
  const provider = new Promise<void>(resolve => { finish = resolve; });
  const f = fixture(t, async () => { sends++; await provider; });
  const executor = new ToolExecutor(f.phone, fetch, undefined, f.service);
  const tool = { ...toolSchema.parse({ type: "dtmf", name: "keypad", description: "Sales" }), id: "tool" };
  let held = false;
  const h = harness({
    agent: f.context.snapshot!.agent, direction: "outbound", mediaContextId: "old-context", tools: [tool],
    trace: f.traces.for("CA-test"), holdMediaLease: value => { held = value; },
  }, {
    model: { complete: async () => "", async *stream() {
      yield { type: "tool-call", call: { id: "op-1", name: "keypad", arguments: '{"keys":"2"}' } };
    } },
    executeTool: (tool, call, context) => executor.execute(tool, call, context),
  });
  t.after(() => { finish(); h.session.close(); });
  await tick();
  h.events.onEnd("Press two for sales");
  await until(() => sends === 1);
  assert.ok(held);
  h.events.onSpeechStart();
  h.events.onPartial("Hello, how can I help?");
  h.events.onEnd("Hello, how can I help?");
  h.events.onResume();
  const id = await f.contexts.idForSidAsync("CA-test");
  assert.ok(id);
  h.session.close();
  finish();
  await until(() => f.traces.for("CA-test").view().events.some(e => e.event === "dtmf.provider_accepted"));
  await tick();
  assert.equal(sends, 1);
  assert.deepEqual(h.spoken, []);
  assert.deepEqual(h.ended, []);
  assert.ok(!f.traces.for("CA-test").view().events.some(e => e.event === "llm.cancelled" || e.event === "tool.failed"));
  const saved = await f.contexts.takeAsync(id, "CA-test");
  assert.equal(saved?.history?.at(-1)?.toolCallId, "op-1");
  assert.equal(saved?.dtmfResume?.handling.selections, 1);
  f.service.resumed(saved!.dtmfResume!, "CA-test");
});

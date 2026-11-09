import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import twilio from "twilio";
import {
  createAdminApp,
  createPublicApp,
  type HttpDeps,
} from "../server/http/routes";
import { AgentStore } from "../server/store/agents";
import { ToolRegistry } from "../server/tools/registry";
import { CallRegistry } from "../server/store/calls";
import { ContextStore } from "../server/store/contexts";
import { TraceStore } from "../server/observability/trace";
import { SessionPool } from "../server/engine/pool";
import { env } from "../lib/env";
import { agent, telephony } from "./helpers";
import { signStreamToken } from "../lib/token";
const deps = (): HttpDeps => ({
  store: new AgentStore(agent()),
  tools: new ToolRegistry(),
  registry: new CallRegistry(),
  contexts: new ContextStore(),
  traces: new TraceStore(),
  pool: new SessionPool(10),
  telephony: telephony(),
  listVoices: async () => [],
  pendingCalls: 0,
});
async function listen(app: ReturnType<typeof createAdminApp>) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  return {
    server,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  };
}
test("configuration API works without provider credentials and refuses live calling", async (t) => {
  env.OPENAI_API_KEY = "";
  const d = deps(),
    { server, url } = await listen(createAdminApp(d));
  t.after(() => server.close());
  const health = (await (await fetch(url + "/api/health")).json()) as {
    callingReady: boolean;
  };
  assert.equal(health.callingReady, false);
  assert.equal((await fetch(url + "/api/agents")).status, 200);
  const response = await fetch(url + "/api/calls", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentId: d.store.list()[0].id, to: "+14155550123" }),
  });
  assert.equal(response.status, 503);
  const bad = await fetch(url + "/api/tools", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "function",
      name: "bad",
      description: "Bad",
      parameters: { type: "object" },
      server: { url: "http://localhost/internal" },
    }),
  });
  assert.equal(bad.status, 400);
});
test("Twilio callbacks reject invalid signatures and map voicemail without a human conversation", async (t) => {
  env.PUBLIC_BASE_URL = "https://calls.example.com";
  env.STREAM_SECRET = "test-only-signing-secret-never-for-production";
  env.TWILIO_AUTH_TOKEN = "test-only-webhook-token";
  const d = deps();
  d.telephony.validateWebhook = (url, params, sig) =>
    twilio.validateRequest(env.TWILIO_AUTH_TOKEN, sig, url, params);
  const a = agent({
    voicemailDetection: {
      enabled: true,
      action: "leave-message",
      message: "Call us back.",
    },
  });
  d.contexts.set("test-context", {
    agent: a,
    tools: [],
    brief: "",
    purpose: "conversation",
    direction: "outbound",
    sid: "CA-test",
  });
  const { server, url } = await listen(createPublicApp(d));
  t.after(() => server.close());
  assert.equal(
    (await fetch(url + "/twilio/status", { method: "POST" })).status,
    403,
  );
  const path = `/twilio/voice/outbound?agentId=${a.id}&callId=test-context&token=${signStreamToken(a.id, "test-context")}`;
  const body = {
    CallSid: "CA-test",
    From: "+14155550100",
    To: "+14155550123",
    AnsweredBy: "machine_end_beep",
  };
  const response = await fetch(url + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "x-twilio-signature": twilio.getExpectedTwilioSignature(
        env.TWILIO_AUTH_TOKEN,
        env.PUBLIC_BASE_URL + path,
        body,
      ),
    },
    body: new URLSearchParams(body),
  });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Stream/);
  assert.equal(d.contexts.get("test-context")?.purpose, "voicemail");
  assert.equal(d.registry.get("CA-test")?.answeredBy, "machine_end_beep");
});
test("tool deletion refuses attached tools and callback terminal states do not regress", async (t) => {
  const d = deps();
  const tool = d.tools.save({
    type: "dtmf",
    name: "keys",
    description: "Keys",
    toneDurationMs: 200,
    gapMs: 100,
  });
  const a = d.store.list()[0];
  d.store.update(a.id, { ...a, toolIds: [tool.id] });
  const { server, url } = await listen(createAdminApp(d));
  t.after(() => server.close());
  assert.equal(
    (await fetch(url + `/api/tools/${tool.id}`, { method: "DELETE" })).status,
    409,
  );
  d.registry.create({
    sid: "CA-test",
    agentId: a.id,
    from: "a",
    to: "b",
    direction: "outbound",
    status: "completed",
  });
  d.registry.update("CA-test", "ringing");
  assert.equal(d.registry.get("CA-test")?.status, "completed");
});

test("outbound admission snapshots settings and handles an early failed status callback", async (t) => {
  Object.assign(env, {
    TWILIO_ACCOUNT_SID: "AC00000000000000000000000000000000",
    TWILIO_AUTH_TOKEN: "test-only",
    OPENAI_API_KEY: "test-only",
    DEEPGRAM_API_KEY: "test-only",
    ELEVENLABS_API_KEY: "test-only",
    PUBLIC_BASE_URL: "https://calls.example.com",
    STREAM_SECRET: "test-only-signing-secret-at-least-32-chars",
    TWILIO_PHONE_NUMBER: "+14155550100",
  });
  const d = deps();
  const a = d.store.list()[0];
  const publicHttp = await listen(createPublicApp(d));
  const adminHttp = await listen(createAdminApp(d));
  t.after(() => {
    publicHttp.server.close();
    adminHttp.server.close();
  });
  let placed = 0;
  d.telephony.placeCall = async (request) => {
    placed++;
    assert.equal(request.voicemail.enabled, false);
    assert.equal(request.to, "+14155550123");
    const callId = new URL(request.url).searchParams.get("callId")!;
    const snapshot = d.contexts.get(callId)!;
    assert.equal(
      snapshot.brief,
      "Call objective and context:\nAppointment reminder",
    );
    d.store.update(a.id, { ...a, name: "Changed after call began" });
    assert.equal(snapshot.agent.name, "Test agent");
    const callback = new URL(request.statusUrl);
    const response = await fetch(
      publicHttp.url + callback.pathname + callback.search,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          CallSid: "CA-early",
          CallStatus: "failed",
        }),
      },
    );
    assert.equal(response.status, 204);
    return "CA-early";
  };
  const response = await fetch(adminHttp.url + "/api/calls", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      agentId: a.id,
      to: "+14155550123",
      context: "Appointment reminder",
    }),
  });
  assert.equal(response.status, 201);
  assert.equal(
    ((await response.json()) as { status: string }).status,
    "failed",
  );
  assert.equal(placed, 1);
  assert.equal(d.pendingCalls, 0);
  assert.equal(d.registry.activeCount, 0);
});

test("inbound routing resolves assigned assistant and reuses context for callback retries", async (t) => {
  const d = deps(),
    a = d.store.list()[0];
  d.store.assign("+14155550100", a.id);
  const { server, url } = await listen(createPublicApp(d));
  t.after(() => server.close());
  const request = () =>
    fetch(url + "/twilio/voice/inbound", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        CallSid: "CA-inbound",
        From: "+14155550123",
        To: "+14155550100",
      }),
    });
  const one = await request(),
    two = await request();
  assert.equal(one.status, 200);
  assert.equal(await one.text(), await two.text());
  assert.equal(d.registry.list().length, 1);
  assert.equal(d.registry.get("CA-inbound")?.direction, "inbound");
  assert.ok(d.contexts.idForSid("CA-inbound"));
});

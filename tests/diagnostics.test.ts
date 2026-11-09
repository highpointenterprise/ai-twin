import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  readdirSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { env } from "../lib/env";
import {
  DiagnosticLog,
  diagnosticEvents,
} from "../server/observability/diagnostics";
import {
  createAdminApp,
  createPublicApp,
  type HttpDeps,
} from "../server/http/routes";
import { AgentStore } from "../server/store/agents";
import { CallRegistry } from "../server/store/calls";
import { ContextStore } from "../server/store/contexts";
import { SessionPool } from "../server/engine/pool";
import { TraceStore } from "../server/observability/trace";
import { ToolRegistry } from "../server/tools/registry";
import { agent, telephony } from "./helpers";

test("diagnostic logs redact secrets, rotate, persist through restart and filter calls", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "call-diagnostics-")),
    path = join(dir, "voice.jsonl");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const old = env.ELEVENLABS_API_KEY;
  env.ELEVENLABS_API_KEY = "private-test-provider-key";
  t.after(() => {
    env.ELEVENLABS_API_KEY = old;
  });
  const log = new DiagnosticLog(path, 800);
  for (let i = 0; i < 15; i++)
    log.append({
      at: i,
      scope: i % 2 ? "CA-one" : "CA-two",
      event: "tts.failed",
      detail: {
        token: "secret-stream-token",
        audioPayload: "SECRETBASE64",
        message:
          "private-test-provider-key https://calls.example/path?token=secret-query Bearer secret-authorization",
        index: i,
      },
    });
  const files = readdirSync(dir);
  assert.ok(files.length <= 3);
  assert.ok(files.includes("voice.jsonl.1"));
  for (const file of files) {
    const content = readFileSync(join(dir, file), "utf8");
    for (const secret of [
      "private-test-provider-key",
      "secret-stream-token",
      "SECRETBASE64",
      "secret-query",
      "secret-authorization",
    ])
      assert.ok(!content.includes(secret), secret);
    assert.equal(statSync(join(dir, file)).mode & 0o777, 0o600);
  }
  const restored = new DiagnosticLog(path, 800);
  assert.equal(restored.list().at(-1)?.detail.index, 14);
  assert.ok(restored.list("CA-one").every((e) => e.scope === "CA-one"));
});

test("inbound rejection, signature failure and Twilio stream errors remain visible in diagnostics", async (t) => {
  const old = { ...env };
  Object.assign(env, {
    PUBLIC_BASE_URL: "https://current.ngrok.app",
    TWILIO_ACCOUNT_SID: "AC" + "0".repeat(32),
    TWILIO_AUTH_TOKEN: "test",
    DEEPGRAM_API_KEY: "test",
    OPENAI_API_KEY: "test",
    ELEVENLABS_API_KEY: "test",
    ELEVENLABS_VOICE_ID: "",
    STREAM_SECRET: "test-signing-secret-with-at-least-32-characters",
  });
  t.after(() => Object.assign(env, old));
  const d: HttpDeps = {
    store: new AgentStore(agent()),
    registry: new CallRegistry(),
    contexts: new ContextStore(),
    tools: new ToolRegistry(),
    traces: new TraceStore(),
    pool: new SessionPool(2),
    telephony: telephony(),
    pendingCalls: 0,
    listVoices: async () => [],
  };
  const pub = createPublicApp(d).listen(0, "127.0.0.1"),
    admin = createAdminApp(d).listen(0, "127.0.0.1");
  await Promise.all(
    [pub, admin].map((s) => new Promise<void>((r) => s.once("listening", r))),
  );
  t.after(() => {
    pub.close();
    admin.close();
  });
  const base = `http://127.0.0.1:${(pub.address() as AddressInfo).port}`,
    adminUrl = `http://127.0.0.1:${(admin.address() as AddressInfo).port}`;
  const post = (path: string, body: Record<string, string>) =>
    fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body),
    });
  await post("/twilio/voice/inbound", {
    CallSid: "CA-unassigned",
    To: "+14155550100",
  });
  assert.equal(
    d.registry.get("CA-unassigned")?.endedReason,
    "no-agent-assigned",
  );
  assert.equal(d.registry.get("CA-unassigned")?.status, "failed");
  const a = d.store.list()[0];
  d.store.assign("+14155550100", a.id);
  d.store.update(a.id, { ...a, voiceId: "" });
  await post("/twilio/voice/inbound", {
    CallSid: "CA-missing-voice",
    To: "+14155550100",
  });
  assert.equal(
    d.registry.get("CA-missing-voice")?.endedReason,
    "voice-id-missing",
  );
  d.telephony.validateWebhook = () => false;
  assert.equal(
    (
      await post("/twilio/voice/inbound", {
        CallSid: "CA-bad-signature",
        To: "+14155550100",
      })
    ).status,
    403,
  );
  assert.ok(
    diagnosticEvents("CA-bad-signature").some(
      (e) => e.event === "twilio.webhook_rejected",
    ),
  );
  d.telephony.validateWebhook = () => true;
  await post("/twilio/stream-status", {
    CallSid: "CA-stream-error",
    StreamEvent: "stream-error",
    StreamError: "31920: WebSocket handshake failed",
  });
  const snapshot = (await fetch(
    adminUrl + "/api/diagnostics?callSid=CA-stream-error",
  ).then((r) => r.json())) as {
    events: { scope: string; event: string; detail: { message: string } }[];
  };
  assert.ok(snapshot.events.every((e) => e.scope === "CA-stream-error"));
  assert.ok(
    snapshot.events.some(
      (e) =>
        e.event === "twilio.stream_status" &&
        e.detail.message.includes("31920"),
    ),
  );
  assert.equal((await fetch(base + "/api/diagnostics")).status, 404);
});

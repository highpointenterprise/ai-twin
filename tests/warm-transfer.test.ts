import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import twilio from "twilio";
import WebSocket from "ws";
import { toolSchema } from "../lib/config";
import { env } from "../lib/env";
import type {
  ConversationSnapshot,
  TranscriberEvents,
  ConversationSession,
  EngineDeps,
} from "../server/core/ports";
import { WarmTransferCoordinator } from "../server/transfers/coordinator";
import { createConsultationSession } from "../server/transfers/consultation";
import { conferenceTwiml, holdTwiml, holdWav } from "../server/transfers/twiml";
import type {
  TransferTool,
  WarmTransferTelephony,
} from "../server/transfers/types";
import { CallRegistry } from "../server/store/calls";
import { ContextStore } from "../server/store/contexts";
import { TraceStore } from "../server/observability/trace";
import { ToolExecutor } from "../server/tools/executor";
import { createPublicApp } from "../server/http/routes";
import { attachMediaServer } from "../server/http/media";
import { AgentStore } from "../server/store/agents";
import { ToolRegistry } from "../server/tools/registry";
import { SessionPool } from "../server/engine/pool";
import { signStreamToken } from "../lib/token";
import { agent, telephony, tick, until, harness } from "./helpers";
function setup(t: TestContext, persist = false) {
  env.PUBLIC_BASE_URL = "https://calls.example.com";
  env.STREAM_SECRET = "test-only-warm-transfer-signing-secret";
  let now = Date.now();
  const dir = persist
    ? mkdtempSync(join(tmpdir(), "warm-transfer-"))
    : undefined;
  const a = agent(),
    registry = new CallRegistry(dir ? join(dir, "calls.json") : undefined),
    contexts = new ContextStore(),
    traces = new TraceStore();
  registry.create({
    sid: "CA-caller",
    agentId: a.id,
    direction: "inbound",
    from: "+14155550101",
    to: "+14155550100",
    status: "in-progress",
  });
  const snapshot: ConversationSnapshot = {
    agent: a,
    tools: [],
    brief: "Help with order 123",
    direction: "inbound",
    deadline: now + 600000,
    history: [
      { role: "user", content: "My order 123 arrived damaged." },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "transfer-call",
            name: "transfer",
            arguments: '{"destinationId":"support"}',
          },
        ],
      },
    ],
  };
  const tool = {
    ...toolSchema.parse({
      type: "transferCall",
      name: "transfer",
      description: "Support",
      transferMode: "warm",
      destinations: [
        {
          id: "support",
          number: "+14155550123",
          description: "Order support",
          message: "Please hold.",
        },
      ],
    }),
    id: "tool",
  } as TransferTool;
  const operations: string[] = [];
  const callStates = new Map([["CA-caller", "in-progress"]]);
  let members = ["CA-caller"];
  let autoJoin = true;
  const tel: WarmTransferTelephony = {
    redirectCall: async (sid, url) => {
      operations.push(`redirect:${sid}:${url.split("/").at(-1)}`);
      if (url.endsWith("/bridge") && autoJoin)
        members = ["CA-caller", "CA-operator"];
    },
    dialOperator: async () => {
      operations.push("dial");
      callStates.set("CA-operator", "in-progress");
      return "CA-operator";
    },
    endCall: async (sid) => {
      operations.push(`end:${sid}`);
      callStates.set(sid, "completed");
    },
    callStatus: async (sid) => callStates.get(sid) ?? "completed",
    conferenceMembers: async () => ({ sid: "CF-warm", callSids: [...members] }),
  };
  const deps = {
    telephony: tel,
    contexts,
    registry,
    traces,
    path: dir ? join(dir, "warm.json") : undefined,
    now: () => now,
  };
  const service = new WarmTransferCoordinator(deps);
  t.after(() => {
    service.shutdown();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
  const start = () =>
    service.start("CA-caller", tool, tool.destinations[0], snapshot);
  const dialed = async (id: string) => {
    await until(() => service.get(id).operatorSid === "CA-operator");
  };
  const answered = (id: string) =>
    service.operatorAnswered(id, "CA-operator", "+14155550123");
  return {
    service,
    tool,
    snapshot,
    operations,
    tel,
    contexts,
    registry,
    traces,
    deps,
    start,
    dialed,
    answered,
    advance: (ms: number) => {
      now += ms;
    },
    setMembers: (v: string[]) => {
      members = v;
    },
    setAutoJoin: (v: boolean) => {
      autoJoin = v;
    },
    callStates,
    dir,
  };
}

test("existing transfer definitions default to blind; warm settings validate limits", () => {
  const old = toolSchema.parse({
    type: "transferCall",
    name: "transfer",
    description: "Route",
    destinations: [
      { id: "support", number: "+14155550123", description: "Support" },
    ],
  });
  assert.equal(old.type === "transferCall" && old.transferMode, "blind");
  assert.equal(
    toolSchema.safeParse({
      ...old,
      transferMode: "warm",
      warmTransfer: { maxDurationSeconds: 0 },
    }).success,
    false,
  );
});
test("warm transfer holds caller, consults privately, and confirms both conference participants", async (t) => {
  const f = setup(t),
    id = f.start();
  await f.dialed(id);
  assert.deepEqual(f.operations.slice(0, 2), [
    "redirect:CA-caller:hold",
    "dial",
  ]);
  const contextId = f.answered(id)!;
  assert.equal(f.contexts.get(contextId)?.purpose, "warm-consultation");
  assert.equal(f.contexts.get(contextId)?.sid, "CA-operator");
  assert.equal(f.service.get(id).phase, "consulting");
  await f.service.accept(id, "CA-operator");
  assert.equal(f.service.get(id).phase, "connected");
  assert.ok(f.operations.includes("redirect:CA-operator:bridge"));
  assert.equal(f.registry.get("CA-caller")?.transferStatus, "warm-connected");
  await f.service.accept(id, "CA-operator");
  assert.equal(f.operations.filter((v) => v.endsWith(":bridge")).length, 1);
  assert.throws(() => f.start(), /already active/);
});
test("bridge redirect alone is not success; polling recovers a lost join callback", async (t) => {
  const f = setup(t);
  f.setAutoJoin(false);
  const id = f.start();
  await f.dialed(id);
  f.answered(id);
  await f.service.accept(id, "CA-operator");
  assert.equal(f.service.get(id).phase, "connecting");
  f.setMembers(["CA-caller", "CA-operator"]);
  await f.service.checkDeadline(id);
  assert.equal(f.service.get(id).phase, "connected");
});
test("blind mode still uses the original direct transfer path", async (t) => {
  const f = setup(t);
  let count = 0;
  const tel = telephony();
  tel.transferCall = async () => {
    count++;
  };
  const executor = new ToolExecutor(tel, fetch, f.service);
  const result = await executor.execute(
    { ...f.tool, transferMode: "blind" },
    { id: "c", name: "transfer", arguments: '{"destinationId":"support"}' },
    {
      callSid: "CA-caller",
      signal: new AbortController().signal,
      speak: async () => {},
      playAudio: async () => {},
      snapshot: f.snapshot,
    },
  );
  assert.equal(count, 1);
  assert.equal(result.terminal, true);
  assert.equal(f.service.forCaller("CA-caller"), undefined);
});
test("rejection restores full caller context and waits for resumed media confirmation", async (t) => {
  const f = setup(t),
    id = f.start();
  await f.dialed(id);
  f.answered(id);
  await f.service.rollback(id, "declined");
  const r = f.service.get(id);
  assert.equal(r.phase, "returning");
  assert.equal(f.operations.filter((v) => v === "dial").length, 1);
  const resumed = f.contexts.get(r.resumeContextId!)!;
  assert.equal(resumed.agent.firstMessage, f.tool.warmTransfer.fallbackMessage);
  assert.match(resumed.history![0].content, /order 123/);
  assert.equal(resumed.history!.at(-1)?.role, "tool");
  assert.match(resumed.history!.at(-1)!.content, /declined/);
  assert.equal(resumed.deadline, f.snapshot.deadline);
  f.service.resumed(id, "CA-caller");
  assert.equal(r.phase, "returned");
  await f.service.rollback(id, "duplicate");
  assert.equal(r.phase, "returned");
  assert.equal(f.operations.filter((v) => v.endsWith(":resume")).length, 1);
});
for (const reason of ["busy", "no-answer", "failed", "canceled", "completed"])
  test(`recipient ${reason} recovers caller without redialing`, async (t) => {
    const f = setup(t),
      id = f.start();
    await f.dialed(id);
    f.service.operatorStatus(id, "CA-operator", "+14155550123", reason);
    await until(() => !!f.service.get(id).resumeContextId);
    assert.equal(f.service.get(id).reason, `operator-${reason}`);
    assert.equal(f.operations.filter((v) => v === "dial").length, 1);
  });
for (const reason of ["voicemail", "ivr", "unavailable", "cannot-confirm"])
  test(`consultation cancellation for ${reason} returns the caller`, async (t) => {
    const f = setup(t),
      id = f.start();
    await f.dialed(id);
    f.answered(id);
    await f.service.rollback(id, reason);
    assert.equal(f.service.get(id).phase, "returning");
    assert.equal(f.service.get(id).reason, reason);
  });
test("consultation and bridge timeouts initiate recovery", async (t) => {
  const f = setup(t),
    id = f.start();
  await f.dialed(id);
  f.answered(id);
  f.advance(121000);
  await f.service.checkDeadline(id);
  assert.equal(f.service.get(id).reason, "consultation-timeout");
  const g = setup(t);
  g.setAutoJoin(false);
  const second = g.start();
  await g.dialed(second);
  g.answered(second);
  await g.service.accept(second, "CA-operator");
  g.advance(21000);
  await g.service.checkDeadline(second);
  assert.equal(g.service.get(second).reason, "bridge-timeout");
});
test("late recipient creation after caller hangs up is immediately cleaned up", async (t) => {
  const f = setup(t);
  let release!: (sid: string) => void;
  f.tel.dialOperator = async () =>
    new Promise<string>((r) => {
      release = r;
    });
  const id = f.start();
  await until(() => !!release);
  await f.service.callerEnded("CA-caller");
  release("CA-operator");
  await until(() => f.operations.includes("end:CA-operator"));
  assert.equal(f.service.get(id).phase, "cancelled");
  assert.equal(f.operations.filter((v) => v.endsWith(":resume")).length, 0);
});
test("early failed callback before create-call response cannot resurrect a failed transfer", async (t) => {
  const f = setup(t);
  let id = "";
  f.tel.dialOperator = async () => {
    f.service.operatorStatus(id, "CA-operator", "+14155550123", "busy");
    return "CA-operator";
  };
  id = f.start();
  await until(() => !!f.service.get(id).resumeContextId);
  assert.equal(f.service.get(id).phase, "returning");
  assert.equal(f.service.get(id).reason, "operator-busy");
});
test("duplicate or wrong-call callbacks cannot connect or redial a recipient", async (t) => {
  const f = setup(t),
    id = f.start();
  await f.dialed(id);
  const context = f.answered(id);
  assert.equal(f.answered(id), context);
  assert.throws(
    () => f.service.operatorAnswered(id, "CA-wrong", "+14155550123"),
    /Unexpected/,
  );
  await assert.rejects(() => f.service.accept(id, "CA-wrong"), /mismatch/);
  assert.equal(f.operations.filter((v) => v === "dial").length, 1);
});
test("failed rollback is visible, bounded to three attempts, and supports explicit retry", async (t) => {
  const f = setup(t),
    id = f.start();
  await f.dialed(id);
  f.answered(id);
  const redirect = f.tel.redirectCall;
  f.tel.redirectCall = async (sid, url) => {
    if (url.endsWith("/resume")) throw new Error("Provider unavailable");
    await redirect(sid, url);
  };
  await f.service.rollback(id, "declined");
  f.advance(3000);
  await f.service.checkDeadline(id);
  f.advance(5000);
  await f.service.checkDeadline(id);
  assert.equal(f.service.get(id).phase, "recovery-failed");
  assert.equal(f.service.get(id).recoveryAttempts, 3);
  assert.match(f.service.view("CA-caller")!.lastError!, /Provider unavailable/);
  f.tel.redirectCall = redirect;
  await f.service.retry(id);
  assert.equal(f.service.get(id).phase, "returning");
  f.service.resumed(id, "CA-caller");
  assert.equal(f.service.get(id).phase, "returned");
});
test("restart recovers a persisted consultation without dialing the recipient again", async (t) => {
  const f = setup(t, true),
    id = f.start();
  await f.dialed(id);
  f.answered(id);
  f.service.shutdown();
  const restarted = new WarmTransferCoordinator({
    ...f.deps,
    contexts: new ContextStore(),
    registry: new CallRegistry(join(f.dir!, "calls.json")),
  });
  t.after(() => restarted.shutdown());
  await restarted.recoverAfterRestart();
  assert.equal(restarted.get(id).phase, "returning");
  assert.equal(restarted.get(id).reason, "server-restarted");
  assert.equal(f.operations.filter((v) => v === "dial").length, 1);
});
test("connected native conference is preserved on agent restart", async (t) => {
  const f = setup(t, true),
    id = f.start();
  await f.dialed(id);
  f.answered(id);
  await f.service.accept(id, "CA-operator");
  f.service.shutdown();
  const count = f.operations.length;
  const restarted = new WarmTransferCoordinator({
    ...f.deps,
    contexts: new ContextStore(),
  });
  t.after(() => restarted.shutdown());
  await restarted.recoverAfterRestart();
  assert.equal(restarted.get(id).phase, "connected");
  assert.equal(f.operations.length, count);
});
test("Twilio hold and bridge XML keep consultation private and use a valid built-in WAV", async (t) => {
  const f = setup(t),
    id = f.start();
  await f.dialed(id);
  const r = f.service.get(id);
  const hold = conferenceTwiml(r, "caller"),
    bridge = conferenceTwiml(r, "operator");
  assert.match(hold, /startConferenceOnEnter="false"/);
  assert.match(bridge, /startConferenceOnEnter="true"/);
  assert.match(hold, /endConferenceOnExit="true"/);
  assert.match(hold, /statusCallbackEvent="start end join leave"/);
  assert.match(holdTwiml(r), /warm-hold.wav/);
  const wav = holdWav();
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.readUInt32LE(24), 8000);
  assert.equal(wav.readUInt32LE(40), wav.length - 44);
});

test("agentic recipient conversation answers a question and only bridges after quoted acceptance", async (t) => {
  const f = setup(t);
  f.tool.warmTransfer.firstMessage =
    "Hello, I have a caller with an order problem. Can you take the call?";
  const id = f.start();
  await f.dialed(id);
  const contextId = f.answered(id)!;
  let events!: TranscriberEvents, session!: ConversationSession;
  const spoken: string[] = [];
  const engine: EngineDeps = {
    transcribe: (e) => {
      events = e;
      return { sendAudio: () => {}, close: () => {} };
    },
    synthesize: (_voice, audio) => ({
      push: async (text) => {
        spoken.push(text);
        audio(Buffer.alloc(160, 255).toString("base64"));
      },
      end: async () => {},
      close: () => {},
    }),
    model: {
      async *stream(req) {
        if (
          req.messages[0]?.content.startsWith("Classify recipient acceptance")
        ) {
          yield { type: "text", text: '{"decision":"accept"}' };
          return;
        }
        const user = req.messages.findLast((m) => m.role === "user")?.content;
        if (user === "Yes, I can take this caller.")
          yield {
            type: "tool-call",
            call: {
              id: "accept",
              name: "transferSuccessful",
              arguments: JSON.stringify({ acceptanceQuote: user }),
            },
          };
        else
          yield {
            type: "text",
            text: "The caller says order 123 arrived damaged. Are you ready to take the call?",
          };
      },
      complete: async () => "",
    },
  };
  const context = f.contexts.get(contextId)!;
  session = createConsultationSession(
    {
      ...context,
      callSid: "CA-operator",
      streamSid: "MZ-operator",
      trace: f.traces.for("CA-operator"),
      send: (message) => {
        const m = message as { event: string; mark?: { name: string } };
        if (m.event === "mark")
          queueMicrotask(() => session.handleMark(m.mark!.name));
      },
    },
    engine,
    f.service,
  );
  t.after(() => session.close());
  await until(() => spoken.length === 1);
  await tick();
  events.onEnd("What is the customer calling about?");
  await until(() => spoken.length === 2);
  await tick();
  assert.equal(f.service.get(id).phase, "consulting");
  assert.match(spoken[1], /order 123/);
  events.onEnd("Yes, I can take this caller.");
  await until(() => f.service.get(id).phase === "connected");
  assert.equal(spoken.at(-1), f.tool.warmTransfer.connectMessage);
});

test("late provider callbacks after a failed create clean up the unexpected recipient leg", async (t) => {
  const f = setup(t);
  f.tel.dialOperator = async () => {
    throw new Error("Create response timed out");
  };
  const id = f.start();
  await until(() => !!f.service.get(id).resumeContextId);
  f.service.resumed(id, "CA-caller");
  f.callStates.set("CA-late", "ringing");
  f.service.operatorStatus(id, "CA-late", "+14155550123", "ringing");
  await until(() => f.operations.includes("end:CA-late"));
  assert.equal(f.service.get(id).phase, "returned");
});
test("callbacks from an older transfer cannot overwrite a newer attempt", async (t) => {
  const f = setup(t),
    old = f.start();
  await f.dialed(old);
  f.answered(old);
  await f.service.rollback(old, "declined");
  f.service.resumed(old, "CA-caller");
  f.tel.dialOperator = async () => "CA-new";
  const next = f.start();
  await until(() => f.service.get(next).operatorSid === "CA-new");
  f.service.operatorStatus(old, "CA-operator", "+14155550123", "completed");
  f.service.conferenceEvent(old, "participant-leave", "CA-caller", "CF-warm");
  assert.equal(f.registry.get("CA-caller")?.transferId, next);
  assert.equal(f.registry.get("CA-caller")?.transferStatus, "warm-dialing");
  assert.equal(f.registry.get("CA-caller")?.operatorCallSid, "CA-new");
});
test("unconfirmed recipient never bridges when acceptance verifier declines or returns invalid JSON", async () => {
  const { verifyRecipientAcceptance } =
    await import("../server/transfers/acceptance");
  for (const response of [
    '{"decision":"decline"}',
    '{"decision":"unclear"}',
    '{"decision":"automated"}',
    "not JSON",
  ]) {
    const model = {
      async *stream() {
        yield { type: "text" as const, text: response };
      },
      complete: async () => "",
    };
    assert.equal(
      await verifyRecipientAcceptance(
        model,
        agent(),
        [{ role: "user", content: "I cannot help right now" }],
        new AbortController().signal,
      ),
      false,
    );
  }
});

async function publicHarness(t: TestContext, f: ReturnType<typeof setup>) {
  env.TWILIO_AUTH_TOKEN = "test-only-warm-webhook-token";
  const phone = telephony();
  phone.validateWebhook = (url, params, signature) =>
    twilio.validateRequest(env.TWILIO_AUTH_TOKEN, signature, url, params);
  const pool = new SessionPool(10);
  const server = createServer(
    createPublicApp({
      store: new AgentStore(f.snapshot.agent),
      registry: f.registry,
      contexts: f.contexts,
      traces: f.traces,
      tools: new ToolRegistry(),
      pool,
      telephony: phone,
      listVoices: async () => [],
      pendingCalls: 0,
      warmTransfers: f.service,
    }),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (
    id: string,
    action: string,
    body: Record<string, string>,
    signed = true,
  ) => {
    const path = `/twilio/warm/${id}/${action}`;
    return fetch(origin + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        ...(signed
          ? {
              "x-twilio-signature": twilio.getExpectedTwilioSignature(
                env.TWILIO_AUTH_TOKEN,
                env.PUBLIC_BASE_URL + path,
                body,
              ),
            }
          : {}),
      },
      body: new URLSearchParams(body),
    });
  };
  return { server, pool, origin, post };
}

test("signed warm webhooks isolate call legs and recovery is confirmed by an authenticated media stream", async (t) => {
  const f = setup(t),
    id = f.start();
  await f.dialed(id);
  const http = await publicHarness(t, f);
  const caller = { CallSid: "CA-caller" },
    operator = { CallSid: "CA-operator", To: "+14155550123" };
  assert.equal((await http.post(id, "operator", operator, false)).status, 403);
  assert.equal(f.service.get(id).phase, "dialing");
  assert.equal(
    (await http.post(id, "hold", { CallSid: "CA-unrelated" })).status,
    403,
  );
  assert.equal(
    (await http.post(id, "operator", { ...operator, To: "+14155550999" }))
      .status,
    403,
  );
  assert.match(
    await (await http.post(id, "hold", caller)).text(),
    /startConferenceOnEnter="false"/,
  );
  assert.match(
    await (await http.post(id, "operator", operator)).text(),
    /Connect><Stream/,
  );
  const recipientContext = f.service.get(id).consultationContextId!;
  assert.equal(f.contexts.get(recipientContext)?.sid, "CA-operator");
  assert.equal(
    (
      await http.post(id, "operator-status", {
        ...operator,
        CallStatus: "busy",
      })
    ).status,
    204,
  );
  await until(() => !!f.service.get(id).resumeContextId);
  assert.equal(f.service.get(id).phase, "returning");
  const resumeId = f.service.get(id).resumeContextId!;
  assert.match(
    await (await http.post(id, "resume", caller)).text(),
    /Connect><Stream/,
  );
  let starts = 0;
  const wss = attachMediaServer(http.server, {
    contexts: f.contexts,
    pool: http.pool,
    registry: f.registry,
    traces: f.traces,
    onResumed: (transferId, sid) => f.service.resumed(transferId, sid),
    factory: (init) => {
      starts++;
      assert.equal(init.resumeTransferId, id);
      assert.match(init.history![0].content, /order 123/);
      return { pushAudio: () => {}, handleMark: () => {}, close: () => {} };
    },
  });
  t.after(() => {
    for (const ws of wss.clients) ws.terminate();
    wss.close();
  });
  const event = {
    event: "start",
    start: {
      callSid: "CA-caller",
      streamSid: "MZ-resumed",
      mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
      customParameters: {
        agentId: f.snapshot.agent.id,
        callId: resumeId,
        token: signStreamToken(f.snapshot.agent.id, resumeId),
      },
    },
  };
  const mediaUrl = http.origin.replace("http:", "ws:") + "/media";
  const wrong = new WebSocket(mediaUrl);
  await once(wrong, "open");
  wrong.send(
    JSON.stringify({
      ...event,
      start: { ...event.start, callSid: "CA-unrelated" },
    }),
  );
  assert.equal((await once(wrong, "close"))[0], 1008);
  assert.equal(f.service.get(id).phase, "returning");
  assert.equal(starts, 0);
  const ws = new WebSocket(mediaUrl);
  await once(ws, "open");
  ws.send(JSON.stringify(event));
  await until(() => starts === 1);
  assert.equal(f.service.get(id).phase, "returned");
  assert.equal(f.contexts.get(resumeId), undefined);
  ws.close();
  await once(ws, "close");
  const replay = new WebSocket(mediaUrl);
  await once(replay, "open");
  replay.send(JSON.stringify(event));
  assert.equal((await once(replay, "close"))[0], 1008);
  assert.equal(starts, 1);
});

test("delayed hold and Dial callbacks keep the caller alive while recovery is pending", async (t) => {
  const f = setup(t),
    id = f.start();
  await f.dialed(id);
  f.answered(id);
  const http = await publicHarness(t, f);
  let resolveStatus!: (status: string) => void;
  f.tel.callStatus = async () =>
    new Promise<string>((resolve) => {
      resolveStatus = resolve;
    });
  const pending = f.service.rollback(id, "declined");
  for (const action of ["hold", "resume", "caller-exit"]) {
    const response = await http.post(id, action, { CallSid: "CA-caller" });
    const xml = await response.text();
    assert.equal(response.status, 200);
    assert.match(xml, /Redirect/);
    assert.doesNotMatch(xml, /Hangup/);
  }
  assert.equal(f.service.get(id).recoveryAttempts, 1);
  resolveStatus("in-progress");
  await pending;
  assert.match(
    await (await http.post(id, "resume", { CallSid: "CA-caller" })).text(),
    /Connect><Stream/,
  );
});

test("ring timeout and missing caller membership recover without connecting the recipient", async (t) => {
  const f = setup(t),
    id = f.start();
  await f.dialed(id);
  f.advance(51000);
  await f.service.checkDeadline(id);
  assert.equal(f.service.get(id).reason, "ring-timeout");
  const g = setup(t),
    second = g.start();
  await g.dialed(second);
  g.answered(second);
  g.setMembers([]);
  await g.service.accept(second, "CA-operator");
  assert.equal(g.service.get(second).reason, "bridge-failed");
  assert.ok(!g.operations.includes("redirect:CA-operator:bridge"));
});

test("fallback-and-end waits for playback and cannot be interrupted into a new conversation", async (t) => {
  const h = harness({
    agent: agent({
      firstMessageMode: "assistant-speaks-first",
      firstMessage: "We could not connect. Goodbye.",
    }),
    endAfterFirstMessage: true,
  });
  t.after(() => h.session.close());
  h.setAutoMark(false);
  await until(() =>
    h.sent.some((m) => (m as { event: string }).event === "mark"),
  );
  h.session.handleDtmf("1");
  h.session.pushAudio(Buffer.alloc(160, 0).toString("base64"));
  assert.equal(h.ended.length, 0);
  const mark = h.sent.find(
    (m) => (m as { event: string }).event === "mark",
  ) as { mark: { name: string } };
  h.session.handleMark(mark.mark.name);
  await until(() => h.ended.length === 1);
  assert.equal(h.ended[0], "warm-transfer-fallback-ended");
  assert.equal(h.spoken.length, 1);
});

test("long-lived caller records stay controllable as newer finished calls accumulate", () => {
  const registry = new CallRegistry(),
    a = agent();
  registry.create({
    sid: "CA-active",
    agentId: a.id,
    from: "+14155550100",
    to: "+14155550123",
    direction: "inbound",
    status: "in-progress",
  });
  for (let i = 0; i < 220; i++)
    registry.create({
      sid: `CA-finished-${i}`,
      agentId: a.id,
      from: "+14155550100",
      to: "+14155550123",
      direction: "outbound",
      status: "completed",
    });
  assert.equal(registry.get("CA-active")?.status, "in-progress");
  assert.equal(registry.list().length, 200);
});

test("restart status-query failure cannot turn a connected human conference into a disconnecting retry", async (t) => {
  const f = setup(t, true),
    id = f.start();
  await f.dialed(id);
  f.answered(id);
  await f.service.accept(id, "CA-operator");
  f.service.shutdown();
  f.tel.callStatus = async () => {
    throw new Error("Temporary status outage");
  };
  const restarted = new WarmTransferCoordinator({
    ...f.deps,
    contexts: new ContextStore(),
  });
  t.after(() => restarted.shutdown());
  await restarted.recoverAfterRestart();
  assert.equal(restarted.get(id).phase, "connected");
  assert.match(restarted.view("CA-caller")!.lastError!, /status outage/);
  await assert.rejects(() => restarted.retry(id), /No failed recovery/);
  assert.ok(!f.operations.includes("end:CA-operator"));
});

test("restart restores both live call records for a connected native conference", async (t) => {
  const f = setup(t, true),
    id = f.start();
  await f.dialed(id);
  f.answered(id);
  await f.service.accept(id, "CA-operator");
  f.service.shutdown();
  const registry = new CallRegistry(join(f.dir!, "calls.json"));
  const restarted = new WarmTransferCoordinator({
    ...f.deps,
    registry,
    contexts: new ContextStore(),
  });
  t.after(() => restarted.shutdown());
  await restarted.recoverAfterRestart();
  assert.equal(registry.get("CA-caller")?.status, "in-progress");
  assert.equal(registry.get("CA-operator")?.status, "in-progress");
  assert.equal(registry.activeCount, 2);
});

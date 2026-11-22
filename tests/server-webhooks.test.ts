import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { MockAgent } from "undici";
import { MongoClient } from "mongodb";
import { assistantSchema } from "../lib/config";
import { assistantBodySchema } from "../server/api/v1/schemas/assistant";
import {
  toAgentInput,
  toApiAssistant,
  mergeAssistant,
  editableAssistant,
} from "../server/api/v1/mappers/assistant";
import { endOfCallReport } from "../server/webhooks/end-of-call-report";
import {
  DeliveryError,
  postServerEvent,
  publicAddress,
  publicLookup,
  retryAfter,
} from "../server/webhooks/transport";
import { AssistantServerEvents } from "../server/webhooks/service";
import {
  ServerEventOutbox,
  MAX_DELIVERY_ATTEMPTS,
} from "../server/webhooks/outbox";
import { MongoCallRepository, type StoredCall } from "../server/storage/calls";
import type { ObjectStore, StoredObject } from "../server/storage/objects";

const owner = randomUUID();
const assistant = {
  ...assistantSchema.parse({
    name: "Webhook assistant",
    systemPrompt: "Help the caller.",
    voiceId: "voice-id",
    server: { url: "https://receiver.example/end", timeoutSeconds: 20 },
  }),
  id: randomUUID(),
};
const call: StoredCall = {
  id: "CA11111111111111111111111111111111",
  sid: "CA11111111111111111111111111111111",
  assistantId: assistant.id,
  agentId: assistant.id,
  assistant,
  direction: "outbound",
  type: "outboundPhoneCall",
  from: "+14155550100",
  to: "+14155550101",
  status: "completed",
  createdAt: "2026-11-23T00:00:00.000Z",
  startedAt: "2026-11-23T00:00:01.000Z",
  endedAt: "2026-11-23T00:01:01.000Z",
  updatedAt: Date.parse("2026-11-23T00:01:02.000Z"),
  cost: {
    currency: "USD",
    durationSec: 60,
    lines: [
      {
        type: "transport",
        provider: "twilio",
        item: "Voice",
        quantity: 1,
        unit: "min",
        rate: 0.01,
        usd: 0.01,
      },
    ],
    servicesUsd: 0.01,
    hostingUsd: 0,
    totalUsd: 0.01,
    estimated: false,
    reconciliationStatus: "complete",
    warnings: [],
  },
};
const transcript = [
  {
    at: Date.parse(call.startedAt!),
    role: "agent" as const,
    text: "Hello",
    latencyMs: 200,
  },
  {
    at: Date.parse(call.startedAt!) + 2000,
    role: "caller" as const,
    text: "Help me please.",
  },
];
const report = () =>
  endOfCallReport({
    call,
    transcript,
    orgId: owner,
    baseUrl: "https://api.example/workspaces/owner",
    timestamp: Date.parse(call.endedAt!) + 1000,
  });

test("assistant server configuration survives dashboard/API round trips and partial updates", () => {
  assert.deepEqual(
    assistantSchema.parse({ name: "Old", systemPrompt: "Hi" }).server,
    { url: "", timeoutSeconds: 20 },
  );
  for (const url of [
    "http://receiver.example",
    "https://name:password@receiver.example",
    "https://receiver.example/#fragment",
    "bad-url",
  ])
    assert.equal(
      assistantSchema.safeParse({ ...assistant, server: { url } }).success,
      false,
    );
  for (const timeoutSeconds of [0, 301])
    assert.equal(
      assistantSchema.safeParse({
        ...assistant,
        server: { url: "", timeoutSeconds },
      }).success,
      false,
    );
  const document = {
    ...assistant,
    orgId: owner,
    createdAt: call.createdAt,
    updatedAt: call.createdAt,
  };
  const body = assistantBodySchema.parse(editableAssistant(document));
  assert.deepEqual(toAgentInput(body).server, assistant.server);
  const patched = mergeAssistant(editableAssistant(document), {
    server: { timeoutSeconds: 30 },
  });
  assert.deepEqual(toAgentInput(patched).server, {
    url: assistant.server.url,
    timeoutSeconds: 30,
  });
  assert.equal(
    toAgentInput(
      mergeAssistant(editableAssistant(document), { server: { url: "" } }),
    ).server.url,
    "",
  );
});

test("end-of-call report uses the assistant server envelope, required fields and nested artifacts", () => {
  const value = report();
  assert.deepEqual(Object.keys(value), ["message"]);
  assert.equal(value.message.type, "end-of-call-report");
  assert.deepEqual(value.message.analysis, {});
  assert.equal(value.message.endedReason, "customer-ended-call");
  assert.equal(value.message.call.status, "ended");
  assert.equal(value.message.call.orgId, owner);
  assert.equal(value.message.call.assistantId, assistant.id);
  assert.equal(
    value.message.artifact.transcript,
    "AI: Hello\nUser: Help me please.",
  );
  assert.deepEqual(
    value.message.artifact.messages.map((m) => m.role),
    ["system", "bot", "user"],
  );
  assert.equal(value.message.artifact.messages[1].endTime, transcript[0].at);
  assert.equal("latencyMs" in value.message.artifact.messages[1], false);
  assert.equal("duration" in value.message.artifact.messages[1], false);
  assert.deepEqual(value.message.costs, [
    { type: "transport", provider: "twilio", minutes: 1, cost: 0.01 },
  ]);
  assert.equal("sid" in value.message.call, false);
  assert.equal("storagePending" in value.message.call, false);
  assert.throws(() =>
    endOfCallReport({
      call: { ...call, status: "in-progress" },
      transcript,
      orgId: owner,
      baseUrl: "",
    }),
  );
});

test("webhook destinations reject private networks, metadata addresses and DNS rebinding", async () => {
  for (const address of [
    "127.0.0.1",
    "10.0.0.2",
    "100.100.100.200",
    "169.254.169.254",
    "172.16.1.2",
    "192.168.1.2",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "fd00::1",
    "fe80::1",
    "2002:7f00:1::",
    "2001:db8::1",
  ])
    assert.equal(publicAddress(address), false, address);
  assert.equal(publicAddress("8.8.8.8"), true);
  assert.equal(publicAddress("2606:4700:4700::1111"), true);
  await assert.rejects(
    publicLookup(
      "receiver.example",
      async () =>
        [
          { address: "8.8.8.8", family: 4 },
          { address: "127.0.0.1", family: 4 },
        ] as never,
    ),
    /public/,
  );
  for (const url of [
    "https://127.0.0.1/hook",
    "https://[::1]/hook",
    "http://receiver.example/hook",
  ])
    await assert.rejects(
      postServerEvent({ url, timeoutSeconds: 1, body: "{}", id: "event" }),
      DeliveryError,
    );
  assert.equal(retryAfter("30"), 30000);
  assert.equal(
    retryAfter(
      "Wed, 01 Jan 2025 00:00:10 GMT",
      Date.parse("2025-01-01T00:00:00Z"),
    ),
    10000,
  );
  assert.equal(retryAfter("garbage"), undefined);
});

function memoryObjects() {
  const values = new Map<string, string>();
  let signature = 0;
  const objects = {
    put: async (
      key: string,
      body: string,
      contentType: string,
    ): Promise<StoredObject> => {
      values.set(key, body);
      return {
        key,
        bucket: "private",
        size: Buffer.byteLength(body),
        contentType,
        createdAt: new Date().toISOString(),
      };
    },
    read: async (key: string) => {
      if (!values.has(key)) throw new Error("Missing artifact");
      return Readable.from([values.get(key)!]);
    },
    signedUrl: async (key: string) =>
      `https://private.example/${key}?signature=${++signature}`,
    deletePrefix: async (prefix: string) => {
      for (const key of values.keys())
        if (key.startsWith(prefix)) values.delete(key);
    },
  } as unknown as ObjectStore;
  return objects;
}

test(
  "durable per-user outbox survives restarts, retries and duplicate finalization",
  { skip: !process.env.TEST_MONGODB_URI, timeout: 30000 },
  async (t) => {
    const mongo = await new MongoClient(
      process.env.TEST_MONGODB_URI!,
    ).connect();
    const db = mongo.db(`webhook_test_${randomUUID().replaceAll("-", "")}`);
    t.after(async () => {
      await db.dropDatabase();
      await mongo.close();
    });
    const calls = new MongoCallRepository(db);
    await calls.initialize();
    await calls.create(call);
    await Promise.all(
      transcript.map((line, i) =>
        calls.appendTranscript(call.sid, line, String(i)),
      ),
    );
    const objects = memoryObjects();
    const logs = await objects.put(
      `calls/${call.sid}/logs.jsonl`,
      "log",
      "application/x-ndjson",
    );
    await calls.setArtifact(call.sid, "logs", logs);
    const received: { url: string; id: string; body: string }[] = [];
    const service = () =>
      new AssistantServerEvents({
        db,
        calls,
        objects,
        userId: owner,
        baseUrl: "https://api.example",
        send: async (request) => {
          received.push(request);
          if (received.length === 1)
            throw new DeliveryError(
              "Webhook returned HTTP 503.",
              true,
              503,
              30000,
            );
          return 204;
        },
      });
    const first = service();
    await first.initialize();
    await Promise.all([
      first.enqueueEndOfCall(call.sid),
      first.enqueueEndOfCall(call.sid),
    ]);
    assert.equal(
      await db.collection("server_event_deliveries").countDocuments(),
      1,
    );
    await db.collection("assistants").insertOne({
      id: assistant.id,
      server: { url: "https://different.example/new" },
    });
    await first.tick();
    const failedAttempt = await db
      .collection("server_event_deliveries")
      .findOne({});
    assert.equal(failedAttempt?.state, "pending");
    assert.equal(failedAttempt?.attempts, 1);
    assert.ok(failedAttempt?.dueAt.getTime() >= Date.now() + 29000);
    await first.close();
    await db
      .collection("server_event_deliveries")
      .updateMany({}, { $set: { dueAt: new Date(0) } });
    const second = service();
    await second.initialize();
    await second.tick();
    await second.enqueueEndOfCall(call.sid);
    await second.tick();
    await second.close();
    assert.equal(received.length, 2);
    assert.equal(received[0].id, received[1].id);
    assert.equal(received[1].url, assistant.server.url);
    const payload1 = JSON.parse(received[0].body),
      payload2 = JSON.parse(received[1].body);
    assert.equal(payload1.message.timestamp, payload2.message.timestamp);
    assert.notEqual(
      payload1.message.artifact.presignedLogUrl,
      payload2.message.artifact.presignedLogUrl,
    );
    assert.deepEqual(payload2.message.call.artifact, payload2.message.artifact);
    assert.equal(
      (await db.collection("server_event_deliveries").findOne({}))?.state,
      "delivered",
    );
    const other = new ServerEventOutbox(db, randomUUID());
    await other.initialize();
    assert.equal(await other.exists(call.sid, "end-of-call-report"), false);
    assert.equal(await other.claim(), null);

    const outbox = new ServerEventOutbox(db, owner);
    const object = await objects.put(
      "call-payload.json",
      "{}",
      "application/json",
    );
    await outbox.enqueue({
      callId: "retry-call",
      event: "end-of-call-report",
      url: assistant.server.url,
      timeoutSeconds: 20,
      payload: object,
    });
    const abandoned = (await outbox.claim())!;
    assert.equal(await outbox.claim(), null);
    assert.equal(await outbox.renew(abandoned), true);
    const recovered = (await outbox.claim(new Date(Date.now() + 361000)))!;
    assert.equal(recovered._id, abandoned._id);
    assert.equal(await outbox.renew(abandoned), false);
    await outbox.success(abandoned, 200);
    assert.equal(
      (
        await db
          .collection("server_event_deliveries")
          .findOne({ callId: "retry-call" })
      )?.state,
      "delivering",
    );
    assert.equal(
      await outbox.failure(
        recovered,
        new DeliveryError("Forbidden", false, 403),
      ),
      "failed",
    );
    assert.equal(await outbox.pending(), false);
    await other.retryFailed("retry-call");
    assert.equal(await outbox.pending(), false);
    const history = await outbox.list("retry-call");
    assert.equal(history[0].state, "failed");
    assert.equal("url" in history[0], false);
    assert.equal("payload" in history[0], false);
    await outbox.retryFailed("retry-call");
    const retried = (await outbox.claim())!;
    assert.equal(retried.attempts, 1);
    assert.equal(retried._id, recovered._id);
    await outbox.success(retried, 204);
    await outbox.enqueue({
      callId: "exhausted",
      event: "end-of-call-report",
      url: assistant.server.url,
      timeoutSeconds: 20,
      payload: object,
    });
    for (let i = 1; i <= MAX_DELIVERY_ATTEMPTS; i++) {
      const claimed = (await outbox.claim(new Date(Date.now() + i * 1000000)))!;
      assert.equal(claimed.attempts, i);
      assert.equal(
        await outbox.failure(claimed, new DeliveryError("Unavailable", true)),
        i < MAX_DELIVERY_ATTEMPTS ? "pending" : "failed",
      );
    }
  },
);

test(
  "legacy calls stay unconfigured; reports wait for processing and include every transcript entry",
  { skip: !process.env.TEST_MONGODB_URI, timeout: 30000 },
  async (t) => {
    const mongo = await new MongoClient(
      process.env.TEST_MONGODB_URI!,
    ).connect();
    const db = mongo.db(`webhook_test_${randomUUID().replaceAll("-", "")}`);
    t.after(async () => {
      await db.dropDatabase();
      await mongo.close();
    });
    const calls = new MongoCallRepository(db);
    await calls.initialize();
    const service = new AssistantServerEvents({
      db,
      calls,
      objects: memoryObjects(),
      userId: owner,
      baseUrl: "https://api.example",
      send: async () => 204,
    });
    await service.initialize();
    t.after(() => service.close());
    await calls.create({ ...call, assistant: undefined });
    await service.enqueueEndOfCall(call.sid);
    assert.equal(await service.outbox.pending(), false);
    await db
      .collection("calls")
      .updateOne(
        { sid: call.sid },
        { $set: { assistant, "cost.reconciliationStatus": "pending" } },
      );
    await assert.rejects(service.enqueueEndOfCall(call.sid), /billing/);
    await db
      .collection("calls")
      .updateOne(
        { sid: call.sid },
        { $set: { "cost.reconciliationStatus": "complete" } },
      );
    const entries = Array.from({ length: 5100 }, (_, i) => ({
      _id: `${call.sid}:${String(i).padStart(5, "0")}`,
      callId: call.sid,
      at: transcript[0].at + i,
      role: "caller",
      text: `Line ${i}`,
    }));
    await db
      .collection<(typeof entries)[number]>("call_transcripts")
      .insertMany(entries);
    assert.equal((await calls.completeTranscript(call.sid)).length, 5100);
    await service.enqueueEndOfCall(call.sid);
    assert.equal(await service.outbox.pending(), true);
    await calls.purge(call.sid, memoryObjects());
    assert.equal(await service.outbox.pending(), false);
  },
);

test("HTTP delivery POSTs unchanged JSON, rejects redirects and classifies retryable responses", async () => {
  const mock = new MockAgent();
  mock.disableNetConnect();
  try {
    const pool = mock.get("https://receiver.example");
    const body = JSON.stringify(report());
    pool
      .intercept({
        path: "/end",
        method: "POST",
        body,
        headers: {
          "content-type": "application/json",
          "idempotency-key": "stable-id",
        },
      })
      .reply(204);
    const input = {
      url: "https://receiver.example/end",
      timeoutSeconds: 1,
      body,
      id: "stable-id",
    };
    assert.equal(await postServerEvent(input, mock), 204);
    for (const [status, retryable] of [
      [302, false],
      [400, false],
      [401, false],
      [403, false],
      [408, true],
      [429, true],
      [503, true],
    ] as const) {
      pool
        .intercept({ path: "/end", method: "POST" })
        .reply(status, "sensitive response content", {
          headers: {
            "retry-after": "60",
            location: "https://127.0.0.1/private",
          },
        });
      await assert.rejects(postServerEvent(input, mock), (error: unknown) => {
        assert.ok(error instanceof DeliveryError);
        assert.equal(error.retryable, retryable);
        assert.equal(error.status, status);
        assert.equal(error.message.includes("sensitive"), false);
        if (retryable) assert.equal(error.retryAfterMs, 60000);
        return true;
      });
    }
    pool.intercept({ path: "/end", method: "POST" }).reply(200).delay(1500);
    await assert.rejects(
      postServerEvent(input, mock),
      (error: unknown) =>
        error instanceof DeliveryError &&
        error.retryable &&
        /timed out/.test(error.message),
    );
    mock.assertNoPendingInterceptors();
  } finally {
    await mock.close();
  }
});

test("cost reports preserve audio and character units when charges use credits or provider dollars", () => {
  const cost = structuredClone(call.cost!);
  cost.lines = [
    { provider: "deepgram", type: "transcriber", model: "flux-general-en", item: "Provider request", quantity: 60, unit: "seconds", rate: null, usd: 0.01 },
    { provider: "elevenlabs", type: "voice", model: "eleven_flash_v2_5", item: "Voice credits", quantity: 100, unit: "credits", rate: 0.0001, usd: 0.01 },
  ];
  cost.usage = { llm: [], telephony: [], transcriber: [{ provider: "deepgram", model: "flux-general-en", audioSeconds: 60, source: "submitted-audio" }], voice: [{ provider: "elevenlabs", model: "eleven_flash_v2_5", characters: 200, source: "submitted-text" }], network: { receivedBytes: 0, sentBytes: 0 } };
  const report = endOfCallReport({ call: { ...call, cost }, transcript: [], orgId: owner, baseUrl: "https://calls.example" });
  assert.equal(report.message.costs?.find((line) => line.type === "transcriber")?.minutes, 1);
  assert.equal(report.message.costs?.find((line) => line.type === "voice")?.characters, 200);
  assert.deepEqual(report.message.call.usage, cost.usage);
});

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { MongoClient } from "mongodb";
import { MongoCallRepository } from "../server/storage/calls";
import type { CallCost } from "../lib/types";
import { agent } from "./helpers";
import type { ObjectStore } from "../server/storage/objects";

// Run against a dedicated local MongoDB >=7: MONGODB_TEST_URI=mongodb://127.0.0.1:27017 npm test
const uri = process.env.MONGODB_TEST_URI ?? process.env.TEST_MONGODB_URI;
test("durable calls survive repository restart, reject stale status, page without gaps and deduplicate trace writes", { skip: !uri }, async () => {
  const client = new MongoClient(uri!);
  await client.connect();
  const db = client.db(`storage_test_${randomUUID().replaceAll("-", "")}`);
  try {
    const repository = new MongoCallRepository(db);
    await repository.initialize();
    const create = (sid: string, time: number) => repository.create({ sid, agentId: "assistant-1", direction: "inbound", from: "+15550000001", to: "+15550000002", status: "initiating", updatedAt: time });
    await Promise.all([create("CA1", 1000), create("CA2", 1000), create("CA3", 1000)]);
    assert.deepEqual(await repository.pendingArchives(), []);
    await repository.markArchived("CA1");
    assert.equal((await repository.get("CA1"))?.storagePending, false);
    await repository.update("CA1", "in-progress");
    await repository.update("CA1", "ringing");
    assert.equal((await repository.get("CA1"))?.status, "in-progress");
    await repository.update("CA1", "completed");
    await Promise.all([repository.update("CA1", "failed"), repository.update("CA1", "in-progress"), create("CA1", 2000)]);
    assert.equal((await repository.get("CA1"))?.status, "completed");
    assert.equal((await repository.get("CA1"))?.storagePending, true);
    assert.deepEqual(await new MongoCallRepository(db).pendingArchives(), ["CA1"]);
    const page1 = await repository.list({ limit: 2 });
    const page2 = await repository.list({ limit: 2, cursor: page1.nextCursor! });
    assert.deepEqual([...page1.items, ...page2.items].map(c => c.id), ["CA3", "CA2", "CA1"]);
    assert.equal(page2.nextCursor, null);
    assert.equal((await repository.list({ assistantId: "missing" })).items.length, 0);
    const event = { at: 1002, event: "call.started", detail: { ok: true } };
    await repository.appendEvent("CA1", event, "stable-id");
    await repository.appendEvent("CA1", event, "stable-id");
    for (let i = 0; i < 5; i++) await repository.appendTranscript("CA1", { at: 1003, role: "agent", text: `message-${i}`, latencyMs: i * 100 }, `message-${i}`);
    const restarted = new MongoCallRepository(db);
    const trace1 = await restarted.trace("CA1", { limit: 2 });
    assert.equal(trace1?.events.length, 1);
    assert.equal(trace1?.stats.turns, 5);
    assert.equal(trace1?.stats.avgLatencyMs, 200);
    const trace2 = await restarted.trace("CA1", { limit: 2, transcriptCursor: trace1!.pagination.transcriptNextCursor! });
    const trace3 = await restarted.trace("CA1", { limit: 2, transcriptCursor: trace2!.pagination.transcriptNextCursor! });
    assert.equal(new Set([...trace1!.transcript, ...trace2!.transcript, ...trace3!.transcript].map(m => m.text)).size, 5);
    const snapshot = agent({ name: "At call start" });
    await repository.create({ sid: "CA-snapshot", agentId: snapshot.id, assistant: snapshot, tools: [], direction: "outbound", from: "+15550000001", to: "+15550000002", status: "initiating" });
    snapshot.name = "Edited later";
    await repository.create({ sid: "CA-snapshot", agentId: snapshot.id, assistant: snapshot, direction: "outbound", from: "+15550000001", to: "+15550000002", status: "initiating" });
    assert.equal((await repository.get("CA-snapshot"))?.assistant?.name, "At call start");
    const cost: CallCost = { currency: "USD", durationSec: 10, lines: [{ provider: "unknown", item: "Unpriced model", quantity: 42, unit: "tokens", rate: null, usd: null }], servicesUsd: 0, hostingUsd: 0, totalUsd: 0, estimated: true, status: "incomplete", warnings: ["Missing rate"] };
    cost.usage = { llm: [], transcriber: [], voice: [], telephony: [{ callSid: "CA1", durationSeconds: 10, price: 0.01, currency: "USD", source: "provider" }], network: { receivedBytes: 0, sentBytes: 0 } };
    await repository.saveCost("CA1", cost);
    assert.deepEqual(await repository.getBillingUsage("CA1"), cost.usage);
    assert.deepEqual((await restarted.get("CA1"))?.cost, cost);
    assert.equal(((await restarted.get("CA1"))?.costs?.[0] as { usd: unknown }).usd, null);
    await repository.saveUsage("CA1", { tokens: 42 }, 2);
    await repository.saveUsage("CA1", { tokens: 1 }, 1);
    assert.deepEqual(await restarted.getUsage("CA1"), { tokens: 42 });
    const uploaded = new Map<string, string>();
    const objects = {
      async putStream(key: string, input: AsyncIterable<string>, contentType: string) {
        let text = "";
        for await (const chunk of input) text += chunk;
        uploaded.set(key, text);
        return { key, bucket: "private-calls", contentType, size: Buffer.byteLength(text), createdAt: new Date().toISOString() };
      },
    } as unknown as ObjectStore;
    await repository.exportArtifacts("CA1", objects);
    assert.equal(uploaded.get("calls/CA1/transcript.txt")?.split("\n").filter(Boolean).length, 5);
    assert.equal(uploaded.get("calls/CA1/messages.jsonl")?.split("\n").filter(Boolean).length, 5);
    assert.equal(uploaded.get("calls/CA1/logs.jsonl")?.split("\n").filter(Boolean).length, 1);
    assert.equal((await restarted.get("CA1"))?.artifact?.messages?.key, "calls/CA1/messages.jsonl");
    await repository.create({ sid: "CA-terminal", agentId: "assistant-1", direction: "inbound", from: "", to: "", status: "failed", endedAt: "1970-01-01T00:00:00.000Z" });
    assert.deepEqual(await repository.pendingArchives(1), ["CA-terminal"]);
    await repository.markArchived("CA-terminal");
    await repository.markArchived("CA1");
    assert.deepEqual(await repository.pendingArchives(), []);
    assert.ok((await repository.get("CA1"))?.archivedAt);
    await repository.update("CA1", "completed");
    await create("CA1", 2000);
    assert.deepEqual(await repository.pendingArchives(), []);
    await assert.rejects(repository.list({ cursor: "garbage" }), /Invalid pagination cursor/);
  } finally { await db.dropDatabase(); await client.close(); }
});

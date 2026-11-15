import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { MongoClient } from "mongodb";
import type { CallUsage } from "../lib/types";
import { UsageMeter } from "../server/billing/meter";
import { mergeUsage } from "../server/billing/merge-usage";
import { MongoCallRepository } from "../server/storage/calls";

function snapshot(tokens: number, characters = 0, seconds = 0): CallUsage {
  const meter = new UsageMeter();
  meter.addLlm("gpt-4o", { promptTokens: tokens, cachedTokens: Math.floor(tokens / 10), completionTokens: 2 });
  meter.addTts("eleven_flash_v2_5", characters);
  meter.addStt("flux-general-en", seconds);
  meter.addNetwork(tokens * 2, tokens * 3);
  meter.setTelephony({ callSid: "CA-segments", durationSeconds: 60, price: 0.01, currency: "USD", source: "provider" });
  return meter.snapshot();
}

test("usage aggregation sums independent model/audio/network segments but not provider call totals", () => {
  const first = snapshot(100, 20, 3);
  const second = snapshot(40, 10, 2);
  const merged = mergeUsage([first, second]);
  assert.equal(merged.llm[0].prompt, 140);
  assert.equal(merged.llm[0].cached, 14);
  assert.equal(merged.llm[0].requests, 2);
  assert.equal(merged.voice[0].characters, 30);
  assert.equal(merged.transcriber[0].audioSeconds, 5);
  assert.equal(merged.network.receivedBytes, 280);
  assert.equal(merged.network.sentBytes, 420);
  assert.equal(merged.telephony.length, 1);
  assert.equal(merged.telephony[0].price, 0.01);
  assert.equal(first.llm[0].prompt, 100);
});

const uri = process.env.MONGODB_TEST_URI ?? process.env.TEST_MONGODB_URI;
test("late snapshots from an old producer cannot replace a resumed worker's usage", { skip: !uri }, async () => {
  const client = new MongoClient(uri!);
  await client.connect();
  const db = client.db(`usage_segments_test_${randomUUID().replaceAll("-", "")}`);
  try {
    const firstWorker = new MongoCallRepository(db);
    const resumedWorker = new MongoCallRepository(db);
    await firstWorker.initialize();
    await firstWorker.saveUsageSegment("CA-segments", "worker-a", snapshot(100, 20, 3), 2);
    await resumedWorker.saveUsageSegment("CA-segments", "worker-b", snapshot(40, 10, 2), 1);
    // Arrives late with an older sequence even if that worker's clock is ahead.
    await firstWorker.saveUsageSegment("CA-segments", "worker-a", snapshot(50, 5, 1), 1);
    let usage = await resumedWorker.getUsage("CA-segments") as CallUsage;
    assert.equal(usage.llm[0].prompt, 140);
    // A valid late final flush only adds to its own producer's contribution.
    await firstWorker.saveUsageSegment("CA-segments", "worker-a", snapshot(110, 25, 4), 3);
    await resumedWorker.saveUsageSegment("CA-segments", "worker-b", snapshot(105, 30, 6), 2);
    await firstWorker.saveUsageSegment("CA-segments", "worker-a", snapshot(110, 25, 4), 3);
    // A conflicting replay with the same revision cannot inflate charges.
    await firstWorker.saveUsageSegment("CA-segments", "worker-a", snapshot(999), 3);
    usage = await new MongoCallRepository(db).getUsage("CA-segments") as CallUsage;
    assert.equal(usage.llm[0].prompt, 215);
    assert.equal(usage.llm[0].requests, 2);
    assert.equal(usage.voice[0].characters, 55);
    assert.equal(usage.transcriber[0].audioSeconds, 10);
    assert.equal(usage.telephony.length, 1);
    assert.equal(await db.collection("call_usage_segments").countDocuments(), 2);
    // Existing pre-segment usage is a baseline, not overwritten by either worker.
    await firstWorker.saveUsage("CA-segments", snapshot(7), 1);
    usage = await resumedWorker.getUsage("CA-segments") as CallUsage;
    assert.equal(usage.llm[0].prompt, 222);
    await assert.rejects(firstWorker.saveUsageSegment("CA-segments", "worker-a", snapshot(5), -1), /Invalid usage/);
  } finally {
    await db.dropDatabase();
    await client.close();
  }
});

test("a late usage revision reopens archival and an older archive cannot clear it", { skip: !uri }, async () => {
  const client = new MongoClient(uri!);
  await client.connect();
  const db = client.db(`usage_archive_test_${randomUUID().replaceAll("-", "")}`);
  try {
    const calls = new MongoCallRepository(db);
    await calls.initialize();
    await calls.create({ sid: "CA-archive", agentId: "A1", direction: "inbound", from: "", to: "", status: "completed" });
    await calls.saveUsageSegment("CA-archive", "worker-a", snapshot(10), 1);
    const firstRevision = (await calls.get("CA-archive"))!.storageRevision!;
    assert.equal(firstRevision, 1);
    await calls.markArchived("CA-archive", firstRevision);
    assert.equal((await calls.get("CA-archive"))!.storagePending, false);
    await calls.saveUsageSegment("CA-archive", "worker-b", snapshot(5), 1);
    assert.equal((await calls.get("CA-archive"))!.storageRevision, 2);
    await calls.markArchived("CA-archive", firstRevision);
    assert.equal((await calls.get("CA-archive"))!.storagePending, true);
    await calls.markArchived("CA-archive", 2);
    assert.equal((await calls.get("CA-archive"))!.storagePending, false);
    await calls.saveUsageSegment("CA-archive", "worker-b", snapshot(5), 1);
    await calls.saveUsageSegment("CA-archive", "worker-b", snapshot(1), 0);
    assert.equal((await calls.get("CA-archive"))!.storageRevision, 2);
    assert.equal((await calls.get("CA-archive"))!.storagePending, false);
    assert.deepEqual(await calls.pendingArchives(), []);
  } finally {
    await db.dropDatabase(); await client.close();
  }
});

test("a stale billing worker cannot overwrite the current call cost or usage ledger", { skip: !uri }, async () => {
  const { priceCall } = await import("../server/billing/cost");
  const { defaultRates } = await import("../server/billing/pricing");
  const client = new MongoClient(uri!);
  await client.connect();
  const db = client.db(`usage_cost_version_test_${randomUUID().replaceAll("-", "")}`);
  try {
    const calls = new MongoCallRepository(db);
    await calls.initialize();
    await calls.create({ sid: "CA-cost-version", agentId: "A1", direction: "inbound", from: "", to: "", status: "completed" });
    await calls.saveUsageSegment("CA-cost-version", "worker-a", snapshot(10), 1);
    const meter = new UsageMeter(); meter.restore(snapshot(10));
    const oldCost = priceCall(meter, { direction: "inbound", to: "", durationSec: 60, amd: false }, defaultRates, { monthlyUsd: 0, expectedMinutesPerMonth: 0, egressUsdPerGb: 0 });
    await calls.saveCost("CA-cost-version", oldCost, undefined, 1);
    await calls.saveUsageSegment("CA-cost-version", "worker-a", snapshot(20), 2);
    meter.restore(snapshot(20));
    const newCost = priceCall(meter, { direction: "inbound", to: "", durationSec: 60, amd: false }, defaultRates, { monthlyUsd: 0, expectedMinutesPerMonth: 0, egressUsdPerGb: 0 });
    await calls.saveCost("CA-cost-version", newCost, undefined, 2);
    await calls.markArchived("CA-cost-version", 2);
    await assert.rejects(calls.saveCost("CA-cost-version", oldCost, undefined, 1), /usage changed/);
    assert.equal((await calls.get("CA-cost-version"))!.cost!.usage!.llm[0].prompt, 20);
    assert.equal((await calls.getBillingUsage("CA-cost-version"))!.llm[0].prompt, 20);
    assert.equal((await db.collection("call_costs").findOne({ callId: "CA-cost-version" }))!.storageRevision, 2);
    assert.equal((await calls.get("CA-cost-version"))!.storagePending, false);
  } finally { await db.dropDatabase(); await client.close(); }
});

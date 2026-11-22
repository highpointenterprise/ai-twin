import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { MongoClient } from "mongodb";
import express from "express";
import { env } from "../lib/env";
import { UsageMeter } from "../server/billing/meter";
import { priceCall } from "../server/billing/cost";
import { defaultRates } from "../server/billing/pricing";
import { ProviderUsageReconciler } from "../server/billing/provider-usage";
import { BillingService } from "../server/billing/service";
import { PricingPolicies } from "../server/billing/policy";
import { billingRoutes } from "../server/billing/routes";
import { MongoCallRepository } from "../server/storage/calls";
import { MongoTwilioCredentialStore } from "../server/storage/credentials";
import { agent } from "./helpers";

const infrastructure = {
  configured: true,
  monthlyUsd: 0,
  expectedMinutesPerMonth: 1000,
  egressUsdPerGb: 0,
};
function evidence() {
  const meter = new UsageMeter();
  meter.addLlm("gpt-4o", {
    promptTokens: 1000,
    cachedTokens: 400,
    completionTokens: 200,
    requestId: "model1",
  });
  const dg = meter.startRequest(
    "deepgram",
    "flux-general-en",
    "transcriber",
    "seconds",
  );
  meter.addStt("flux-general-en", 60, dg);
  meter.updateRequest(dg, {
    providerRequestId: "dg-request",
    status: "completed",
  });
  const voice = meter.startRequest(
    "elevenlabs",
    "eleven_flash_v2_5",
    "voice",
    "characters",
  );
  meter.addTts("eleven_flash_v2_5", 200, voice);
  meter.updateRequest(voice, {
    providerRequestId: "voice-request",
    status: "completed",
  });
  meter.addMediaSeconds(30);
  return { meter, dg, voice };
}
test("provider request reconciliation matches exact IDs, captures dollars and credits, and never adds account-wide usage", async (t) => {
  const previous = env.DEEPGRAM_PROJECT_ID;
  env.DEEPGRAM_PROJECT_ID = "project-one";
  t.after(() => {
    env.DEEPGRAM_PROJECT_ID = previous;
  });
  const f = evidence();
  let requests = 0;
  const reconcile = new ProviderUsageReconciler(async (url) => {
    requests++;
    if (String(url).includes("deepgram"))
      return Response.json({
        request: {
          request_id: "dg-request",
          response: { details: { usd: 0.006, total_audio: 59 } },
        },
      });
    return Response.json({
      history: [
        {
          request_id: "someone-else",
          character_count_change_from: 0,
          character_count_change_to: 90000,
        },
        {
          request_id: "voice-request",
          character_count_change_from: 1000,
          character_count_change_to: 1100,
        },
      ],
      has_more: false,
    });
  });
  const first = await reconcile.reconcile(f.meter.snapshot());
  assert.deepEqual(first.retryReasons, []);
  assert.equal(first.usage.requests?.find((r) => r.id === f.dg)?.usd, 0.006);
  assert.equal(
    first.usage.requests?.find((r) => r.id === f.voice)?.credits,
    100,
  );
  const second = await reconcile.reconcile(f.meter.snapshot(), first.usage);
  assert.equal(
    requests,
    2,
    "matched usage survives retries without more provider requests",
  );
  const restored = new UsageMeter();
  restored.restore(second.usage);
  const cost = priceCall(
    restored,
    { direction: "outbound", to: "+14155550100", durationSec: 60, amd: false },
    { ...defaultRates, elevenlabsCreditUsd: 0.0001 },
    infrastructure,
  );
  assert.equal(
    cost.costBreakdown?.stt,
    0.006,
    "reported charge replaces submitted-audio estimate",
  );
  assert.equal(
    cost.costBreakdown?.tts,
    0.01,
    "credits are charged once, not also as characters",
  );
  assert.equal(cost.reportedUsd, 0.006);
  assert.equal(
    cost.calculatedUsd,
    0.004 + 0.01 + defaultRates.twilio.mediaStreamsPerMin,
  );
  assert.equal(cost.durationMinutes, 1);
});
test("missing provider IDs, failed lookups and unconfigured AWS allocation remain visible", async (t) => {
  const previous = env.DEEPGRAM_PROJECT_ID;
  env.DEEPGRAM_PROJECT_ID = "project";
  t.after(() => {
    env.DEEPGRAM_PROJECT_ID = previous;
  });
  const f = evidence();
  const result = await new ProviderUsageReconciler(async () => {
    throw new Error("offline");
  }).reconcile(f.meter.snapshot());
  assert.ok(result.retryReasons.length);
  const fresh = new UsageMeter();
  fresh.restore(result.usage);
  const cost = priceCall(
    fresh,
    { direction: "outbound", to: "+14155550100", durationSec: 60, amd: false },
    defaultRates,
    { ...infrastructure, configured: false },
  );
  assert.equal(cost.status, "incomplete");
  assert.equal(
    cost.lines.find((l) => l.item === "Infrastructure allocation")?.usd,
    null,
  );
  assert.ok(cost.warnings.some((w) => w.includes("actual credit usage")));
  const raw = f.meter.snapshot();
  raw.requests!.forEach((r) => {
    delete r.providerRequestId;
  });
  const unmatched = await new ProviderUsageReconciler(async () => {
    throw new Error("must not fetch unrelated history");
  }).reconcile(raw);
  assert.equal(unmatched.retryReasons.length, 0);
  assert.ok(
    unmatched.usage.requests?.every((r) => r.reconciliation === "unavailable"),
  );
});
test("infrastructure math separates CPU, memory, storage, bytes and overhead without billing reasoning tokens twice", () => {
  const meter = new UsageMeter();
  meter.addNetwork(0, 1024 ** 3);
  meter.addLlm("gpt-4o", {
    promptTokens: 100,
    completionTokens: 100,
    cachedTokens: 0,
    reasoningTokens: 90,
  });
  const cost = priceCall(
    meter,
    {
      direction: "outbound",
      to: "+14155550100",
      durationSec: 3600,
      amd: false,
      artifactBytes: 1024 ** 3,
    },
    defaultRates,
    {
      ...infrastructure,
      egressUsdPerGb: 0.09,
      compute: {
        vcpuPerCall: 0.5,
        memoryGbPerCall: 1,
        vcpuHourUsd: 0.04,
        memoryGbHourUsd: 0.004,
      },
      storage: { retentionDays: 30, gbMonthUsd: 0.023 },
      overheadPerMinute: { database: 0.001 },
    },
  );
  assert.equal(cost.hostingUsd, 0.197);
  assert.equal(cost.costBreakdown?.llm, 0.00125);
  assert.equal(
    cost.lines
      .filter((l) => l.type === "hosting")
      .every((l) => l.basis === "infrastructure-estimate"),
    true,
  );
});
test(
  "cost ledger freezes pricing, deduplicates callbacks, stores attribution/history, and isolates reports",
  { skip: !process.env.TEST_MONGODB_URI },
  async (t) => {
    const client = await new MongoClient(
        process.env.TEST_MONGODB_URI!,
      ).connect(),
      db = client.db(`ledger_${randomUUID().replaceAll("-", "")}`);
    const previous = env.WORKSPACE_USER_ID;
    env.WORKSPACE_USER_ID = "owner-one";
    t.after(async () => {
      env.WORKSPACE_USER_ID = previous;
      await db.dropDatabase();
      await client.close();
    });
    const policies = new PricingPolicies(db),
      original = await policies.current();
    await policies.update({
      rates: original.rates,
      expectedVersion: original.version,
      hosting: infrastructure,
      note: "Test account rates",
    });
    const calls = new MongoCallRepository(db, () => "AC-account-one");
    await calls.initialize();
    const assistant = agent();
    await db
      .collection("phone_numbers")
      .insertOne({
        orgId: "owner-one",
        id: "phone-one",
        number: "+14155550100",
      });
    const record = await calls.create({
      sid: "CA-cost",
      agentId: assistant.id,
      assistant,
      direction: "outbound",
      from: "+14155550100",
      to: "+14155550199",
      status: "completed",
      createdAt: "2026-11-23T00:00:00Z",
      startedAt: "2026-11-23T00:00:00Z",
      endedAt: "2026-11-23T00:01:00Z",
    });
    const policy = await policies.forCall(record.sid),
      changed = structuredClone(policy.rates);
    changed.openai["gpt-4o"].input = 500;
    await policies.update({
      expectedVersion: policy.version,
      rates: changed,
      hosting: infrastructure,
      note: "Rates for future calls",
    });
    assert.deepEqual((await policies.forCall(record.sid)).rates, policy.rates);
    const meter = new UsageMeter();
    meter.addLlm("gpt-4o", {
      promptTokens: 1000,
      completionTokens: 0,
      cachedTokens: 0,
    });
    await calls.saveUsageSegment(
      record.sid,
      "producer-one",
      meter.snapshot(),
      1,
    );
    let price: string | null = null;
    const service = new BillingService(db, calls, {
      getCallUsage: async (_sid, account) => {
        assert.equal(account, "AC-account-one");
        return { duration: "60", price, priceUnit: "USD" };
      },
    });
    await service.finalize(record.sid);
    await service.finalize(record.sid);
    assert.equal(await db.collection("call_costs").countDocuments(), 1);
    assert.equal(await db.collection("call_cost_history").countDocuments(), 1);
    price = "-0.123";
    const final = await service.finalize(record.sid);
    assert.equal(final.cost.costBreakdown?.llm, 0.0025);
    assert.equal(final.cost.pricingVersion, policy.version);
    assert.equal(await db.collection("call_cost_history").countDocuments(), 2);
    const persisted = await db
      .collection("call_costs")
      .findOne({ callId: record.sid });
    assert.equal(persisted?.userId, "owner-one");
    assert.equal(persisted?.assistantId, assistant.id);
    assert.equal(persisted?.phoneNumberId, "phone-one");
    price = null;
    assert.equal(
      (await service.finalize(record.sid)).cost.reportedUsd,
      0.123,
      "a pending response cannot erase a confirmed charge",
    );
    const app = express();
    app.use(express.json());
    app.use("/one", billingRoutes(db, "owner-one", policies));
    app.use("/two", billingRoutes(db, "owner-two", policies));
    app.use((error: any, _req: any, res: any, _next: any) =>
      res.status(error.status ?? 400).json({ error: error.message }),
    );
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    assert.equal((await fetch(url + "/two/calls/CA-cost")).status, 404);
    const query =
      "?from=2026-11-01T00:00:00.000Z&to=2026-12-01T00:00:00.000Z&groupBy=month";
    const summary = await fetch(url + "/one/summary" + query).then((r) =>
      r.json(),
    );
    assert.equal(summary.groups[0].calls, 1);
    assert.equal(summary.groups[0].reportedUsd, 0.123);
    assert.equal(
      (await fetch(url + "/two/summary" + query).then((r) => r.json())).groups
        .length,
      0,
    );
    assert.equal(
      (await fetch(url + "/one/summary?from=bad&to=bad")).status,
      400,
    );
    await assert.rejects(
      () =>
        policies.update({
          expectedVersion: policy.version,
          rates: changed,
          hosting: infrastructure,
          note: "stale",
        }),
      /Pricing changed/,
    );
  },
);
test(
  "previous telephony account credentials remain encrypted for delayed cost reconciliation",
  { skip: !process.env.TEST_MONGODB_URI },
  async (t) => {
    const client = await new MongoClient(
        process.env.TEST_MONGODB_URI!,
      ).connect(),
      db = client.db(`credential_billing_${randomUUID().replaceAll("-", "")}`);
    t.after(async () => {
      await db.dropDatabase();
      await client.close();
    });
    const store = new MongoTwilioCredentialStore(db, "a".repeat(64));
    await store.initialize();
    const first = {
        accountSid: "AC" + "1".repeat(32),
        authToken: "2".repeat(32),
      },
      second = { accountSid: "AC" + "3".repeat(32), authToken: "4".repeat(32) };
    await store.save(first);
    await store.save(second);
    assert.deepEqual(await store.forAccount(first.accountSid), first);
    assert.deepEqual(await store.forAccount(second.accountSid), second);
    assert.equal(await store.forAccount("AC" + "f".repeat(32)), undefined);
    assert.ok(
      !JSON.stringify(
        await db.collection("provider_credential_accounts").find().toArray(),
      ).includes(first.authToken),
    );
  },
);

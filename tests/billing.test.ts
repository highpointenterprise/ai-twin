import { test } from "node:test";
import assert from "node:assert/strict";
import { UsageMeter } from "../server/billing/meter";
import { priceCall } from "../server/billing/cost";
import { defaultRates } from "../server/billing/pricing";
import { CostTracker } from "../server/billing/tracker";
import { CallRegistry } from "../server/store/calls";
import { TraceStore } from "../server/observability/trace";
import { recordRealtimeUsage } from "../server/providers/openai-realtime";

const hosting = { monthlyUsd: 0, expectedMinutesPerMonth: 0, egressUsdPerGb: 0 };
const facts = { direction: "outbound" as const, to: "+15555550100", durationSec: 61, amd: true };

test("call costs retain provider tokens, cached input, generated characters and submitted audio", () => {
  const usage = new UsageMeter();
  usage.addLlm("gpt-4o", { promptTokens: 1000, cachedTokens: 400, completionTokens: 200, reasoningTokens: 50, requestId: "req1" });
  usage.addLlm("gpt-4o", { promptTokens: 1000, cachedTokens: 400, completionTokens: 200, requestId: "req1" });
  usage.addStt("flux-general-en", 61);
  usage.addTts("eleven_flash_v2_5", 210);
  usage.setTelephony({ callSid: "CA1", durationSeconds: 61, price: -0.05, currency: "USD", source: "provider" });
  const cost = priceCall(usage, facts, defaultRates, hosting);
  assert.equal(cost.costBreakdown?.llmPromptTokens, 1000);
  assert.equal(cost.costBreakdown?.llmCompletionTokens, 200);
  assert.equal(cost.costBreakdown?.llmCachedPromptTokens, 400);
  assert.equal(cost.usage?.llm[0].reasoning, 50);
  assert.equal(cost.costBreakdown?.llm, 0.004);
  assert.equal(cost.costBreakdown?.ttsCharacters, 210);
  assert.equal(cost.costBreakdown?.transcriberSeconds, 61);
  assert.equal(cost.lines.find((l) => l.item === "Voice (outbound)")?.usd, 0.05);
  assert.equal(cost.status, "estimated");
  assert.equal(cost.lines.filter((l) => l.provider === "twilio").length, 3);
});

test("unknown model prices are missing, not fabricated free usage", () => {
  const usage = new UsageMeter();
  usage.addLlm("groq:unknown", { provider: "groq", promptTokens: 100, cachedTokens: 0, completionTokens: 10 });
  usage.addTts("unknown-voice", 100);
  const cost = priceCall(usage, { ...facts, durationSec: 0 }, defaultRates, hosting);
  assert.equal(cost.status, "incomplete");
  assert.equal(cost.estimated, true);
  assert.equal(cost.knownSubtotalUsd, 0);
  assert.ok(cost.lines.every((line) => line.usd === null));
  assert.ok(cost.warnings.every((warning) => warning.includes("priced items only")));
  assert.ok(cost.lines.some((line) => line.provider === "groq"));
});

test("realtime audio input, cached audio and audio output are priced separately without double counting", () => {
  const usage = new UsageMeter();
  const trace = { usage, log: () => {} };
  recordRealtimeUsage(trace, "realtime-test", {
    input_tokens: 100, output_tokens: 30,
    input_token_details: { audio_tokens: 60, cached_tokens: 20, cached_tokens_details: { audio_tokens: 10 } },
    output_token_details: { audio_tokens: 20 },
  }, "response1");
  const cost = priceCall(usage, { ...facts, durationSec: 0 }, {
    ...defaultRates, openai: { "realtime-test": { input: 1, cachedInput: 0.5, output: 2, audioInput: 10, audioCachedInput: 5, audioOutput: 20 } },
  }, hosting);
  assert.equal(cost.costBreakdown?.llm, 0.001005);
  assert.equal(cost.usage?.llm[0].cachedAudio, 10);
  assert.equal(cost.lines.reduce((s, line) => s + line.quantity, 0), 130);
});

test("network cost bills only outbound bytes and snapshots survive JSON serialization", () => {
  const usage = new UsageMeter();
  usage.addNetwork(4e9, 1e9);
  usage.addStt("flux-general-en", 12.5);
  const saved = JSON.parse(JSON.stringify(usage.snapshot()));
  const restored = new UsageMeter();
  restored.restore(saved);
  assert.deepEqual(restored.snapshot(), saved);
  const cost = priceCall(restored, { ...facts, durationSec: 0 }, defaultRates, { ...hosting, egressUsdPerGb: 0.10 });
  assert.equal(cost.lines.find((line) => line.item === "Data transfer out")?.usd, 0.10);
});

test("finalization drains on shutdown and late provider usage updates one call cost", async () => {
  const registry = new CallRegistry();
  registry.create({ sid: "CA-billing", agentId: "A1", direction: "outbound", from: "+15555550101", to: facts.to, status: "completed" });
  const traces = new TraceStore();
  traces.for("CA-billing").usage.addLlm("gpt-4o", { promptTokens: 10, cachedTokens: 0, completionTokens: 5 });
  const persisted = new Map();
  const tracker = new CostTracker({
    registry, traces, rates: () => defaultRates, hosting, amdEnabled: () => false, settleMs: 60000,
    onFinalized: async (sid, cost, usage) => { persisted.set(sid, { cost, usage }); },
  });
  tracker.finalize("CA-billing", 30);
  tracker.finalize("CA-billing", 61);
  await tracker.flush();
  assert.equal(persisted.size, 1);
  assert.equal(registry.get("CA-billing")?.cost?.durationSec, 61);
  tracker.addTelephonyUsage("CA-billing", { duration: "61", price: "-0.123", priceUnit: "USD" });
  tracker.finalize("CA-billing", 61);
  await tracker.flush();
  assert.equal(persisted.size, 1);
  assert.equal(persisted.get("CA-billing").cost.lines.find((l: { item: string }) => l.item === "Voice (outbound)").usd, 0.123);
});

test("late callback without a live or restored trace preserves the previous cost", async () => {
  const registry = new CallRegistry();
  registry.create({ sid: "CA-old", agentId: "A1", direction: "inbound", from: "+15555550101", to: facts.to, status: "completed" });
  const existing = priceCall(new UsageMeter(), facts, defaultRates, hosting);
  registry.patch("CA-old", { cost: existing });
  const traces = new TraceStore();
  const tracker = new CostTracker({ registry, traces, rates: () => defaultRates, hosting, amdEnabled: () => false });
  tracker.finalize("CA-old", 61);
  await tracker.flush();
  assert.equal(registry.get("CA-old")?.cost, existing);
  assert.equal(traces.get("CA-old"), undefined);
});

test("missing realtime usage marks the call incomplete instead of treating it as free", () => {
  const usage = new UsageMeter();
  recordRealtimeUsage({ usage, log: () => {} }, "realtime-test", undefined);
  const cost = priceCall(usage, { ...facts, durationSec: 0 }, defaultRates, hosting);
  assert.equal(cost.status, "incomplete");
  assert.equal(cost.usage?.unmetered?.length, 1);
});

test("streamed model usage is actually metered and interrupted streams remain visible", async (t) => {
  const { createOpenAiModel } = await import("../server/providers/openai");
  const { env } = await import("../lib/env");
  const previous = env.OPENAI_API_KEY;
  env.OPENAI_API_KEY = "test-key";
  t.after(() => { env.OPENAI_API_KEY = previous; });
  const meter = new UsageMeter();
  const model = createOpenAiModel(() => ({ chat: { completions: { create: async () => (async function* () {
    yield { id: "request-stream", choices: [{ delta: { content: "Hello" } }] };
    yield { id: "request-stream", choices: [], usage: { prompt_tokens: 90, completion_tokens: 5, total_tokens: 95, prompt_tokens_details: { cached_tokens: 10 } } };
  })() } } }) as any);
  for await (const _chunk of model.stream({ messages: [{ role: "user", content: "Hi" }], model: "gpt-4o", temperature: 0, trace: { usage: meter, log: () => {} } }, new AbortController().signal)) { /* consume */ }
  assert.equal(meter.snapshot().llm[0].prompt, 90);
  assert.equal(meter.snapshot().llm[0].cached, 10);
  assert.equal(meter.snapshot().llm[0].estimatedRequests, 0);
  const interrupted = new UsageMeter();
  const stream = model.stream({ messages: [{ role: "user", content: "Hi" }], model: "gpt-4o", temperature: 0, trace: { usage: interrupted, log: () => {} } }, new AbortController().signal);
  for await (const _chunk of stream) break;
  assert.equal(interrupted.snapshot().llm[0].estimatedRequests, 1);
  assert.equal(interrupted.snapshot().llm[0].completion, 2);
});

test("reconciliation retries missing provider usage without overwriting known duration with zero", async () => {
  const { reconcileCallCost } = await import("../server/billing/reconcile");
  const record = { id: "CA1", sid: "CA1", agentId: "A1", assistantId: "A1", type: "outboundPhoneCall" as const, direction: "outbound" as const, from: "+15555550101", to: facts.to, status: "completed" as const, updatedAt: 1000, createdAt: "2026-01-01T00:00:00Z", startedAt: "2026-01-01T00:00:00Z", endedAt: "2026-01-01T00:01:01Z" };
  const result = await reconcileCallCost({ record, usage: undefined, getProviderUsage: async () => ({ duration: null, price: null, priceUnit: null }), rates: defaultRates, hosting, amd: false });
  assert.equal(result.cost.durationSec, 61);
  assert.equal(result.cost.status, "incomplete");
  assert.equal(result.cost.reconciliationStatus, "pending");
  assert.equal(result.retryReasons.length, 2);
});

test("reconciliation replaces pending provider price and separates transfer totals", async () => {
  const { reconcileCallCost } = await import("../server/billing/reconcile");
  const record = { id: "CA1", sid: "CA1", agentId: "A1", assistantId: "A1", type: "outboundPhoneCall" as const, direction: "outbound" as const, from: "+15555550101", to: facts.to, status: "completed" as const, updatedAt: 1000, createdAt: "2026-01-01T00:00:00Z", startedAt: "2026-01-01T00:00:00Z", endedAt: "2026-01-01T00:01:01Z" };
  const usage = new UsageMeter();
  usage.addLlm("gpt-4o", { promptTokens: 100, completionTokens: 10, cachedTokens: 0 });
  const childCost = priceCall(new UsageMeter(), facts, defaultRates, hosting);
  childCost.reconciliationStatus = "complete";
  const child = { ...record, id: "CA2", sid: "CA2", parentCallSid: "CA1", cost: childCost };
  const result = await reconcileCallCost({ record, usage: usage.snapshot(), getProviderUsage: async () => ({ duration: "61", price: "-0.123", priceUnit: "USD" }), children: [child, child], rates: defaultRates, hosting, amd: false });
  assert.equal(result.retryReasons.length, 0);
  assert.equal(result.cost.reconciliationStatus, "complete");
  assert.equal(result.cost.relatedCalls?.length, 1);
  assert.equal(result.cost.lines.find((line) => line.item === "Voice (outbound)")?.usd, 0.123);
  assert.equal(result.cost.totalWithRelatedUsd, Number((result.cost.totalUsd + childCost.totalUsd).toFixed(8)));
});

test("shared pricing rejects negative and non-finite overrides instead of masking billing errors", async () => {
  const { mergeRates } = await import("../server/billing/pricing");
  assert.throws(() => mergeRates(defaultRates, { twilio: { outboundPerMin: -1 } }));
  assert.throws(() => mergeRates(defaultRates, { deepgram: { custom: Infinity } }));
  assert.throws(() => mergeRates(defaultRates, { openai: { custom: { input: 1 } } }));
  assert.equal(mergeRates(defaultRates, { twilio: { recordingPerMin: 0.0025 } }).twilio.recordingPerMin, 0.0025);
  assert.equal(mergeRates(defaultRates, { openai: { "gpt-4o": { input: 3 } } }).openai["gpt-4o"].output, 10);
});

test("recording and conference charges cannot disappear from the known subtotal", () => {
  const incomplete = priceCall(new UsageMeter(), { ...facts, recordingDurationSec: 61, conference: true }, defaultRates, hosting);
  assert.equal(incomplete.status, "incomplete");
  assert.equal(incomplete.lines.find((line) => line.item === "Call recording")?.usd, null);
  assert.equal(incomplete.lines.find((line) => line.item === "Transfer conference")?.usd, null);
  const priced = priceCall(new UsageMeter(), { ...facts, recordingDurationSec: 61 }, { ...defaultRates, twilio: { ...defaultRates.twilio, recordingPerMin: 0.0025 } }, hosting);
  assert.equal(priced.lines.find((line) => line.item === "Call recording")?.usd, 0.005);
});

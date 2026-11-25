import { test } from "node:test";
import assert from "node:assert/strict";
import { OpeningPreparation, PreparedOpening, speechCacheKey } from "../server/speech/preparation";
import { AudioCache } from "../server/speech/audio-cache";
import { CallTrace } from "../server/observability/trace";
import type { SynthesizerFactory } from "../server/core/ports";
import { agent, harness, tick, until } from "./helpers";

const fixed = () => agent({ firstMessageMode: "assistant-speaks-first", firstMessage: "Welcome to Acme." });

test("pre-dial greeting replays immediately without a new TTS connection or model request and preserves measured usage", async (t) => {
  const a = fixed();
  let connections = 0, models = 0;
  const synthesize: SynthesizerFactory = (_v, audio, voice, _format, trace) => {
    connections++;
    return { push: async text => { trace?.usage?.addTts(voice!.model, text.length); audio(Buffer.alloc(160, 255).toString("base64")); }, end: async () => {}, close: () => {} };
  };
  const preparation = new OpeningPreparation(synthesize);
  t.after(() => preparation.close());
  preparation.start("request", a);
  await tick();
  const trace = new CallTrace("call");
  preparation.bind("request", "call", trace);
  preparation.bind("request", "call", trace);
  const h = harness({ agent: a, trace, preparedOpening: preparation.take("call") }, { synthesize, model: { async *stream() { models++; }, complete: async () => "" } });
  t.after(() => h.session.close());
  await until(() => h.sent.some((m: any) => m.event === "media"));
  assert.equal(connections, 1);
  assert.equal(models, 0);
  assert.equal(trace.usage.snapshot().voice[0].characters, a.firstMessage.length);
  assert.equal(preparation.take("call"), undefined);
  assert.ok(trace.view().events.some(e => e.event === "speech.cache_hit"));
});

test("in-flight preparation streams already available audio before synthesis finishes", async (t) => {
  let finish!: () => void, connections = 0;
  const done = new Promise<void>(resolve => { finish = resolve; });
  const a = fixed();
  const prepared = new PreparedOpening(a, (_v, audio) => {
    connections++;
    return { push: async () => { audio(Buffer.alloc(160, 255).toString("base64")); }, end: () => done, close: () => {} };
  });
  const h = harness({ agent: a, preparedOpening: prepared }, { synthesize: () => { throw new Error("Should reuse prepared synthesis"); } });
  t.after(() => { finish(); h.session.close(); });
  await until(() => h.sent.some((m: any) => m.event === "media"));
  assert.equal(connections, 1);
  assert.equal(h.sent.some((m: any) => m.event === "mark"), false);
  finish();
  await until(() => h.sent.some((m: any) => m.event === "mark"));
});

test("prepared opening respects configured wait and is cancelled on close", async (t) => {
  const a = fixed();
  a.startSpeakingPlan.waitSeconds = 0.2;
  let closed = 0;
  const prepared = new PreparedOpening(a, (_v, audio) => ({ push: async () => { audio(Buffer.alloc(160, 255).toString("base64")); }, end: () => new Promise(() => {}), close: () => { closed++; } }));
  const h = harness({ agent: a, preparedOpening: prepared });
  t.after(() => h.session.close());
  await tick();
  assert.equal(h.sent.some((m: any) => m.event === "media"), false);
  h.session.close();
  await assert.rejects(prepared.done, /cancelled/);
  assert.equal(closed, 1);
  assert.equal(h.sent.some((m: any) => m.event === "media"), false);
});

test("failed preparation falls back to the configured greeting", async (t) => {
  const a = fixed();
  const prepared = new PreparedOpening(a, () => ({ push: async () => { throw new Error("Unavailable"); }, end: async () => {}, close: () => {} }));
  await assert.rejects(prepared.done);
  const h = harness({ agent: a, preparedOpening: prepared });
  t.after(() => h.session.close());
  await until(() => h.spoken.length === 1);
  assert.deepEqual(h.spoken, [a.firstMessage]);
});

test("preparation skips waiting/generated modes and scopes cached audio by assistant, voice and format", () => {
  let connected = 0;
  const prep = new OpeningPreparation(() => { connected++; throw new Error("Unexpected synthesis"); });
  prep.start("waiting", agent());
  prep.start("generated", agent({ firstMessageMode: "assistant-speaks-first-with-model-generated-message" }));
  assert.equal(connected, 0);
  const a = fixed(), b = fixed();
  assert.notEqual(speechCacheKey(a, a.firstMessage), speechCacheKey(b, b.firstMessage));
  assert.notEqual(speechCacheKey(a, a.firstMessage), speechCacheKey(a, a.firstMessage, { encoding: "pcm_s16le", sampleRate: 24000 }));
  const cache = new AudioCache(2, 16);
  cache.set("a", ["1234"]);
  cache.set("b", ["5678"]);
  cache.get("a");
  cache.set("c", ["9012"]);
  assert.equal(cache.get("b"), undefined);
  cache.set("huge", ["x".repeat(100)]);
  assert.equal(cache.get("huge"), undefined);
});

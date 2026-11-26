import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import Redis from "ioredis";
import { ContextStore } from "../server/store/contexts";
import { ArtifactQueue, RedisCallState, RedisContextBackend, redisConnection } from "../server/storage/redis";
import { agent } from "./helpers";

const url = process.env.TEST_REDIS_URL ?? process.env.REDIS_TEST_URL;
const integration = { skip: !url && "Set TEST_REDIS_URL to run against a disposable Redis database." };

test("keypad reconnect transfers a lease atomically at full call capacity", integration, async t => {
  const { redis, second, prefix } = await fixture(t);
  const state = new RedisCallState(redis, `${prefix}:{calls}`);
  const other = new RedisCallState(second, `${prefix}:{calls}`);
  assert.equal(await state.reserve("old-stream", 1), true);
  assert.equal(await other.reserve("unrelated", 1), false);
  assert.equal(await other.reserve("new-stream", 1, 120_000, "old-stream"), true);
  await state.release("old-stream");
  assert.equal(await state.activeCount(), 1);
  assert.equal(await state.reserve("unrelated", 1), false);
  await other.release("new-stream");
  assert.equal(await state.reserve("unrelated", 1), true);
});
async function fixture(t: TestContext) {
  const redis = new Redis(url!, { maxRetriesPerRequest: 1 });
  const second = new Redis(url!, { maxRetriesPerRequest: 1 });
  const prefix = `test-${randomUUID()}`;
  await redis.ping();
  t.after(async () => {
    // Remove only this test's unique namespace.
    let cursor = "0";
    do {
      const result = await redis.scan(cursor, "MATCH", `${prefix}*`, "COUNT", 1000);
      cursor = result[0];
      if (result[1].length) await redis.del(...result[1]);
    } while (cursor !== "0");
    await Promise.all([redis.quit(), second.quit()]);
  });
  return { redis, second, prefix };
}
async function until(predicate: () => boolean, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for Redis worker.");
    await delay(10);
  }
}

test("Redis contexts are shared, bound atomically, consumed once, and expire", integration, async (t) => {
  const { redis, second, prefix } = await fixture(t);
  const first = new ContextStore(new RedisContextBackend(redis, `${prefix}:{contexts}`, 1000));
  const other = new ContextStore(new RedisContextBackend(second, `${prefix}:{contexts}`, 1000));
  const context = { agent: agent(), tools: [], brief: "initial", direction: "inbound" as const, purpose: "conversation" as const };
  await first.setAsync("c1", context);
  context.brief = "local mutation";
  assert.equal((await other.getAsync("c1"))?.brief, "initial");
  assert.throws(() => first.get("c1"), /asynchronous/);
  const bindings = await Promise.all([first.bindAsync("c1", "CA-one"), other.bindAsync("c1", "CA-two")]);
  assert.equal(bindings.filter(Boolean).length, 1);
  const sid = bindings[0] ? "CA-one" : "CA-two";
  assert.equal(await other.idForSidAsync(sid), "c1");
  assert.equal(await first.bindAsync("c1", sid), true);
  assert.deepEqual((await other.getAsync("c1"))?.tools, []);
  assert.equal(await first.updatePurposeAsync("c1", "voicemail"), true);
  assert.equal((await other.getAsync("c1"))?.purpose, "voicemail");
  assert.equal(await first.takeAsync("c1", "wrong-call"), undefined);
  const takes = await Promise.all([first.takeAsync("c1", sid), other.takeAsync("c1", sid)]);
  assert.equal(takes.filter(Boolean).length, 1);
  assert.deepEqual(takes.find(Boolean)?.tools, []);
  assert.equal(await first.idForSidAsync(sid), undefined);
  await first.setAsync("expiring", { ...context, sid: "CA-expire" });
  await delay(1100);
  assert.equal(await other.getAsync("expiring"), undefined);
  assert.equal(await other.idForSidAsync("CA-expire"), undefined);
});

test("Redis enforces shared rate and capacity limits under concurrent clients", integration, async (t) => {
  const { redis, second, prefix } = await fixture(t);
  const first = new RedisCallState(redis, prefix);
  const other = new RedisCallState(second, prefix);
  const limits = await Promise.all(Array.from({ length: 40 }, (_, i) => (i % 2 ? first : other).rateLimit("calls", 10, 1000)));
  assert.equal(limits.filter((result) => result.allowed).length, 10);
  assert.ok(limits.every((result) => result.retryAfterMs > 0));
  const leases = await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? first : other).reserve(`call-${i}`, 2, 1000)));
  assert.equal(leases.filter(Boolean).length, 2);
  const existing = leases.findIndex(Boolean);
  assert.equal(await other.reserve(`call-${existing}`, 2, 1000), true);
  assert.equal(await first.activeCount(), 2);
  await other.release(`call-${existing}`);
  assert.equal(await first.reserve("replacement", 2, 1000), true);
  await first.setLiveCall("CA-live", { contextId: "new", status: "in-progress" });
  await other.removeLiveCall("CA-live", "old");
  assert.equal((await first.getLiveCall("CA-live"))?.contextId, "new");
  await other.removeLiveCall("CA-live", "new");
  assert.equal(await first.getLiveCall("CA-live"), undefined);
  await delay(1100);
  assert.equal(await first.activeCount(), 0);
});

test("Artifact jobs survive producer restart, deduplicate, retry and accept revisions", integration, async (t) => {
  const { prefix } = await fixture(t);
  const producer = new ArtifactQueue(url!, undefined, { prefix });
  await producer.ready();
  await producer.enqueue("CA-artifact", "one");
  await producer.enqueue("CA-artifact", "one");
  await producer.close();
  let attempts = 0;
  const done: string[] = [];
  const worker = new ArtifactQueue(url!, async (job) => {
    attempts++;
    if (attempts === 1) throw new Error("Temporary object-store outage");
    done.push(`${job.sid}:${job.revision}`);
  }, { prefix });
  t.after(() => worker.close());
  await worker.ready();
  await until(() => done.length === 1);
  assert.equal(attempts, 2);
  assert.deepEqual(done, ["CA-artifact:one"]);
  await worker.enqueue("CA-artifact", "one");
  await worker.enqueue("CA-artifact", "two", 100);
  await until(() => done.length === 2);
  assert.equal(attempts, 3);
  assert.deepEqual(done, ["CA-artifact:one", "CA-artifact:two"]);
});

test("Redis URL parsing preserves TLS, database and encoded credentials", () => {
  const connection = redisConnection("rediss://app:token%40value@localhost:6380/3") as { tls: unknown; db: number; password: string; port: number };
  assert.ok(connection.tls);
  assert.equal(connection.db, 3);
  assert.equal(connection.password, "token@value");
  assert.equal(connection.port, 6380);
  assert.throws(() => redisConnection("https://localhost"), /redis/);
  assert.throws(() => redisConnection("redis://localhost/-1"), /database/);
});

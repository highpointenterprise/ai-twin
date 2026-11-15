import test from "node:test";
import assert from "node:assert/strict";
import { PendingWrites } from "../server/storage/pending";
test("failed storage writes are retried and retained until durable acknowledgement", async () => {
  const pending = new PendingWrites();
  let available = false,
    saved = 0;
  pending.enqueue(async () => {
    if (!available) throw new Error("offline");
    saved++;
  });
  await assert.rejects(pending.flush(), /retained for retry/);
  available = true;
  await pending.flush();
  assert.equal(saved, 1);
  await pending.flush();
  assert.equal(saved, 1);
});
test("draining concurrent callers does not replay successful writes", async () => {
  const pending = new PendingWrites(),
    order: number[] = [];
  for (let n = 0; n < 10; n++)
    pending.enqueue(async () => {
      order.push(n);
    });
  await Promise.all([pending.flush(), pending.flush()]);
  assert.deepEqual(
    order,
    Array.from({ length: 10 }, (_, n) => n),
  );
});

test("an outage preserves operation order when older writes are retried", async () => {
  const pending = new PendingWrites();
  let online = false;
  const order: number[] = [];
  pending.enqueue(async () => {
    if (!online) throw new Error("offline");
    order.push(1);
  });
  pending.enqueue(async () => {
    order.push(2);
  });
  await assert.rejects(pending.flush());
  assert.deepEqual(order, []);
  online = true;
  await pending.flush();
  assert.deepEqual(order, [1, 2]);
});

import test from "node:test";
import assert from "node:assert/strict";
import { CallRegistry } from "../server/store/calls";
import type { MongoCallRepository } from "../server/storage/calls";

test("callbacks persist patches even when this replica has no cached call", async () => {
  const patches: { sid: string; fields: unknown }[] = [];
  const repository = {
    async patch(sid: string, fields: unknown) { patches.push({ sid, fields }); },
  } as unknown as MongoCallRepository;
  const registry = new CallRegistry(undefined, repository);
  const fields = { transferStatus: "completed", endedReason: "transfer-completed" };
  registry.patch("CA-other-replica", fields);
  fields.transferStatus = "changed after enqueue";
  await registry.flush();
  assert.deepEqual(patches, [{ sid: "CA-other-replica", fields: { transferStatus: "completed", endedReason: "transfer-completed" } }]);
  assert.equal(registry.get("CA-other-replica"), undefined);
});

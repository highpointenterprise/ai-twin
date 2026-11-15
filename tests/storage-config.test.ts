import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { MongoClient } from "mongodb";
import { assistantSchema, toolSchema } from "../lib/config";
import { configPageLimit, MongoAgentStore, MongoToolRegistry } from "../server/storage/config";

const seed = assistantSchema.parse({ name: "Initial assistant", systemPrompt: "Help callers." });
const toolInput = (name: string) => toolSchema.parse({ type: "dtmf", name, description: "Dial keypad tones" });

test("configuration pagination rejects invalid and unbounded requests", () => {
  assert.equal(configPageLimit(), 100);
  assert.equal(configPageLimit({ limit: 1000 }), 1000);
  for (const limit of [0, -1, 1001, NaN, 1.5])
    assert.throws(() => configPageLimit({ limit }), /Page limit/);
});

test("Mongo configuration is durable and consistent between replicas", { skip: !process.env.TEST_MONGODB_URI }, async (t) => {
  const client = await new MongoClient(process.env.TEST_MONGODB_URI!, { serverSelectionTimeoutMS: 5000, writeConcern: { w: "majority" } }).connect();
  const db = client.db(`config_test_${randomUUID().replaceAll("-", "")}`);
  t.after(async () => { await db.dropDatabase(); await client.close(); });
  const first = new MongoAgentStore(db, "org-one"), second = new MongoAgentStore(db, "org-one");
  const tools = new MongoToolRegistry(db, "org-one"), otherTools = new MongoToolRegistry(db, "org-two");
  await Promise.all([first.initialize(seed), second.initialize(seed), tools.initialize(), otherTools.initialize()]);
  assert.equal((await first.list()).length, 1, "concurrent startups create one default assistant");

  await t.test("acknowledged CRUD and assignments survive a new repository instance", async () => {
    const created = await first.create({ ...seed, name: "Created on replica one" });
    assert.equal((await second.get(created.id)).name, created.name);
    await second.update(created.id, { ...seed, name: "Changed on replica two" });
    assert.equal((await first.get(created.id)).name, "Changed on replica two");
    await first.assign("+14155550123", created.id);
    assert.equal((await second.agentForNumber("+14155550123"))?.id, created.id);
    assert.equal(await second.numberForAgent(created.id), "+14155550123");
    const stored = await db.collection("assistants").findOne({ orgId: "org-one", id: created.id });
    assert.equal(typeof stored?.createdAt, "string");
    assert.equal(typeof stored?.updatedAt, "string");
    assert.ok(!("_id" in created));
    await assert.rejects(first.assign("invalid", created.id));
    await assert.rejects(first.assign("+14155550124", "missing"), /Agent not found/);
  });

  await t.test("org scope prevents reads and assignments crossing organizations", async () => {
    const isolated = new MongoAgentStore(db, "org-two");
    await isolated.initialize();
    const [existing] = await first.list();
    assert.equal(await isolated.find(existing.id), undefined);
    assert.equal(await isolated.agentForNumber("+14155550123"), undefined);
    await assert.rejects(isolated.update(existing.id, seed), /Agent not found/);
    await assert.rejects(isolated.assign("+14155550123", existing.id), /Agent not found/);
  });

  await t.test("stable pagination neither repeats nor skips records", async () => {
    const all = await first.list();
    const firstPage = await first.list({ limit: 1 });
    const secondPage = await first.list({ limit: 1, after: firstPage[0].id });
    assert.deepEqual([...firstPage, ...secondPage].map((a) => a.id), all.map((a) => a.id));
    await assert.rejects(first.list({ limit: 0 }), /Page limit/);
  });

  await t.test("unique tool names are enforced atomically across concurrent writes", async () => {
    const outcomes = await Promise.allSettled([tools.save(toolInput("send_digits")), tools.save(toolInput("send_digits"))]);
    assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected") as PromiseRejectedResult;
    assert.equal(rejected.reason.status, 409);
    await otherTools.save(toolInput("send_digits"));
    const [saved] = await tools.list();
    assert.equal((await tools.resolve([saved.id]))[0].name, "send_digits");
    await assert.rejects(otherTools.get(saved.id), /Tool not found/);
  });

  await t.test("tool resolution preserves caller order and replacement removes old type fields", async () => {
    const a = await tools.save(toolInput("dial_one"));
    const b = await tools.save(toolInput("dial_two"));
    assert.deepEqual((await tools.resolve([b.id, a.id])).map((tool) => tool.id), [b.id, a.id]);
    await assert.rejects(tools.resolve([a.id, "missing"]), /Tool not found/);
    const functionTool = toolSchema.parse({ type: "function", name: "dial_one", description: "A custom action", parameters: { type: "object" }, server: { url: "https://example.com/action" } });
    await tools.save(functionTool, a.id);
    const replaced = await tools.get(a.id);
    assert.equal(replaced.type, "function");
    assert.ok(!("toneDurationMs" in replaced));
    const [assistant] = await first.list();
    await first.update(assistant.id, { ...assistant, toolIds: [a.id] });
    assert.equal(await second.usesTool(a.id), true);
    assert.equal(await second.usesTool(b.id), false);
    await tools.delete(b.id);
    await assert.rejects(tools.get(b.id), /Tool not found/);
    await assert.rejects(tools.delete(b.id), /Tool not found/);
  });

  await t.test("invalid function schema fails before a write", async () => {
    const invalid = toolSchema.parse({ type: "function", name: "bad_function", description: "Invalid schema", parameters: { type: "object", properties: { item: { type: "unknown_type" } } }, server: { url: "https://example.com/action" } });
    await assert.rejects(tools.save(invalid), /Invalid function parameters/);
    assert.equal(await db.collection("tools").countDocuments({ name: "bad_function" }), 0);
  });
});

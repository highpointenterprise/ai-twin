import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { MongoClient } from "mongodb";
import { assistantSchema } from "../lib/config";
import { TwilioCredentialStore } from "../server/store/twilio-credentials";
import { MongoTwilioCredentialStore } from "../server/storage/credentials";

const uri = process.env.TEST_MONGODB_URI ?? process.env.MONGODB_TEST_URI;
test("legacy migration is insert-only, retains source files and imports encrypted credentials", { skip: !uri }, async () => {
  const client = new MongoClient(uri!);
  await client.connect();
  const database = `migration_test_${randomUUID().replaceAll("-", "")}`;
  const source = await mkdtemp(join(tmpdir(), "ai-twin-migration-"));
  const key = randomBytes(32).toString("hex");
  const agent = { ...assistantSchema.parse({ name: "Legacy assistant", systemPrompt: "You are helpful." }), id: randomUUID() };
  const sid = `CA${"1".repeat(32)}`;
  const credentials = { accountSid: `AC${"2".repeat(32)}`, authToken: "3".repeat(32) };
  const assistants = JSON.stringify({ agents: [agent], assignments: [["+14155551234", agent.id]] });
  try {
    await writeFile(join(source, "assistants.json"), assistants);
    await writeFile(join(source, "pricing.json"), JSON.stringify({ twilio: { outboundPerMin: 0.1 } }));
    await writeFile(join(source, "calls.json"), JSON.stringify([{ sid, agentId: agent.id, direction: "inbound", from: "+14155551235", to: "+14155551234", status: "in-progress", updatedAt: 1700000000000 }]));
    await writeFile(join(source, "costs.jsonl"), JSON.stringify({ sid, at: "2023-11-14T22:13:20.000Z", totalUsd: 0.1, lines: [], warnings: [] }) + "\n");
    await mkdir(join(source, "logs"));
    await writeFile(join(source, "logs", "voice-agent.jsonl"), JSON.stringify({ at: 1700000000000, scope: sid, event: "transcript.caller", detail: { text: "Hello" } }) + "\n");
    new TwilioCredentialStore(source).save(credentials);
    const run = () => promisify(execFile)(resolve("node_modules/.bin/tsx"), ["scripts/migrate-storage.ts", source], {
      env: { ...process.env, MONGODB_URI: uri!, MONGODB_DATABASE: database, CREDENTIAL_ENCRYPTION_KEY: key },
    });
    await run();
    const db = client.db(database);
    await db.collection("assistants").updateOne({ id: agent.id }, { $set: { name: "Changed after import" } });
    await run();
    assert.equal(await db.collection("assistants").countDocuments(), 1);
    assert.equal((await db.collection("assistants").findOne({ id: agent.id }))?.name, "Changed after import");
    assert.equal(await db.collection("phone_numbers").countDocuments(), 1);
    assert.equal(await db.collection("calls").countDocuments(), 1);
    assert.equal((await db.collection("calls").findOne({ sid }))?.endedReason, "legacy-import-interrupted");
    assert.equal(await db.collection("call_events").countDocuments(), 1);
    assert.equal(await db.collection("call_transcripts").countDocuments(), 1);
    assert.equal(await db.collection("legacy_cost_ledger").countDocuments(), 1);
    assert.equal(await db.collection("billing_pricing").countDocuments(), 1);
    assert.equal(await readFile(join(source, "assistants.json"), "utf8"), assistants);
    const saved = new MongoTwilioCredentialStore(db, key);
    await saved.initialize();
    assert.deepEqual(saved.load(), credentials);
    assert.equal(JSON.stringify(await db.collection("providerCredentials").findOne({ provider: "twilio" })).includes(credentials.authToken), false);
  } finally {
    await client.db(database).dropDatabase();
    await client.close();
    await rm(source, { recursive: true, force: true });
  }
});

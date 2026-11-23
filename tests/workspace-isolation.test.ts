import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MongoClient } from "mongodb";
import Redis from "ioredis";
import twilio from "twilio";
import { MongoTwilioCredentialStore } from "../server/storage/credentials";
import { AuthStore } from "../server/auth/store";
import { WorkspacePool } from "../server/workspaces/pool";
import { createWorkspaceGateway } from "../server/workspaces/gateway";
import { workspaceEnvironment, workspaceIdentity } from "../server/workspaces/identity";
import { MongoCallRepository } from "../server/storage/calls";
import { ApiKeyDirectory } from "../server/api/v1/auth/key-directory";
import { ApiKeyStore } from "../server/api/v1/auth/api-keys";
import { ObjectStore } from "../server/storage/objects";

const secret = randomBytes(32).toString("hex");
test("compact workspace databases fit Atlas limits without changing other namespaces", () => {
  const user = randomUUID();
  const base = { NODE_ENV: "test" as const, AUTH_API_SECRET: secret, CREDENTIAL_ENCRYPTION_KEY: secret, MONGODB_DATABASE: "ai_twin" };
  const legacy = workspaceEnvironment(user, base);
  const compact = workspaceEnvironment(user, { ...base, WORKSPACE_DATABASE_FORMAT: "compact" });
  assert.match(legacy.MONGODB_DATABASE!, /^workspace_[a-f0-9]{40}$/);
  assert.ok(Buffer.byteLength(compact.MONGODB_DATABASE!) <= 38);
  assert.match(compact.MONGODB_DATABASE!, /^ws_[A-Za-z0-9_-]{27}$/);
  assert.equal(Buffer.from(compact.MONGODB_DATABASE!.slice(3), "base64url").toString("hex"), legacy.MONGODB_DATABASE!.slice(10));
  for (const key of ["REDIS_PREFIX", "DATA_DIR", "STREAM_SECRET", "CREDENTIAL_ENCRYPTION_KEY", "OBJECT_PREFIX"]) assert.equal(compact[key], legacy[key]);
  assert.notEqual(compact.MONGODB_DATABASE, workspaceIdentity(randomUUID(), { ...base, WORKSPACE_DATABASE_FORMAT: "compact" }).database);
  assert.notEqual(compact.MONGODB_DATABASE, workspaceIdentity(user, { ...base, MONGODB_DATABASE: "other", WORKSPACE_DATABASE_FORMAT: "compact" }).database);
});
test("workspace identities isolate storage, signing keys, credentials and browser profiles", async () => {
  const base = { ...process.env, AUTH_API_SECRET: secret, CREDENTIAL_ENCRYPTION_KEY: secret, MONGODB_DATABASE: "legacy", TWILIO_AUTH_TOKEN: "legacy-secret", TOOL_CRM_TOKEN: "legacy-tool", MEET_GOOGLE_STORAGE_STATE_PATH: "legacy-profile" };
  const a = workspaceEnvironment(randomUUID(), base), b = workspaceEnvironment(randomUUID(), base);
  for (const key of ["MONGODB_DATABASE", "REDIS_PREFIX", "DATA_DIR", "STREAM_SECRET", "CREDENTIAL_ENCRYPTION_KEY", "OBJECT_PREFIX"]) assert.notEqual(a[key], b[key]);
  for (const key of ["TWILIO_AUTH_TOKEN", "TOOL_CRM_TOKEN"]) assert.equal(a[key], undefined);
  assert.equal(a.MEET_GOOGLE_STORAGE_STATE_PATH, "");
  assert.throws(() => workspaceEnvironment("../../legacy", base));
  const objects = new ObjectStore({ endpoint: "http://127.0.0.1:1", region: "auto", bucket: "test", accessKeyId: "x", secretAccessKey: "x", prefix: a.OBJECT_PREFIX });
  await assert.rejects(objects.signedUrl(`${b.OBJECT_PREFIX}calls/test/logs.jsonl`), /different workspace/);
  objects.close();
});

test("two real workspace workers reject cross-account resource IDs and keep legacy data quarantined", { skip: !process.env.TEST_MONGODB_URI || !process.env.TEST_REDIS_URL, timeout: 100_000 }, async (t) => {
  const client = await new MongoClient(process.env.TEST_MONGODB_URI!).connect();
  const database = `isolation_${randomUUID().replaceAll("-", "")}`;
  const db = client.db(database);
  const directory = await mkdtemp(join(tmpdir(), "isolation-"));
  const s3 = createServer((req, res) => { res.writeHead(req.method === "HEAD" ? 200 : 503); res.end(); }).listen(0, "127.0.0.1");
  await new Promise<void>(resolve => s3.once("listening", resolve));
  const base = {
    ...process.env, NODE_ENV: "production" as const, WORKSPACE_DATABASE_FORMAT: "compact", MONGODB_URI: process.env.TEST_MONGODB_URI!, MONGODB_DATABASE: database,
    PUBLIC_BASE_URL: "https://calls.example.com",
    REDIS_URL: process.env.TEST_REDIS_URL!, DATA_DIR: directory, AUTH_API_SECRET: secret, CREDENTIAL_ENCRYPTION_KEY: secret,
    S3_ENDPOINT: `http://127.0.0.1:${(s3.address() as { port: number }).port}`, S3_BUCKET: "test", S3_REGION: "us-east-1", S3_FORCE_PATH_STYLE: "true", S3_ACCESS_KEY_ID: "test", S3_SECRET_ACCESS_KEY: "test",
    TWILIO_ACCOUNT_SID: "AC" + "1".repeat(32), TWILIO_AUTH_TOKEN: "legacy-secret", OPENAI_API_KEY: "", DEEPGRAM_API_KEY: "", ELEVENLABS_API_KEY: "",
  };
  const auth = new AuthStore(db); await auth.initialize();
  const users = await Promise.all(["a", "b"].map(name => auth.signup({ name, email: `${name}@example.com`, password: "test-password-long" })));
  const sessions = await Promise.all(users.map(u => auth.login(u.email, "test-password-long")));
  await db.collection("assistants").insertOne({ id: "legacy-assistant", orgId: "default", name: "Private legacy data" });
  const meetingId = randomUUID();
  const aIdentity = workspaceIdentity(users[0].id, base);
  await mkdir(aIdentity.directory, { recursive: true });
  await writeFile(join(aIdentity.directory, "meetings.json"), JSON.stringify([{ id: meetingId, phase: "ended", updatedAt: Date.now(), secret: "A only" }]));
  const pool = new WorkspacePool(db, base);
  const apps = createWorkspaceGateway(auth, secret, pool, new ApiKeyDirectory(db));
  const admin = apps.admin.listen(0, "127.0.0.1"), pub = apps.publicApp.listen(0, "127.0.0.1");
  await Promise.all([admin, pub].map(s => new Promise<void>(resolve => s.once("listening", resolve))));
  const url = `http://127.0.0.1:${(admin.address() as { port: number }).port}`;
  const publicUrl = `http://127.0.0.1:${(pub.address() as { port: number }).port}`;
  const req = (user: number, path: string, method = "GET", body?: unknown) => fetch(url + path, {
    method, headers: { Authorization: `Bearer ${sessions[user]!.token}`, "Content-Type": "application/json", "x-user-id": users[1 - user].id },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  t.after(async () => {
    admin.closeAllConnections(); pub.closeAllConnections(); admin.close(); pub.close();
    await pool.close(); s3.close();
    const redis = new Redis(process.env.TEST_REDIS_URL!);
    for (const user of users) {
      const identity = workspaceIdentity(user.id, base);
      await client.db(identity.database).dropDatabase();
      const keys = await redis.keys(`${identity.prefix}:*`); if (keys.length) await redis.del(...keys);
    }
    await redis.quit(); await db.dropDatabase(); await client.close(); await rm(directory, { recursive: true, force: true });
  });
  for (const n of [0, 1]) {
    const response = await req(n, "/api/agents"); assert.equal(response.status, 200); assert.deepEqual(await response.json(), []);
    assert.equal((await (await req(n, "/api/health")).json()).twilio.configured, false);
  }
  const issuedResponse = await req(0, "/api/api-keys", "POST", { name: "Root API" });
  assert.equal(issuedResponse.status, 201);
  const issued = await issuedResponse.json();
  assert.equal((await req(1, `/api/api-keys/${issued.id}`, "DELETE")).status, 404);
  const keyInfo = await (await req(0, "/api/api-keys")).json();
  assert.equal(keyInfo.apiBaseUrl, base.PUBLIC_BASE_URL);
  assert.equal(keyInfo.userId, users[0].id);
  const rootCalls = await fetch(`${publicUrl}/call`, { headers: { Authorization: `Bearer ${issued.key}` } });
  assert.equal(rootCalls.status, 200);
  assert.deepEqual(await rootCalls.json(), []);
  assert.equal((await req(0, `/api/api-keys/${issued.id}`, "DELETE")).status, 204);
  assert.equal((await fetch(`${publicUrl}/call`, { headers: { Authorization: `Bearer ${issued.key}` } })).status, 401);
  const agent = await (await req(0, "/api/agents", "POST", { name: "A private assistant", systemPrompt: "Private", server: { url: "https://a.example/webhook" }, userId: users[1].id, orgId: users[1].id })).json();
  assert.equal((await req(1, `/api/agents/${agent.id}`, "PUT", { name: "stolen", systemPrompt: "stolen" })).status, 404);
  assert.deepEqual(await (await req(1, "/api/agents")).json(), []);
  const tool = await (await req(0, "/api/tools", "POST", { name: "private_tool", description: "Private", type: "dtmf", toneDurationMs: 200, gapMs: 100 })).json();
  for (const method of ["PUT", "DELETE"]) assert.equal((await req(1, `/api/tools/${tool.id}`, method, tool)).status, 404);
  assert.equal((await req(1, "/api/agents", "POST", { name: "B", systemPrompt: "B", toolIds: [tool.id] })).status, 404);
  assert.equal((await req(0, `/api/tools/${tool.id}`, "PUT", { ...tool, description: "Updated by A" })).status, 200);
  const calls = new MongoCallRepository(client.db(aIdentity.database));
  await calls.create({ sid: "CA-private-a", agentId: agent.id, from: "+12025550101", to: "+12025550102", direction: "outbound", status: "connected" });
  await calls.appendTranscript("CA-private-a", { role: "caller", at: Date.now(), text: "Private transcript" });
  assert.equal((await req(0, "/api/calls/CA-private-a")).status, 200);
  await client.db(aIdentity.database).collection("call_costs").insertOne({ callId: "CA-private-a", userId: users[0].id, occurredAt: new Date(), cost: { totalUsd: 0.25, reportedUsd: 0.25, durationSec: 60 } });
  assert.equal((await req(0, "/api/billing/calls/CA-private-a")).status, 200);
  assert.equal((await req(1, "/api/billing/calls/CA-private-a")).status, 404);
  const billingQuery = new URLSearchParams({ from: new Date(Date.now() - 86400000).toISOString(), to: new Date(Date.now() + 86400000).toISOString() });
  assert.equal((await (await req(0, `/api/billing/summary?${billingQuery}`)).json()).groups[0].knownSubtotalUsd, 0.25);
  assert.deepEqual((await (await req(1, `/api/billing/summary?${billingQuery}`)).json()).groups, []);
  const aPricing = await (await req(0, "/api/billing/pricing")).json();
  assert.equal((await req(0, "/api/billing/pricing", "PUT", { expectedVersion: aPricing.version, rates: { ...aPricing.rates, elevenlabsCreditUsd: 0.0002 }, hosting: aPricing.hosting, note: "A only" })).status, 200);
  assert.equal((await (await req(1, "/api/billing/pricing")).json()).rates.elevenlabsCreditUsd, undefined);

  assert.deepEqual(await (await req(0, "/api/calls/CA-private-a/server-events")).json(), []);
  assert.equal(agent.server.url, "https://a.example/webhook");
  assert.deepEqual(await (await req(1, "/api/calls")).json(), []);
  for (const path of ["", "/trace", "/usage", "/artifacts/logs", "/transfer", "/server-events", "/recordings", "/artifacts/assistantRecording", "/artifacts/customerRecording", "/artifacts/monoRecording"]) assert.equal((await req(1, `/api/calls/CA-private-a${path}`)).status, 404);
  for (const path of ["end", "storage/retry", "transfer/retry", "server-events/retry", "recordings/retry"]) assert.equal((await req(1, `/api/calls/CA-private-a/${path}`, "POST", {})).status, 404);
  assert.equal((await (await req(0, "/api/meetings")).json()).length, 1);
  assert.deepEqual(await (await req(1, "/api/meetings")).json(), []);
  for (const path of ["", "/trace"]) assert.equal((await req(1, `/api/meetings/${meetingId}${path}`)).status, 404);
  assert.equal((await req(1, `/api/meetings/${meetingId}/end`, "POST", {})).status, 404);
  const keys = new ApiKeyStore(client.db(aIdentity.database), users[0].id); await keys.initialize();
  const key = await keys.issue("A only");
  assert.equal((await fetch(`${publicUrl}/workspaces/${users[0].id}/assistant`, { headers: { Authorization: `Bearer ${key.key}` } })).status, 200);
  assert.equal((await fetch(`${publicUrl}/workspaces/${users[1].id}/assistant`, { headers: { Authorization: `Bearer ${key.key}` } })).status, 401);
  assert.equal((await db.collection("assistants").findOne({ id: "legacy-assistant" }))!.name, "Private legacy data");
  assert.equal((await req(0, `/api/agents/${agent.id}`, "PUT", { name: "A updated", systemPrompt: "Private" })).status, 200);
  assert.equal((await req(0, `/api/tools/${tool.id}`, "DELETE")).status, 204);
  const trace = await (await req(0, "/api/calls/CA-private-a/trace")).json();
  assert.equal(trace.transcript[0].text, "Private transcript");
  const aEnvironment = workspaceEnvironment(users[0].id, base);
  const credentials = new MongoTwilioCredentialStore(client.db(aIdentity.database), aEnvironment.CREDENTIAL_ENCRYPTION_KEY!);
  await credentials.initialize();
  await credentials.save({ accountSid: "AC" + "2".repeat(32), authToken: "a".repeat(32) });
  assert.equal((await (await req(0, "/api/health")).json()).twilio.configured, true);
  assert.equal((await (await req(1, "/api/health")).json()).twilio.configured, false);
  const callback = { CallSid: "CA-private-a", CallStatus: "completed" };
  const signature = twilio.getExpectedTwilioSignature("a".repeat(32), `${base.PUBLIC_BASE_URL}/workspaces/${users[0].id}/twilio/status`, callback);
  assert.equal((await fetch(`${publicUrl}/workspaces/${users[1].id}/twilio/status`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "x-twilio-signature": signature }, body: new URLSearchParams(callback),
  })).status, 403);
  assert.equal((await calls.get("CA-private-a"))!.status, "connected");
  const ports = await pool.get(users[0].id, false);
  assert.equal((await fetch(`http://127.0.0.1:${ports.admin}/api/agents`, { headers: { Authorization: `Bearer ${sessions[1]!.token}` } })).status, 401);
});

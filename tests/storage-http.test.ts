import { createTestAdminApp as createAdminApp } from "./admin-helper";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { MongoClient } from "mongodb";
import { MongoAgentStore, MongoToolRegistry } from "../server/storage/config";
import { MongoCallRepository } from "../server/storage/calls";
import { CallRegistry } from "../server/store/calls";
import { TraceStore } from "../server/observability/trace";
import { SessionPool } from "../server/engine/pool";
import { ContextStore } from "../server/store/contexts";
import { assistantSchema } from "../lib/config";
import { telephony } from "./helpers";

test(
  "HTTP history and complete transcripts survive reconstructing all process caches",
  { skip: !process.env.TEST_MONGODB_URI },
  async () => {
    const client = await new MongoClient(
      process.env.TEST_MONGODB_URI!,
    ).connect();
    const db = client.db(`http_${randomUUID().replaceAll("-", "")}`);
    const calls = new MongoCallRepository(db),
      store = new MongoAgentStore(db),
      tools = new MongoToolRegistry(db);
    try {
      await Promise.all([
        calls.initialize(),
        store.initialize(),
        tools.initialize(),
      ]);
      const assistant = await store.create(
        assistantSchema.parse({
          name: "Persisted",
          systemPrompt: "Help the caller.",
        }),
      );
      const registry = new CallRegistry(undefined, calls),
        traces = new TraceStore(calls);
      registry.create({
        sid: "CA-persisted",
        agentId: assistant.id,
        assistant,
        direction: "inbound",
        from: "+12025550101",
        to: "+12025550102",
        status: "connected",
      });
      const trace = traces.for("CA-persisted");
      trace.say("caller", "This transcript must survive a restart.");
      trace.usage.addLlm("gpt-4.1", {
        promptTokens: 100,
        cachedTokens: 20,
        completionTokens: 50,
      });
      registry.update("CA-persisted", "completed");
      await registry.flush();
      await traces.flush();
      const app = createAdminApp({
        store: new MongoAgentStore(db),
        tools: new MongoToolRegistry(db),
        registry: new CallRegistry(undefined, new MongoCallRepository(db)),
        traces: new TraceStore(calls),
        calls,
        contexts: new ContextStore(),
        pool: new SessionPool(10),
        telephony: telephony(),
        listVoices: async () => [],
        pendingCalls: 0,
      });
      const server = app.listen(0, "127.0.0.1");
      await new Promise<void>((r) => server.once("listening", r));
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      try {
        const history = await (await fetch(`${base}/api/calls`)).json();
        assert.equal(history[0].sid, "CA-persisted");
        const detail = await (
          await fetch(`${base}/api/calls/CA-persisted`)
        ).json();
        assert.equal(detail.status, "completed");
        assert.equal(detail.assistant.name, "Persisted");
        const transcript = await (
          await fetch(`${base}/api/calls/CA-persisted/trace`)
        ).json();
        assert.equal(
          transcript.transcript[0].text,
          "This transcript must survive a restart.",
        );
        const usage = await (
          await fetch(`${base}/api/calls/CA-persisted/usage`)
        ).json();
        assert.ok(usage.usage);
        assert.equal((await fetch(`${base}/api/calls?limit=999`)).status, 400);
      } finally {
        await new Promise<void>((r, e) =>
          server.close((err) => (err ? e(err) : r())),
        );
      }
    } finally {
      await db.dropDatabase();
      await client.close();
    }
  },
);

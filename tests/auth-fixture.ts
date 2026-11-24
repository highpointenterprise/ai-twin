import { randomBytes, randomUUID } from "node:crypto";
import { MongoClient } from "mongodb";
import type { AuthMail } from "../server/auth/mail";
import { AuthStore } from "../server/auth/store";
import { createAuthRouter, requireUser } from "../server/auth/routes";
import { createAdminApp, type HttpDeps } from "../server/http/routes";
import { AgentStore } from "../server/store/agents";
import { ToolRegistry } from "../server/tools/registry";
import { CallRegistry } from "../server/store/calls";
import { ContextStore } from "../server/store/contexts";
import { TraceStore } from "../server/observability/trace";
import { SessionPool } from "../server/engine/pool";
import { agent, telephony } from "./helpers";

export async function authFixture(overrides?: (db: import("mongodb").Db) => Promise<Partial<HttpDeps>>) {
  const client = await new MongoClient(process.env.TEST_MONGODB_URI!, { serverSelectionTimeoutMS: 5000 }).connect();
  const db = client.db(`auth_test_${randomUUID().replaceAll("-", "")}`);
  const store = new AuthStore(db, randomBytes(32).toString("hex"));
  const mail: AuthMail[] = [];
  await store.initialize();
  const clientSecret = randomBytes(32).toString("hex");
  const app = createAdminApp({
    store: new AgentStore(agent()),
    tools: new ToolRegistry(),
    registry: new CallRegistry(),
    contexts: new ContextStore(),
    traces: new TraceStore(),
    pool: new SessionPool(10),
    telephony: telephony(),
    listVoices: async () => [],
    pendingCalls: 0,
    ...(overrides ? await overrides(db) : {}),
  }, { router: createAuthRouter(store, clientSecret, { configured: true, enqueue: async item => { mail.push(item); } }), requireUser: requireUser(store) });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    db, store, url, clientSecret, mail,
    close: async () => {
      await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
      await db.dropDatabase();
      await client.close();
    },
  };
}

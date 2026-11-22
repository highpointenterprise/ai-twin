import "dotenv/config";
import { createServer } from "node:http";
import { MongoClient } from "mongodb";
import { env } from "../lib/env";
import { AuthStore } from "./auth/store";
import { credentialKey } from "./storage/credentials";
import { WorkspacePool } from "./workspaces/pool";
import { attachWorkspaceMedia, createWorkspaceGateway } from "./workspaces/gateway";

async function main() {
  if (env.AUTH_API_SECRET.length < 32) throw new Error("AUTH_API_SECRET must contain at least 32 characters.");
  credentialKey(env.CREDENTIAL_ENCRYPTION_KEY);
  const mongo = await new MongoClient(env.MONGODB_URI).connect();
  const db = mongo.db(env.MONGODB_DATABASE);
  const auth = new AuthStore(db);
  await auth.initialize();
  const pool = new WorkspacePool(db, { ...process.env, MONGODB_DATABASE: env.MONGODB_DATABASE }, env.MAX_WORKSPACE_WORKERS);
  const apps = createWorkspaceGateway(auth, env.AUTH_API_SECRET, pool);
  const publicServer = createServer(apps.publicApp);
  attachWorkspaceMedia(publicServer, pool);
  publicServer.listen(env.PORT);
  const admin = apps.admin.listen(env.ADMIN_PORT, env.ADMIN_HOST);
  void (async () => {
    for await (const workspace of db.collection("workspaces").find({})) {
      const tenant = mongo.db(workspace.database);
      const queued = await tenant.collection("call_requests").findOne({ phase: { $in: ["queued", "scheduled", "dialing"] } });
      const pending = await tenant.collection("calls").findOne({ storagePending: true });
      if (queued || pending) await pool.get(workspace.userId, false);
    }
  })().catch(() => console.error("workspace.recovery_failed"));
  console.log("Workspace gateway listening", { public: env.PORT, admin: env.ADMIN_PORT });
  let closing = false;
  async function close() {
    if (closing) return;
    closing = true;
    publicServer.close();
    admin.close();
    await pool.close();
    await mongo.close();
  }
  process.once("SIGTERM", () => void close());
  process.once("SIGINT", () => void close());
}
void main().catch((error) => { console.error("gateway.startup_failed", error.message); process.exit(1); });

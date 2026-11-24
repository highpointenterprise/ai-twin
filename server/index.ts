import "dotenv/config";
import { createServer } from "node:http";
import { MongoClient } from "mongodb";
import { env } from "../lib/env";
import { ApiKeyDirectory } from "./api/v1/auth/key-directory";
import { AuthMailQueue } from "./auth/mail";
import { AuthStore } from "./auth/store";
import { credentialKey } from "./storage/credentials";
import { WorkspacePool } from "./workspaces/pool";
import { workspaceIdentity } from "./workspaces/identity";
import { attachWorkspaceMedia, createWorkspaceGateway } from "./workspaces/gateway";

async function main() {
  if (env.AUTH_API_SECRET.length < 32) throw new Error("AUTH_API_SECRET must contain at least 32 characters.");
  credentialKey(env.CREDENTIAL_ENCRYPTION_KEY);
  const mongo = await new MongoClient(env.MONGODB_URI).connect();
  const db = mongo.db(env.MONGODB_DATABASE);
  const auth = new AuthStore(db, env.CREDENTIAL_ENCRYPTION_KEY);
  await auth.initialize();
  const mail = new AuthMailQueue(db, { from: env.AUTH_EMAIL_FROM, appUrl: env.AUTH_APP_URL, region: env.AUTH_EMAIL_REGION, encryptionKey: env.CREDENTIAL_ENCRYPTION_KEY });
  await mail.initialize();
  const deliverMail = () => { void mail.drain().catch(() => console.error("auth.mail_queue_failed")); };
  const mailTimer = setInterval(deliverMail, 5000);
  mailTimer.unref();
  deliverMail();
  const pool = new WorkspacePool(db, { ...process.env, MONGODB_DATABASE: env.MONGODB_DATABASE }, env.MAX_WORKSPACE_WORKERS);
  const apps = createWorkspaceGateway(auth, env.AUTH_API_SECRET, pool, new ApiKeyDirectory(db), mail);
  const publicServer = createServer(apps.publicApp);
  attachWorkspaceMedia(publicServer, pool);
  publicServer.listen(env.PORT);
  const admin = apps.admin.listen(env.ADMIN_PORT, env.ADMIN_HOST);
  let closing = false, recovering = false;
  const recover = async () => {
    if (closing || recovering) return;
    recovering = true;
    try {
      for await (const workspace of db.collection("workspaces").find({})) {
        if (closing) break;
        const tenant = mongo.db(env.WORKSPACE_DATABASE_FORMAT === "compact"
          ? workspaceIdentity(workspace.userId, { ...process.env, MONGODB_DATABASE: env.MONGODB_DATABASE }).database
          : workspace.database);
        const [queued, pending, recordings, webhooks] = await Promise.all([
          tenant.collection("call_requests").findOne({ phase: { $in: ["queued", "scheduled", "dialing"] } }),
          tenant.collection("calls").findOne({ storagePending: true }),
          tenant.collection("recording_requests").findOne({ state: { $in: ["requested", "starting", "started", "processing"] } }),
          tenant.collection("server_event_deliveries").findOne({ userId: workspace.userId, state: { $in: ["pending", "delivering"] } }),
        ]);
        if (!closing && (queued || pending || recordings || webhooks)) {
          try { await pool.get(workspace.userId, false); }
          catch { console.error("workspace.recovery_deferred"); }
        }
      }
    } finally { recovering = false; }
  };
  const recoverSafely = () => { void recover().catch(() => console.error("workspace.recovery_failed")); };
  recoverSafely();
  const recoveryTimer = setInterval(recoverSafely, 30_000);
  recoveryTimer.unref();
  console.log("Workspace gateway listening", { public: env.PORT, admin: env.ADMIN_PORT });
  async function close() {
    if (closing) return;
    closing = true;
    clearInterval(recoveryTimer);
    clearInterval(mailTimer);
    publicServer.close();
    admin.close();
    await pool.close();
    await mail.close();
    await mongo.close();
  }
  process.once("SIGTERM", () => void close());
  process.once("SIGINT", () => void close());
}
void main().catch((error) => { console.error("gateway.startup_failed", error.message); process.exit(1); });

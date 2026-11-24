import { createHash, createHmac } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export function workspaceIdentity(userId: string, base: NodeJS.ProcessEnv) {
  if (!/^[a-f0-9-]{36}$/i.test(userId)) throw new Error("Invalid workspace owner.");
  const namespace = createHash("sha256").update(`${base.MONGODB_DATABASE || "ai_twin"}:${userId}`).digest("hex").slice(0, 40);
  const database = base.WORKSPACE_DATABASE_FORMAT === "compact"
    ? `ws_${Buffer.from(namespace, "hex").toString("base64url")}`
    : `workspace_${namespace}`;
  return { userId, database, prefix: `workspace-${namespace}`, directory: resolve(base.DATA_DIR || ".data", "workspaces", userId) };
}

export function workspaceEnvironment(userId: string, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const workspace = workspaceIdentity(userId, base);
  const result = { ...base };
  for (const key of Object.keys(result)) {
    if (key.startsWith("TOOL_") || key.startsWith("TWILIO_") || ["MEET_GOOGLE_STORAGE_STATE_PATH", "LIVEAVATAR_AVATAR_ID", "ELEVENLABS_VOICE_ID"].includes(key)) delete result[key];
  }
  return {
    ...result,
    DOTENV_CONFIG_PATH: "/dev/null",
    WORKSPACE_USER_ID: userId,
    AUTH_DATABASE: base.MONGODB_DATABASE || "ai_twin",
    MONGODB_DATABASE: workspace.database,
    REDIS_PREFIX: workspace.prefix,
    DATA_DIR: workspace.directory,
    MEET_GOOGLE_STORAGE_STATE_PATH: existsSync(resolve(workspace.directory, "google-meet-storage-state.json")) ? resolve(workspace.directory, "google-meet-storage-state.json") : "",
    OBJECT_PREFIX: `workspaces/${userId}/`,
    STREAM_SECRET: createHmac("sha256", base.AUTH_API_SECRET!).update(`stream:${userId}`).digest("hex"),
    CREDENTIAL_ENCRYPTION_KEY: createHmac("sha256", base.CREDENTIAL_ENCRYPTION_KEY!).update(`credentials:${userId}`).digest("hex"),
    PUBLIC_BASE_URL: base.PUBLIC_BASE_URL ? `${base.PUBLIC_BASE_URL.replace(/\/+$/, "")}/workspaces/${userId}` : "",
    PORT: "0", ADMIN_PORT: "0", ADMIN_HOST: "127.0.0.1",
  };
}

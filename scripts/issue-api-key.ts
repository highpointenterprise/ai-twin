import "dotenv/config";
import { MongoClient } from "mongodb";
import { workspaceIdentity } from "../server/workspaces/identity";
import { env } from "../lib/env";
import { ApiKeyDirectory } from "../server/api/v1/auth/key-directory";
import { ApiKeyStore } from "../server/api/v1/auth/api-keys";

async function main(): Promise<void> {
  const name = process.argv[2]?.trim();
  const userId = process.argv[3]?.trim();
  if (!name || !userId) {
    console.error("Usage: tsx scripts/issue-api-key.ts <key-name> <user-id>");
    process.exitCode = 1;
    return;
  }
  const client = new MongoClient(env.MONGODB_URI);
  try {
    await client.connect();
    if (!(await client.db(env.MONGODB_DATABASE).collection("users").findOne({ _id: userId as never }))) throw new Error("User not found.");
    const identity = workspaceIdentity(userId, { ...process.env, MONGODB_DATABASE: env.MONGODB_DATABASE });
    await client.db(env.MONGODB_DATABASE).collection("workspaces").updateOne({ _id: userId as never }, { $setOnInsert: { ...identity, createdAt: new Date() } }, { upsert: true });
    const store = new ApiKeyStore(client.db(identity.database), userId, new ApiKeyDirectory(client.db(env.MONGODB_DATABASE)));
    await store.initialize();
    const { id, key } = await store.issue(name);
    process.stdout.write(
      `id: ${id}\nkey: ${key}\nThis key is shown once and cannot be recovered.\n`,
    );
  } finally {
    await client.close();
  }
}

void main();

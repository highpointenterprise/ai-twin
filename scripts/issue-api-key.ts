import "dotenv/config";
import { MongoClient } from "mongodb";
import { env } from "../lib/env";
import { ApiKeyStore } from "../server/api/v1/auth/api-keys";

async function main(): Promise<void> {
  const name = process.argv[2]?.trim();
  if (!name) {
    console.error("Usage: tsx scripts/issue-api-key.ts <key-name>");
    process.exitCode = 1;
    return;
  }
  const client = new MongoClient(env.MONGODB_URI);
  try {
    await client.connect();
    const store = new ApiKeyStore(client.db(env.MONGODB_DATABASE));
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

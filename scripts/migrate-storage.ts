import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createInterface } from "node:readline";
import { MongoClient, type Document } from "mongodb";
import { assistantSchema, toolSchema, e164 } from "../lib/config";
import type { CallRecord, TraceEvent } from "../lib/types";
import { MongoAgentStore, MongoToolRegistry } from "../server/storage/config";
import { MongoCallRepository } from "../server/storage/calls";
import { MongoTwilioCredentialStore } from "../server/storage/credentials";
import { TwilioCredentialStore } from "../server/store/twilio-credentials";
import { safeDetail } from "../server/observability/diagnostics";
import { defaultRates, mergeRates } from "../server/billing/pricing";

const jsonFile = async <T>(path: string, fallback: T): Promise<T> =>
  existsSync(path) ? JSON.parse(await readFile(path, "utf8")) as T : fallback;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

async function main(): Promise<void> {
  const source = resolve(process.argv[2] ?? process.env.DATA_DIR ?? ".data");
  if (!existsSync(source)) throw new Error("Legacy data directory does not exist.");
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is required.");
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10_000 });
  await client.connect();
  try {
    const db = client.db(process.env.MONGODB_DATABASE ?? "ai_twin");
    const orgId = "default";
    const agents = new MongoAgentStore(db, orgId);
    const tools = new MongoToolRegistry(db, orgId);
    const calls = new MongoCallRepository(db);
    await Promise.all([agents.initialize(), tools.initialize(), calls.initialize()]);
    const counts = { assistants: 0, tools: 0, assignments: 0, calls: 0, costs: 0, eventsProcessed: 0, credentials: 0, pricing: 0 };
    const now = new Date().toISOString();
    const pricingPath = join(source, "pricing.json");
    if (existsSync(pricingPath)) {
      const rates = await jsonFile<unknown>(pricingPath, {});
      mergeRates(defaultRates, rates);
      const result = await db.collection<Document & { _id: string }>("billing_pricing").updateOne(
        { _id: "default" },
        { $setOnInsert: { rates, createdAt: now, updatedAt: now } },
        { upsert: true },
      );
      counts.pricing += result.upsertedCount;
    }
    const assistantPath = join(source, "assistants.json");
    const createdAt = existsSync(assistantPath) ? (await stat(assistantPath)).mtime.toISOString() : now;
    const saved = await jsonFile<{ agents: (Record<string, unknown> & { id: string })[]; assignments: [string, string][] }>(assistantPath, { agents: [], assignments: [] });
    for (const value of saved.agents) {
      if (!value.id) throw new Error("Legacy assistant is missing its ID.");
      const data = assistantSchema.parse(value);
      const result = await db.collection<Document>("assistants").updateOne(
        { orgId, id: value.id },
        { $setOnInsert: { ...data, _id: `${orgId}:${value.id}`, id: value.id, orgId, createdAt, updatedAt: createdAt } },
        { upsert: true },
      );
      counts.assistants += result.upsertedCount;
    }
    for (const value of await jsonFile<(Record<string, unknown> & { id: string })[]>(join(source, "tools.json"), [])) {
      if (!value.id) throw new Error("Legacy tool is missing its ID.");
      const data = toolSchema.parse(value);
      const result = await db.collection<Document>("tools").updateOne(
        { orgId, id: value.id },
        { $setOnInsert: { ...data, _id: `${orgId}:${value.id}`, id: value.id, orgId, createdAt, updatedAt: createdAt } },
        { upsert: true },
      );
      counts.tools += result.upsertedCount;
    }
    for (const [number, assistantId] of saved.assignments) {
      e164.parse(number);
      if (!await agents.find(assistantId)) throw new Error(`Assignment references missing assistant ${assistantId}.`);
      const result = await db.collection<Document>("phone_numbers").updateOne(
        { orgId, number },
        { $setOnInsert: { _id: `${orgId}:${number}`, id: randomUUID(), orgId, number, assistantId, createdAt, updatedAt: createdAt } },
        { upsert: true },
      );
      counts.assignments += result.upsertedCount;
    }
    for (const value of await jsonFile<CallRecord[]>(join(source, "calls.json"), [])) {
      if (!value.sid || !Number.isFinite(value.updatedAt)) throw new Error("Invalid legacy call record.");
      const existing = await calls.get(value.sid);
      if (existing) continue;
      // An offline import cannot resume media sockets from the previous process.
      const record: CallRecord = ["completed", "failed"].includes(value.status)
        ? value : { ...value, status: "failed", endedReason: "legacy-import-interrupted" };
      const timestamp = new Date(value.updatedAt).toISOString();
      await calls.create({ ...record, createdAt: timestamp, endedAt: timestamp,
        ...(record.cost ? { cost: { ...record.cost, estimated: true, status: "estimated" as const,
          warnings: [...record.cost.warnings, "Imported historical estimate; provider usage details were not retained."] } } : {}),
      });
      counts.calls++;
    }
    const ledger = join(source, "costs.jsonl");
    if (existsSync(ledger)) {
      for await (const line of createInterface({ input: createReadStream(ledger), crlfDelay: Infinity })) {
        if (!line.trim()) continue;
        const { sid, at, agentId, direction, ...cost } = JSON.parse(line);
        if (typeof sid !== "string" || !Number.isFinite(cost.totalUsd)) throw new Error("Invalid legacy cost ledger entry.");
        // Preserve legacy totals explicitly as historical estimates, without inventing missing token usage.
        await db.collection<Document & { _id: string }>("legacy_cost_ledger").updateOne(
          { _id: digest(line) },
          { $setOnInsert: { sid, at, agentId, direction, cost, importedAt: now, source: "legacy-file", usageUnavailable: true } },
          { upsert: true },
        );
        const result = await db.collection("calls").updateOne(
          { sid, cost: { $exists: false } },
          { $set: { cost: { ...cost, estimated: true, status: "estimated", warnings: [...(cost.warnings ?? []), "Imported historical estimate; provider usage details were not retained."] } } },
        );
        counts.costs += result.modifiedCount;
      }
    }
    for (const suffix of [".2", ".1", ""]) {
      const path = join(source, "logs", `voice-agent.jsonl${suffix}`);
      if (!existsSync(path)) continue;
      for await (const line of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) {
        if (!line.trim()) continue;
        const item = JSON.parse(line) as TraceEvent & { scope: string };
        if (!/^CA[a-f0-9]{32}$/i.test(item.scope ?? "")) continue;
        if (!Number.isFinite(item.at) || typeof item.event !== "string" || !item.detail) throw new Error("Invalid legacy diagnostic entry.");
        const event = { at: item.at, event: item.event, detail: safeDetail(item.detail) };
        await calls.appendEvent(item.scope, event, `legacy-${digest(line)}`);
        if ((item.event === "transcript.caller" || item.event === "transcript.agent") && typeof event.detail.text === "string") {
          await calls.appendTranscript(item.scope, {
            at: item.at,
            role: item.event === "transcript.caller" ? "caller" : "agent",
            text: event.detail.text,
            ...(typeof item.detail.latency_ms === "number" ? { latencyMs: item.detail.latency_ms } : {}),
          }, `legacy-transcript-${digest(line)}`);
        }
        counts.eventsProcessed++;
      }
    }
    if (existsSync(join(source, "twilio-credentials.enc.json"))) {
      const key = process.env.CREDENTIAL_ENCRYPTION_KEY ?? "";
      const credentials = new TwilioCredentialStore(source).load();
      const destination = new MongoTwilioCredentialStore(db, key);
      await destination.initialize();
      if (credentials && await destination.importIfAbsent(credentials)) counts.credentials++;
    }
    console.log(JSON.stringify({ migrated: counts, sourceFilesUnchanged: true }));
  } finally {
    await client.close();
  }
}
void main().catch(() => {
  // Driver exceptions can contain connection strings. Keep secrets out of migration output.
  console.error("Storage migration failed. Verify the source JSON, MongoDB connection, unique IDs/tool names and credential encryption keys. Source files are unchanged; the import can be rerun after correction.");
  process.exitCode = 1;
});

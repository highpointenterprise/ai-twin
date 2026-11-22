import { MongoServerError, type Collection, type Db, type Filter } from "mongodb";
import type { ToolConfig } from "../../../../lib/config";
import type { AgentConfig } from "../../../../lib/types";
import type { AssistantBody, AssistantOverrides } from "../schemas/assistant";
import type { CustomerBody, CreateCallBody } from "../schemas/call";
import { conflict } from "../http/errors";
import { timeFilters, type TimeRange } from "../schemas/common";

export type RequestPhase = "scheduled" | "queued" | "dialing" | "placed" | "failed";

export interface CallFailure {
  reason: string;
  message: string;
}

export interface CallRequestDocument {
  id: string;
  orgId: string;
  phase: RequestPhase;
  name?: string;
  assistantId?: string;
  assistantOverrides?: AssistantOverrides;
  transientAssistant?: AssistantBody;
  phoneNumberId?: string;
  customer: CustomerBody;
  transport?: CreateCallBody["transport"];
  requestHash?: string;
  from: string;
  agent: AgentConfig;
  tools: ToolConfig[];
  brief: string;
  schedulePlan?: { earliestAt?: string; latestAt?: string };
  providerCallSid?: string;
  attempts: number;
  runAt: number;
  failure?: CallFailure;
  idempotencyKey?: string;
  createdAt: string;
  updatedAt: string;
  dialedAt?: string;
  queueSyncedAt?: string;
}

type Stored = CallRequestDocument & { _id: string };

export interface CallRequestFilter {
  id?: string;
  assistantId?: string;
  phoneNumberId?: string;
  range: TimeRange;
  limit: number;
}

const strip = (document: Stored): CallRequestDocument => {
  const { _id: _removed, ...rest } = document;
  return rest;
};

export class CallRequestRepository {
  private readonly requests: Collection<Stored>;

  constructor(db: Db, private readonly orgId = "default") {
    this.requests = db.collection<Stored>("call_requests");
  }

  async initialize(): Promise<void> {
    await Promise.all([
      this.requests.createIndex({ orgId: 1, createdAt: -1, id: -1 }),
      this.requests.createIndex({ providerCallSid: 1 }, { unique: true, sparse: true }),
      this.requests.createIndex(
        { orgId: 1, idempotencyKey: 1 },
        { unique: true, partialFilterExpression: { idempotencyKey: { $type: "string" } } },
      ),
      this.requests.createIndex({ phase: 1, updatedAt: 1 }),
      this.requests.createIndex({ orgId: 1, assistantId: 1, createdAt: -1 }),
      this.requests.createIndex({ orgId: 1, phoneNumberId: 1, createdAt: -1 }),
    ]);
  }

  async insert(document: Omit<CallRequestDocument, "orgId">): Promise<{ document: CallRequestDocument; replayed: boolean }> {
    const stored: Stored = { ...document, _id: document.id, orgId: this.orgId };
    try {
      await this.requests.insertOne(stored);
      return { document: strip(stored), replayed: false };
    } catch (error) {
      if (error instanceof MongoServerError && error.code === 11000 && document.idempotencyKey) {
        const existing = await this.requests.findOne({ orgId: this.orgId, idempotencyKey: document.idempotencyKey });
        if (existing) {
          if (existing.requestHash && document.requestHash && existing.requestHash !== document.requestHash) throw conflict("Idempotency-Key was already used for a different call request.");
          return { document: strip(existing), replayed: true };
        }
      }
      throw error;
    }
  }

  async get(id: string): Promise<CallRequestDocument | undefined> {
    const document = await this.requests.findOne({ _id: id, orgId: this.orgId });
    return document ? strip(document) : undefined;
  }

  async getBySid(sid: string): Promise<CallRequestDocument | undefined> {
    const document = await this.requests.findOne({ providerCallSid: sid, orgId: this.orgId });
    return document ? strip(document) : undefined;
  }

  async list(filter: CallRequestFilter): Promise<CallRequestDocument[]> {
    const query: Filter<Stored> = { orgId: this.orgId, ...timeFilters(filter.range) };
    if (filter.id) query.$or = [{ _id: filter.id }, { providerCallSid: filter.id }];
    if (filter.assistantId) query.assistantId = filter.assistantId;
    if (filter.phoneNumberId) query.phoneNumberId = filter.phoneNumberId;
    const documents = await this.requests.find(query).sort({ createdAt: -1, id: -1 }).limit(filter.limit).toArray();
    return documents.map(strip);
  }

  async bySids(sids: string[]): Promise<Map<string, CallRequestDocument>> {
    if (!sids.length) return new Map();
    const documents = await this.requests.find({ orgId: this.orgId, providerCallSid: { $in: sids } }).toArray();
    return new Map(documents.flatMap((document) => (document.providerCallSid ? [[document.providerCallSid, strip(document)] as const] : [])));
  }

  async beginDial(id: string): Promise<CallRequestDocument | undefined> {
    const now = new Date().toISOString();
    const claimed = await this.requests.findOneAndUpdate(
      { _id: id, phase: { $in: ["queued", "scheduled"] } },
      { $set: { phase: "dialing", updatedAt: now, dialedAt: now }, $inc: { attempts: 1 } },
      { returnDocument: "after" },
    );
    return claimed ? strip(claimed) : undefined;
  }

  async markPlaced(id: string, sid: string): Promise<void> {
    await this.requests.updateOne(
      { _id: id, phase: "dialing" },
      { $set: { phase: "placed", providerCallSid: sid, updatedAt: new Date().toISOString() }, $unset: { failure: "" } },
    );
  }

  async requeue(id: string, runAt: number, message: string): Promise<void> {
    await this.requests.updateOne(
      { _id: id, phase: "dialing" },
      {
        $set: {
          phase: "queued",
          runAt,
          updatedAt: new Date().toISOString(),
          failure: { reason: "call.start.retrying", message: message.slice(0, 500) },
        },
      },
    );
  }

  async fail(id: string, failure: CallFailure): Promise<void> {
    await this.requests.updateOne(
      { _id: id, phase: { $in: ["queued", "scheduled", "dialing"] } },
      { $set: { phase: "failed", failure, updatedAt: new Date().toISOString() } },
    );
  }

  async cancel(id: string): Promise<CallRequestDocument | undefined> {
    const removed = await this.requests.findOneAndDelete({ _id: id, orgId: this.orgId, phase: { $in: ["queued", "scheduled"] } });
    return removed ? strip(removed) : undefined;
  }

  async delete(id: string): Promise<void> {
    await this.requests.deleteOne({ _id: id, orgId: this.orgId });
  }

  async rename(id: string, name: string | undefined): Promise<CallRequestDocument | undefined> {
    const updated = await this.requests.findOneAndUpdate(
      { _id: id, orgId: this.orgId },
      { $set: { updatedAt: new Date().toISOString(), ...(name !== undefined ? { name } : {}) }, ...(name === undefined ? { $unset: { name: "" } } : {}) },
      { returnDocument: "after" },
    );
    return updated ? strip(updated) : undefined;
  }

  async staleDialing(olderThanMs: number, limit = 100): Promise<CallRequestDocument[]> {
    const cutoff = new Date(Date.now() - olderThanMs).toISOString();
    const documents = await this.requests.find({ phase: "dialing", updatedAt: { $lt: cutoff } }).limit(limit).toArray();
    return documents.map(strip);
  }

  async staleQueued(olderThanMs: number, limit = 500): Promise<CallRequestDocument[]> {
    const cutoff = new Date(Date.now() - olderThanMs).toISOString();
    const documents = await this.requests
      .find({
        phase: { $in: ["queued", "scheduled"] },
        updatedAt: { $lt: cutoff },
        $or: [{ queueSyncedAt: { $exists: false } }, { queueSyncedAt: { $lt: cutoff } }],
      })
      .sort({ updatedAt: 1 })
      .limit(limit)
      .toArray();
    return documents.map(strip);
  }

  async markSynced(ids: string[]): Promise<void> {
    if (ids.length)
      await this.requests.updateMany({ _id: { $in: ids } }, { $set: { queueSyncedAt: new Date().toISOString() } });
  }
}

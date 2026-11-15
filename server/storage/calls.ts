import { randomUUID } from "node:crypto";
import { isCallUsage, UsageAccumulator } from "../billing/merge-usage";
import type { Collection, Db, Filter, Document } from "mongodb";
import type { AgentConfig, CallCost, CallUsage, CallRecord, CallStatus, CallTraceView, TraceEvent, TranscriptLine } from "../../lib/types";
import type { ObjectStore, StoredObject } from "./objects";
import type { ToolConfig } from "../../lib/config";

export type ArtifactKind = "transcript" | "messages" | "logs" | "recording";
export interface StoredCall extends CallRecord {
  id: string;
  assistantId: string;
  /** Configuration captured when the call starts; later assistant edits do not alter it. */
  assistant?: AgentConfig;
  tools?: ToolConfig[];
  type: "inboundPhoneCall" | "outboundPhoneCall";
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  storagePending?: boolean;
  storageRevision?: number;
  archivedAt?: string;
  recordingDurationSec?: number;
  artifact?: Partial<Record<ArtifactKind, StoredObject>>;
  costBreakdown?: unknown;
  costs?: unknown[];
}
export type NewCall = Omit<CallRecord, "updatedAt"> & {
  updatedAt?: number; createdAt?: string; startedAt?: string; endedAt?: string;
  assistant?: AgentConfig; tools?: ToolConfig[];
};
interface EventDocument { _id: string; callId: string; at: number; event: string; detail: TraceEvent["detail"] }
interface TranscriptDocument { _id: string; callId: string; at: number; role: TranscriptLine["role"]; text: string; latencyMs?: number }
interface UsageDocument { _id: string; callId: string; revision: number; usage: unknown; updatedAt: Date }
interface UsageSegmentDocument { _id: string; callId: string; producerId: string; revision: number; usage: CallUsage; updatedAt: Date }
interface CostDocument { _id: string; callId: string; cost: CallCost; updatedAt: Date; storageRevision?: number }
export interface CallListOptions { limit?: number; cursor?: string; assistantId?: string; status?: CallStatus }
export interface TraceOptions { limit?: number; eventsCursor?: string; transcriptCursor?: string }
export interface StoredTrace extends CallTraceView {
  pagination: { eventsNextCursor: string | null; transcriptNextCursor: string | null };
}
const ORDER: CallStatus[] = ["initiating", "ringing", "connected", "in-progress", "completed", "failed"];
const TERMINAL = ["completed", "failed"];
const limitTo = (limit: number | undefined, max: number) => Math.min(max, Math.max(1, Number.isFinite(limit) ? Math.floor(limit!) : 100));
const cursor = (at: string | number, id: string) => Buffer.from(JSON.stringify([at, id])).toString("base64url");
function decodeCursor(value: string): [string | number, string] {
  if (value.length > 1024) throw new Error("Invalid pagination cursor.");
  try {
    const result: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!Array.isArray(result) || result.length !== 2 ||
      !["number", "string"].includes(typeof result[0]) || typeof result[1] !== "string")
      throw new Error("Invalid cursor");
    return result as [string | number, string];
  } catch { throw new Error("Invalid pagination cursor."); }
}
function eventFilter<T extends EventDocument | TranscriptDocument>(sid: string, value?: string): Filter<T> {
  if (!value) return { callId: sid } as Filter<T>;
  const [at, id] = decodeCursor(value);
  if (typeof at !== "number" || !Number.isFinite(at)) throw new Error("Invalid trace cursor.");
  return { callId: sid, $or: [{ at: { $lt: at } }, { at, _id: { $lt: id } }] } as Filter<T>;
}
function withoutStorage<T extends EventDocument | TranscriptDocument>(value: T) {
  const { _id: _id, callId: _callId, ...data } = value;
  return data;
}

/** Durable call history. Events and transcript messages are independently indexed documents. */
export class MongoCallRepository {
  private readonly calls: Collection<StoredCall & { _id: string }>;
  private readonly events: Collection<EventDocument>;
  private readonly transcripts: Collection<TranscriptDocument>;
  private readonly usage: Collection<UsageDocument>;
  private readonly usageSegments: Collection<UsageSegmentDocument>;
  private readonly costs: Collection<CostDocument>;
  constructor(db: Db) {
    this.calls = db.collection("calls");
    this.events = db.collection("call_events");
    this.transcripts = db.collection("call_transcripts");
    this.usage = db.collection("call_usage");
    this.usageSegments = db.collection("call_usage_segments");
    this.costs = db.collection("call_costs");
  }
  async initialize(): Promise<void> {
    await Promise.all([
      this.calls.createIndex({ sid: 1 }, { unique: true }),
      this.calls.createIndex({ createdAt: -1, sid: -1 }),
      this.calls.createIndex({ assistantId: 1, createdAt: -1, sid: -1 }),
      this.calls.createIndex({ status: 1, createdAt: -1, sid: -1 }),
      this.calls.createIndex({ parentCallSid: 1 }, { sparse: true }),
      this.calls.createIndex({ storagePending: 1, storageDispatchedAt: 1, endedAt: 1, sid: 1 }, { partialFilterExpression: { storagePending: true } }),
      this.events.createIndex({ callId: 1, at: -1, _id: -1 }),
      this.transcripts.createIndex({ callId: 1, at: -1, _id: -1 }),
      this.usage.createIndex({ callId: 1 }, { unique: true }),
      this.usageSegments.createIndex({ callId: 1, producerId: 1 }, { unique: true }),
      this.costs.createIndex({ callId: 1 }, { unique: true }),
    ]);
  }
  async create(record: NewCall): Promise<StoredCall> {
    const now = record.updatedAt ?? Date.now();
    const document: StoredCall = {
      ...record,
      id: record.sid,
      assistantId: record.agentId,
      type: record.direction === "inbound" ? "inboundPhoneCall" : "outboundPhoneCall",
      updatedAt: now,
      storagePending: TERMINAL.includes(record.status),
      createdAt: record.createdAt ?? new Date(now).toISOString(),
      ...(["connected", "in-progress"].includes(record.status) && !record.startedAt ? { startedAt: new Date(now).toISOString() } : {}),
      ...(TERMINAL.includes(record.status) && !record.endedAt ? { endedAt: new Date(now).toISOString() } : {}),
    };
    // Duplicate callbacks must never recreate or reset an existing call.
    await this.calls.updateOne({ _id: record.sid }, { $setOnInsert: document }, { upsert: true });
    return (await this.get(record.sid))!;
  }
  async get(sid: string): Promise<StoredCall | undefined> {
    return (await this.calls.findOne({ _id: sid }, { projection: { _id: 0 } })) ?? undefined;
  }
  async list(options: CallListOptions = {}): Promise<{ items: StoredCall[]; nextCursor: string | null }> {
    const limit = limitTo(options.limit, 200);
    const filter: Filter<StoredCall & { _id: string }> = {};
    if (options.assistantId) filter.assistantId = options.assistantId;
    if (options.status) filter.status = options.status;
    if (options.cursor) {
      const [at, sid] = decodeCursor(options.cursor);
      if (typeof at !== "string") throw new Error("Invalid call cursor.");
      filter.$or = [{ createdAt: { $lt: at } }, { createdAt: at, sid: { $lt: sid } }];
    }
    const result = await this.calls.find(filter, { projection: { _id: 0 } })
      .sort({ createdAt: -1, sid: -1 }).limit(limit + 1).toArray();
    const items = result.slice(0, limit);
    const last = items.at(-1);
    return { items, nextCursor: result.length > limit && last ? cursor(last.createdAt, last.sid) : null };
  }
  async children(sid: string, maximum = 1000): Promise<StoredCall[]> {
    const limit = limitTo(maximum, 1000);
    const records = await this.calls.find({ parentCallSid: sid }, { projection: { _id: 0 } })
      .sort({ createdAt: 1, sid: 1 }).limit(limit + 1).toArray();
    if (records.length > limit) throw new Error("Related call count exceeds the bounded billing query.");
    return records;
  }
  async patch(sid: string, fields: Partial<CallRecord>): Promise<void> {
    // Identity and state transitions have separate methods; reject accidental overwrites.
    const allowed = ["endedReason", "answeredBy", "screeningEncountered", "transferStatus", "transferId", "operatorCallSid", "parentCallSid", "cost"] as const;
    const patch: Document = { updatedAt: Date.now() };
    for (const name of allowed) if (fields[name] !== undefined) patch[name] = fields[name];
    await this.calls.updateOne({ _id: sid }, { $set: patch });
  }
  async update(sid: string, status: CallStatus): Promise<void> {
    const now = Date.now();
    const rank = ORDER.indexOf(status);
    if (rank < 0) throw new Error("Invalid call status.");
    const previous = TERMINAL.includes(status) ? ORDER.filter(s => !TERMINAL.includes(s)) : ORDER.slice(0, rank + 1);
    const set: Document = { status, updatedAt: now };
    if (["connected", "in-progress"].includes(status)) set.startedAt = { $ifNull: ["$startedAt", new Date(now).toISOString()] };
    if (TERMINAL.includes(status)) {
      set.endedAt = new Date(now).toISOString();
      set.storagePending = true;
    }
    await this.calls.updateOne({ _id: sid, status: { $in: previous } }, [{ $set: set }]);
  }
  /** Recover terminal calls whose queue enqueue or worker was interrupted. */
  async pendingArchives(maximum = 100): Promise<string[]> {
    const rows = await this.calls.find({ storagePending: true, status: { $in: ["completed", "failed"] } }, { projection: { _id: 0, sid: 1 } })
      .sort({ storageDispatchedAt: 1, endedAt: 1, sid: 1 }).limit(limitTo(maximum, 1000)).toArray();
    return rows.map(row => row.sid);
  }
  async markDispatched(sid: string): Promise<void> {
    await this.calls.updateOne({ _id: sid, storagePending: true }, { $set: { storageDispatchedAt: new Date().toISOString() } });
  }
  async markArchived(sid: string, expectedRevision = 0): Promise<void> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error("Invalid archive revision.");
    await this.calls.updateOne({ _id: sid, storagePending: true, status: { $in: ["completed", "failed"] },
      $expr: { $eq: [{ $ifNull: ["$storageRevision", 0] }, expectedRevision] },
    }, {
      $set: { storagePending: false, archivedAt: new Date().toISOString() },
    });
  }
  async appendEvent(sid: string, event: TraceEvent, eventId: string = randomUUID()): Promise<void> {
    await this.events.updateOne({ _id: `${sid}:${eventId}` }, {
      $setOnInsert: { callId: sid, ...event },
    }, { upsert: true });
  }
  async appendTranscript(sid: string, line: TranscriptLine, eventId: string = randomUUID()): Promise<void> {
    await this.transcripts.updateOne({ _id: `${sid}:${eventId}` }, {
      $setOnInsert: { callId: sid, ...line },
    }, { upsert: true });
  }
  async trace(sid: string, options: TraceOptions = {}): Promise<StoredTrace | undefined> {
    const call = await this.get(sid);
    if (!call) return undefined;
    const limit = limitTo(options.limit, 1000);
    const [events, transcript, stats] = await Promise.all([
      this.events.find(eventFilter<EventDocument>(sid, options.eventsCursor)).sort({ at: -1, _id: -1 }).limit(limit + 1).toArray(),
      this.transcripts.find(eventFilter<TranscriptDocument>(sid, options.transcriptCursor)).sort({ at: -1, _id: -1 }).limit(limit + 1).toArray(),
      this.transcripts.aggregate<{ turns: number; avgLatencyMs: number; maxLatencyMs: number; p50LatencyMs: number[] }>([
        { $match: { callId: sid, latencyMs: { $type: "number" } } },
        { $group: { _id: null, turns: { $sum: 1 }, avgLatencyMs: { $avg: "$latencyMs" }, maxLatencyMs: { $max: "$latencyMs" }, p50LatencyMs: { $percentile: { input: "$latencyMs", p: [0.5], method: "approximate" } } } },
      ]).toArray(),
    ]);
    const e = events.slice(0, limit), t = transcript.slice(0, limit);
    const s = stats[0];
    return {
      startedAt: Date.parse(call.startedAt ?? call.createdAt),
      stats: { turns: s?.turns ?? 0, avgLatencyMs: Math.round(s?.avgLatencyMs ?? 0), maxLatencyMs: s?.maxLatencyMs ?? 0,
        p50LatencyMs: Math.round(s?.p50LatencyMs?.[0] ?? 0) },
      events: e.reverse().map(withoutStorage),
      transcript: t.reverse().map(withoutStorage),
      pagination: {
        eventsNextCursor: events.length > limit ? cursor(events[limit - 1].at, events[limit - 1]._id) : null,
        transcriptNextCursor: transcript.length > limit ? cursor(transcript[limit - 1].at, transcript[limit - 1]._id) : null,
      },
    };
  }
  async saveUsage(sid: string, usage: unknown, revision = Date.now()): Promise<void> {
    // The pipeline comparison prevents a delayed earlier snapshot replacing a newer one.
    await this.usage.updateOne({ _id: sid }, [{ $set: {
      callId: sid,
      usage: { $cond: [{ $gte: [revision, { $ifNull: ["$revision", -1] }] }, { $literal: usage }, "$usage"] },
      revision: { $max: [revision, { $ifNull: ["$revision", -1] }] },
      updatedAt: new Date(),
    } }], { upsert: true });
  }
  async saveUsageSegment(sid: string, producerId: string, usage: CallUsage, revision: number): Promise<void> {
    if (!sid || !producerId || !Number.isSafeInteger(revision) || revision < 0)
      throw new Error("Invalid usage producer or revision.");
    const changed = { $gt: [revision, { $ifNull: ["$revision", -1] }] };
    const result = await this.usageSegments.updateOne({ _id: JSON.stringify([sid, producerId]) }, [{ $set: {
      callId: { $literal: sid }, producerId: { $literal: producerId },
      usage: { $cond: [changed, { $literal: usage }, "$usage"] },
      revision: { $max: [revision, { $ifNull: ["$revision", -1] }] },
      updatedAt: { $cond: [changed, new Date(), "$updatedAt"] },
    } }], { upsert: true });
    if (result.modifiedCount || result.upsertedCount) {
      await this.calls.updateOne({ _id: sid, status: { $in: ["completed", "failed"] } }, {
        $set: { storagePending: true }, $inc: { storageRevision: 1 },
      });
    }
  }
  async getUsage(sid: string): Promise<unknown | undefined> {
    const legacy = (await this.usage.findOne({ _id: sid }))?.usage;
    const accumulator = new UsageAccumulator();
    let hasSegments = false;
    const segments = this.usageSegments.find({ callId: sid }).batchSize(100);
    try {
      for await (const segment of segments) {
        hasSegments = true;
        accumulator.add(segment.usage);
      }
    } finally { await segments.close(); }
    if (!hasSegments) return legacy;
    if (isCallUsage(legacy)) accumulator.add(legacy);
    else if (legacy !== undefined) accumulator.missingLegacy();
    return accumulator.snapshot();
  }
  async getBillingUsage(sid: string): Promise<CallUsage | undefined> {
    return (await this.costs.findOne({ _id: sid }))?.cost.usage;
  }
  async saveCost(sid: string, cost: CallCost, usage?: unknown, expectedRevision?: number): Promise<void> {
    if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0))
      throw new Error("Invalid billing revision.");
    const extended = cost as CallCost & { costBreakdown?: unknown; costs?: unknown[] };
    const filter: Filter<StoredCall & { _id: string }> = { _id: sid };
    if (expectedRevision !== undefined) filter.$expr = { $eq: [{ $ifNull: ["$storageRevision", 0] }, expectedRevision] };
    const result = await this.calls.updateOne(filter, { $set: {
      cost, costs: extended.costs ?? cost.lines,
      ...(extended.costBreakdown ? { costBreakdown: extended.costBreakdown } : {}), updatedAt: Date.now(),
    } });
    if (expectedRevision !== undefined && !result.matchedCount)
      throw new Error("Call usage changed during billing; reconciliation must retry.");
    if (expectedRevision === undefined) {
      await this.costs.updateOne({ _id: sid }, { $set: { callId: sid, cost, updatedAt: new Date() } }, { upsert: true });
    } else {
      // A slower older worker may reach this collection after a newer worker.
      // Keep both the call document and standalone ledger monotonically current.
      const current = { $gte: [expectedRevision, { $ifNull: ["$storageRevision", -1] }] };
      await this.costs.updateOne({ _id: sid }, [{ $set: {
        callId: { $literal: sid },
        cost: { $cond: [current, { $literal: cost }, "$cost"] },
        storageRevision: { $max: [expectedRevision, { $ifNull: ["$storageRevision", -1] }] },
        updatedAt: { $cond: [current, new Date(), "$updatedAt"] },
      } }], { upsert: true });
    }
    if (usage !== undefined) await this.saveUsage(sid, usage);
  }
  async setRecordingUsage(sid: string, recordingId: string, durationSec: number): Promise<void> {
    if (!Number.isFinite(durationSec) || durationSec < 0) throw new Error("Invalid recording duration.");
    await this.calls.updateOne({ _id: sid }, { $set: { recordingDurationSec: durationSec, recordingId, updatedAt: Date.now() } });
  }
  async setArtifact(sid: string, kind: ArtifactKind, artifact: StoredObject): Promise<void> {
    await this.calls.updateOne({ _id: sid }, { $set: { [`artifact.${kind}`]: artifact, updatedAt: Date.now() } });
  }
  async exportArtifacts(sid: string, objects: ObjectStore): Promise<void> {
    const call = await this.get(sid);
    if (!call) throw new Error("Call not found for artifact export.");
    const prefix = `calls/${encodeURIComponent(sid)}`;
    const transcriptCollection = this.transcripts, eventCollection = this.events;
    async function* transcriptText() {
      const rows = transcriptCollection.find({ callId: sid }).sort({ at: 1, _id: 1 }).batchSize(100);
      try { for await (const row of rows) yield `${row.role}: ${row.text}\n`; }
      finally { await rows.close(); }
    }
    async function* messages() {
      const rows = transcriptCollection.find({ callId: sid }).sort({ at: 1, _id: 1 }).batchSize(100);
      try { for await (const row of rows) yield JSON.stringify({ id: row._id, role: row.role === "caller" ? "user" : "assistant", message: row.text, time: row.at, secondsFromStart: Math.max(0, (row.at - Date.parse(call!.startedAt ?? call!.createdAt)) / 1000), latencyMs: row.latencyMs }) + "\n"; }
      finally { await rows.close(); }
    }
    async function* logs() {
      const rows = eventCollection.find({ callId: sid }).sort({ at: 1, _id: 1 }).batchSize(100);
      try { for await (const row of rows) yield JSON.stringify(withoutStorage(row)) + "\n"; }
      finally { await rows.close(); }
    }
    // Stable keys make a retry safe; bucket versioning/lifecycle is an operator policy.
    const transcript = await objects.putStream(`${prefix}/transcript.txt`, transcriptText(), "text/plain; charset=utf-8");
    await this.setArtifact(sid, "transcript", transcript);
    const messageFile = await objects.putStream(`${prefix}/messages.jsonl`, messages(), "application/x-ndjson");
    await this.setArtifact(sid, "messages", messageFile);
    const logFile = await objects.putStream(`${prefix}/logs.jsonl`, logs(), "application/x-ndjson");
    await this.setArtifact(sid, "logs", logFile);
  }
}

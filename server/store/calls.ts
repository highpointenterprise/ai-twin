import type { MongoCallRepository, NewCall } from "../storage/calls";
import { PendingWrites } from "../storage/pending";
import { JsonFile } from "./persistence";
import type { CallRecord, CallStatus } from "../../lib/types";

const TERMINAL = new Set<CallStatus>(["completed", "failed"]);
const MAX_RECORDS = 200;

export class CallRegistry {
  private readonly calls = new Map<string, CallRecord>();

  private readonly file: JsonFile<CallRecord[]>;
  private readonly pending = new PendingWrites();
  constructor(path?: string, readonly repository?: MongoCallRepository) {
    this.file = new JsonFile(path);
    for (const record of this.file.load([])) {
      if (!TERMINAL.has(record.status)) {
        record.status = "failed";
        record.endedReason = "server-restarted";
      }
      this.calls.set(record.sid, record);
    }
  }
  list(): CallRecord[] {
    return [...this.calls.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }
  patch(
    sid: string,
    fields: Partial<
      Pick<
        CallRecord,
        | "endedReason"
        | "answeredBy"
        | "screeningEncountered"
        | "transferStatus"
        | "transferId"
        | "operatorCallSid"
        | "parentCallSid"
        | "cost"
      >
    >,
  ): void {
    const record = this.calls.get(sid);
    if (record) {
      Object.assign(record, fields, { updatedAt: Date.now() });
      this.file.save(this.list());
    }
    // A provider callback can reach a replica that has never hosted this call.
    // The durable update must not depend on that replica's in-memory cache.
    const snapshot = structuredClone(fields);
    if (this.repository) this.pending.enqueue(async () => this.repository!.patch(sid, snapshot));
  }
  restoreLive(sid: string): void {
    const record = this.calls.get(sid);
    if (record?.endedReason === "server-restarted") {
      this.calls.set(sid, {
        ...record,
        status: "in-progress",
        endedReason: undefined,
        updatedAt: Date.now(),
      });
      this.file.save(this.list());
    }
  }
  async flush(): Promise<void> { await this.pending.flush(); }

  async load(sid: string): Promise<CallRecord | undefined> {
    await this.flush();
    if (!this.repository) return this.get(sid);
    const record = await this.repository.get(sid);
    if (record) {
      this.calls.set(sid, record);
      if (this.calls.size > MAX_RECORDS) {
        const old = [...this.calls.values()].find(r => r.sid !== sid && TERMINAL.has(r.status));
        if (old) this.calls.delete(old.sid);
      }
    }
    return record ?? undefined;
  }

  get activeCount(): number {
    return this.list().filter((r) => !TERMINAL.has(r.status)).length;
  }
  create(record: NewCall): CallRecord {
    const existing = this.calls.get(record.sid);
    if (existing) return existing;
    const created: CallRecord = { ...record, updatedAt: Date.now() };
    this.calls.set(created.sid, created);
    const snapshot = structuredClone(created);
    if (this.repository) this.pending.enqueue(async () => this.repository!.create(snapshot));
    if (this.calls.size > MAX_RECORDS) {
      // Long-running conferences must remain controllable as newer calls arrive.
      const oldestFinished = [...this.calls.values()].find((r) =>
        TERMINAL.has(r.status),
      );
      if (oldestFinished) this.calls.delete(oldestFinished.sid);
    }
    this.file.save(this.list());
    return created;
  }

  get(sid: string): CallRecord | undefined {
    return this.calls.get(sid);
  }

  update(sid: string, status: CallStatus): void {
    const record = this.calls.get(sid);
    if (!record || TERMINAL.has(record.status)) return;
    const order: CallStatus[] = [
      "initiating",
      "ringing",
      "connected",
      "in-progress",
    ];
    if (
      !TERMINAL.has(status) &&
      order.indexOf(status) < order.indexOf(record.status)
    )
      return;
    this.calls.set(sid, { ...record, status, updatedAt: Date.now() });
    if (this.repository) this.pending.enqueue(async () => this.repository!.update(sid, status));
    this.file.save(this.list());
  }
}

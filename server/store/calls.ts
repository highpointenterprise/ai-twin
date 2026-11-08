import type { CallRecord, CallStatus } from "../../lib/types";

const TERMINAL = new Set<CallStatus>(["completed", "failed"]);
const MAX_RECORDS = 200;

export class CallRegistry {
  private readonly calls = new Map<string, CallRecord>();

  create(record: Omit<CallRecord, "updatedAt">): CallRecord {
    const created: CallRecord = { ...record, updatedAt: Date.now() };
    this.calls.set(created.sid, created);
    if (this.calls.size > MAX_RECORDS) this.calls.delete(this.calls.keys().next().value as string);
    return created;
  }

  get(sid: string): CallRecord | undefined {
    return this.calls.get(sid);
  }

  update(sid: string, status: CallStatus): void {
    const record = this.calls.get(sid);
    if (!record || TERMINAL.has(record.status)) return;
    if (status === "connected" && record.status === "in-progress") return;
    this.calls.set(sid, { ...record, status, updatedAt: Date.now() });
  }
}

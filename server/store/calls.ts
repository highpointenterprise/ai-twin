import { JsonFile } from "./persistence";
import type { CallRecord, CallStatus } from "../../lib/types";

const TERMINAL = new Set<CallStatus>(["completed", "failed"]);
const MAX_RECORDS = 200;

export class CallRegistry {
  private readonly calls = new Map<string, CallRecord>();

  private readonly file: JsonFile<CallRecord[]>;
  constructor(path?: string) {
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
        "endedReason" | "answeredBy" | "screeningEncountered" | "transferStatus"
      >
    >,
  ): void {
    const record = this.calls.get(sid);
    if (record) {
      Object.assign(record, fields, { updatedAt: Date.now() });
      this.file.save(this.list());
    }
  }
  get activeCount(): number {
    return this.list().filter((r) => !TERMINAL.has(r.status)).length;
  }
  create(record: Omit<CallRecord, "updatedAt">): CallRecord {
    const existing = this.calls.get(record.sid);
    if (existing) return existing;
    const created: CallRecord = { ...record, updatedAt: Date.now() };
    this.calls.set(created.sid, created);
    if (this.calls.size > MAX_RECORDS)
      this.calls.delete(this.calls.keys().next().value as string);
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
    this.file.save(this.list());
  }
}

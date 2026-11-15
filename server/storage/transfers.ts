import type { Collection, Db } from "mongodb";
import type { WarmTransferRecord } from "../transfers/types";

/** Durable orchestration snapshots; active transfer callbacks retain coordinator affinity. */
export class MongoTransferStore {
  private readonly records: Collection<WarmTransferRecord>;
  constructor(db: Db) { this.records = db.collection<WarmTransferRecord>("transfers"); }
  async initialize(): Promise<void> {
    await this.records.createIndexes([
      { key: { id: 1 }, unique: true },
      { key: { phase: 1, updatedAt: -1 } },
      { key: { callerSid: 1, createdAt: -1 } },
      { key: { operatorSid: 1 }, sparse: true },
    ]);
  }
  async loadActive(): Promise<WarmTransferRecord[]> {
    return this.records.find(
      { phase: { $nin: ["returned", "cancelled", "completed"] } },
      { projection: { _id: 0 } },
    ).toArray();
  }
  async save(record: WarmTransferRecord): Promise<void> {
    await this.records.replaceOne({ id: record.id }, record, { upsert: true });
  }
}

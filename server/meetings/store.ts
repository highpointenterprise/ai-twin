import type { MeetingRecord, MeetingPhase } from "../../lib/meetings";
import { JsonFile } from "../store/persistence";
import { HttpError } from "../core/errors";
export const terminalMeeting = (phase: MeetingPhase): boolean =>
  ["ended", "failed", "needs-login"].includes(phase);
export class MeetingStore {
  private records: MeetingRecord[];
  private file: JsonFile<MeetingRecord[]>;
  constructor(path?: string) {
    this.file = new JsonFile(path);
    this.records = this.file
      .load([])
      .map((r) =>
        terminalMeeting(r.phase)
          ? r
          : {
              ...r,
              phase: "failed",
              reason: "Server restarted; start a new meeting session.",
              updatedAt: Date.now(),
            },
      );
  }
  list(): MeetingRecord[] {
    return this.records.map((r) => ({ ...r }));
  }
  get(id: string): MeetingRecord {
    const r = this.records.find((r) => r.id === id);
    if (!r) throw new HttpError(404, "Meeting session not found.");
    return { ...r };
  }
  create(record: MeetingRecord): void {
    this.records.unshift(record);
    this.save();
  }
  update(id: string, phase: MeetingPhase, reason?: string): void {
    const r = this.records.find((r) => r.id === id);
    if (!r) return;
    Object.assign(r, { phase, reason, updatedAt: Date.now() });
    this.save();
  }
  private save(): void {
    let finished = 0;
    this.records = this.records.filter(
      (r) => !terminalMeeting(r.phase) || ++finished <= 100,
    );
    this.file.save(this.records);
  }
}

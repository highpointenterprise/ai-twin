import { Readable } from "node:stream";
import type { Collection, Db } from "mongodb";
import type { TwilioCredentials } from "../../lib/twilio";
import type { MongoCallRepository, StoredCall } from "../storage/calls";
import type { ObjectStore } from "../storage/objects";
import { deriveRecordings } from "../storage/recording-derivatives";
import { twilioClient, escapeXml } from "../providers/twilio";

export interface RecordingRequest {
  _id: string;
  state: "requested" | "starting" | "started" | "processing" | "completed" | "failed" | "absent";
  recordingSid?: string;
  createdAt: Date;
  nextCheckAt?: Date;
  attempts?: number;
  lastError?: string;
}
export const recordingKinds = ["recording", "monoRecording", "assistantRecording", "customerRecording"] as const;
export const recordingsComplete = (call: StoredCall) => recordingKinds.every((kind) => call.artifact?.[kind]);
export function recordingTwiml(twiml: string, callback: string): string {
  return twiml.replace("<Response>", `<Response><Start><Recording channels="dual" track="both" trim="do-not-trim" recordingStatusCallback="${escapeXml(callback)}" recordingStatusCallbackMethod="POST" recordingStatusCallbackEvent="in-progress completed absent"/></Start>`);
}
export class CallRecordings {
  private readonly requests: Collection<RecordingRequest>;
  constructor(private readonly deps: {
    db: Db; calls: MongoCallRepository; objects: ObjectStore; enabled: boolean;
    credentials: (call: StoredCall) => Promise<TwilioCredentials>;
    enqueue: (sid: string, recordingSid: string, retry?: boolean) => Promise<void>;
    request?: typeof fetch;
    client?: typeof twilioClient;
  }) { this.requests = deps.db.collection("recording_requests"); }
  async initialize() { await this.requests.createIndex({ state: 1, nextCheckAt: 1 }); }
  async prepare(sid: string): Promise<boolean> {
    if (!this.deps.enabled || !await this.deps.calls.get(sid)) return false;
    await this.requests.updateOne({ _id: sid }, { $setOnInsert: { state: "requested", createdAt: new Date(), nextCheckAt: new Date(Date.now() + 30_000), attempts: 0 } }, { upsert: true });
    return (await this.requests.findOne({ _id: sid }))?.state === "requested";
  }
  async accept(sid: string, recordingSid: string, status: string) {
    if (!await this.deps.calls.get(sid)) throw new Error("Call not found.");
    if (!["in-progress", "completed", "absent"].includes(status)) return;
    const existing = await this.requests.findOne({ _id: sid });
    if (existing?.state === "completed") return;
    if (existing?.recordingSid && existing.recordingSid !== recordingSid) return;
    if (status !== "completed" && ["processing", "failed"].includes(existing?.state ?? "")) return;
    await this.requests.updateOne({ _id: sid }, {
      $set: { recordingSid, state: status === "completed" ? "processing" : status === "absent" ? "absent" : "started", nextCheckAt: new Date(Date.now() + 60_000) },
      $setOnInsert: { createdAt: new Date(), attempts: 0 },
    }, { upsert: true });
    if (status === "completed") await this.deps.enqueue(sid, recordingSid);
  }
  async process(sid: string, recordingSid: string) {
    if (!/^CA[a-f0-9]{32}$/i.test(sid) || !/^RE[a-f0-9]{32}$/i.test(recordingSid)) throw new Error("Invalid recording identity.");
    const call = await this.deps.calls.get(sid);
    if (!call) throw new Error("Call not found.");
    const current = await this.requests.findOne({ _id: sid });
    if (current?.state === "completed" && recordingsComplete(call)) return;
    if (current?.recordingSid && current.recordingSid !== recordingSid) throw new Error("Recording identity changed.");
    const job = await this.requests.findOneAndUpdate({ _id: sid }, {
      $set: { state: "processing", recordingSid, nextCheckAt: new Date(Date.now() + 60_000) },
      $setOnInsert: { createdAt: new Date() }, $inc: { attempts: 1 },
    }, { upsert: true, returnDocument: "after" });
    try {
      const auth = await this.deps.credentials(call);
      const metadata = await (this.deps.client ?? twilioClient)(auth).recordings(recordingSid).fetch();
      if (metadata.callSid !== sid || metadata.accountSid !== auth.accountSid) throw new Error("Recording does not belong to this call.");
      if (metadata.status !== "completed") throw new Error("Recording is still processing.");
      const response = await (this.deps.request ?? fetch)(`https://api.twilio.com/2010-04-01/Accounts/${auth.accountSid}/Recordings/${recordingSid}.wav?RequestedChannels=2`, {
        headers: { Authorization: `Basic ${Buffer.from(`${auth.accountSid}:${auth.authToken}`).toString("base64")}` },
        redirect: "error", signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok || !response.body) throw new Error("Recording download is unavailable.");
      const source = await this.deps.objects.putStream(`calls/${sid}/recordings/${recordingSid}-source.wav`, Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), "audio/wav");
      await deriveRecordings(sid, source, this.deps.objects, this.deps.calls);
      await this.deps.calls.setRecordingUsage(sid, recordingSid, Number(metadata.duration));
      await this.requests.updateOne({ _id: sid, recordingSid }, { $set: { state: "completed" }, $unset: { nextCheckAt: "", lastError: "" } });
    } catch {
      await this.requests.updateOne({ _id: sid, recordingSid }, { $set: {
        state: (job?.attempts ?? 1) >= 17 ? "failed" : "processing",
        lastError: "Recording download, audio processing, or storage failed. Check provider access, FFmpeg, and bucket permissions.",
      } });
      throw new Error("Recording processing failed; the job can be retried.");
    }
  }
  async recover() {
    const pending = await this.requests.find({ state: { $in: ["requested", "starting", "started", "processing"] }, $or: [{ nextCheckAt: { $lte: new Date() } }, { nextCheckAt: { $exists: false } }] }).limit(50).toArray();
    for (const row of pending) {
      await this.requests.updateOne({ _id: row._id }, { $set: { nextCheckAt: new Date(Date.now() + 60_000) } });
      const call = await this.deps.calls.get(row._id);
      if (!call) { await this.requests.deleteOne({ _id: row._id }); continue; }
      try {
        const auth = await this.deps.credentials(call);
        const recordings = await (this.deps.client ?? twilioClient)(auth).calls(row._id).recordings.list({ limit: 20 });
        const recording = recordings.find((r) => r.status === "completed" && (!row.recordingSid || r.sid === row.recordingSid));
        if (recording) await this.accept(row._id, recording.sid, "completed");
        else if (call.endedAt && Date.now() - Date.parse(call.endedAt) > 600_000 && !recordings.length)
          await this.requests.updateOne({ _id: row._id }, { $set: { state: "absent", lastError: "The provider has no recording for this call." } });
      } catch {
        await this.requests.updateOne({ _id: row._id }, { $set: { lastError: "Unable to retrieve recording status from the provider." } });
      }
    }
  }
  async view(sid: string) {
    const call = await this.deps.calls.get(sid);
    if (!call) return undefined;
    const request = await this.requests.findOne({ _id: sid });
    return { state: request?.state === "completed" && !recordingsComplete(call) ? "incomplete" : request?.state ?? (recordingsComplete(call) ? "completed" : "unavailable"), lastError: request?.lastError, available: recordingKinds.filter((kind) => call.artifact?.[kind]) };
  }
  async retry(sid: string) {
    const call = await this.deps.calls.get(sid);
    if (!call) throw new Error("Call not found.");
    const request = await this.requests.findOne({ _id: sid });
    if (request?.state === "completed" && recordingsComplete(call)) return;
    await this.requests.updateOne({ _id: sid }, { $set: { state: "processing", attempts: 0, nextCheckAt: new Date(0) }, $setOnInsert: { createdAt: new Date() } }, { upsert: true });
    if (request?.recordingSid) await this.deps.enqueue(sid, request.recordingSid, true);
    else await this.recover();
  }
}

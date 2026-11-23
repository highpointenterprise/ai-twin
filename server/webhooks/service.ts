import { env } from "../../lib/env";
import { recordingsComplete } from "../recordings/service";
import type { Db } from "mongodb";
import type { MongoCallRepository } from "../storage/calls";
import type { ObjectStore } from "../storage/objects";
import { logEvent } from "../observability/trace";
import { endOfCallReport, type ReportArtifact } from "./end-of-call-report";
import {
  MAX_DELIVERY_ATTEMPTS,
  ServerEventOutbox,
  type Delivery,
} from "./outbox";
import {
  DeliveryError,
  postServerEvent,
  type DeliveryRequest,
} from "./transport";

export class AssistantServerEvents {
  readonly outbox: ServerEventOutbox;
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private stopped = false;
  private recoverAt = 0;
  private readonly abort = new AbortController();
  constructor(
    private readonly deps: {
      db: Db;
      userId: string;
      calls: MongoCallRepository;
      objects: ObjectStore;
      baseUrl: string;
      send?: (request: DeliveryRequest) => Promise<number>;
    },
  ) {
    this.outbox = new ServerEventOutbox(deps.db, deps.userId);
  }
  async initialize() {
    await this.outbox.initialize();
  }
  start() {
    this.timer ??= setInterval(() => {
      void this.tick().catch(() =>
        logEvent("webhook.worker_error", {
          message: "Webhook worker could not access durable storage.",
        }),
      );
    }, 1000);
    this.timer.unref();
  }
  async enqueueEndOfCall(sid: string) {
    const call = await this.deps.calls.get(sid);
    // Use the call's snapshot; later assistant edits must not redirect old reports.
    const server = call?.assistant?.server;
    if (
      !call ||
      !server?.url ||
      !["completed", "failed"].includes(call.status) ||
      !call.endedAt
    )
      return;
    await this.outbox.enqueue({
      callId: sid,
      event: "end-of-call-report",
      url: server.url,
      timeoutSeconds: server.timeoutSeconds,
      dueAt: new Date(Date.parse(call.endedAt) + 5000),
    });
  }
  private async recoverPending() {
    if (Date.now() < this.recoverAt) return;
    const pending = await this.deps.db
      .collection("calls")
      .aggregate<{ sid: string }>([
        {
          $match: {
            storagePending: true,
            status: { $in: ["completed", "failed"] },
            "assistant.server.url": { $type: "string", $ne: "" },
          },
        },
        {
          $lookup: {
            from: "server_event_deliveries",
            let: { sid: "$sid" },
            as: "delivery",
            pipeline: [
              {
                $match: {
                  userId: this.deps.userId,
                  event: "end-of-call-report",
                  $expr: { $eq: ["$callId", "$$sid"] },
                },
              },
              { $limit: 1 },
            ],
          },
        },
        { $match: { "delivery.0": { $exists: false } } },
        { $limit: 100 },
        { $project: { sid: 1 } },
      ])
      .toArray();
    for (const { sid } of pending) await this.enqueueEndOfCall(sid);
    this.recoverAt = Date.now() + 30_000;
  }
  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return (this.running ??= this.recoverPending()
      .then(() => Promise.allSettled([this.deliverOne(), this.deliverOne()]))
      .then((results) => {
        const failure = results.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
      })
      .finally(() => {
        this.running = undefined;
      }));
  }
  private async deliverOne() {
    const delivery = await this.outbox.claim();
    if (!delivery) return;
    const attemptAbort = new AbortController();
    const heartbeat = setInterval(() => {
      void this.outbox
        .renew(delivery)
        .then((owned) => {
          if (!owned) attemptAbort.abort();
        })
        .catch(() => attemptAbort.abort());
    }, 30_000);
    heartbeat.unref();
    const signal = AbortSignal.any([this.abort.signal, attemptAbort.signal]);
    try {
      if (delivery.attempts > MAX_DELIVERY_ATTEMPTS)
        throw new DeliveryError("Webhook delivery attempts exhausted.", false);
      const call = await this.deps.calls.get(delivery.callId);
      const recording = await this.deps.db.collection("recording_requests").findOne({ _id: delivery.callId as never });
      if (call?.endedAt && recording && !["absent", "failed"].includes(recording.state) &&
          (recording.state !== "completed" || !recordingsComplete(call)) &&
          Date.now() < Date.parse(call.endedAt) + env.WEBHOOK_RECORDING_WAIT_SECONDS * 1000) {
        await this.outbox.defer(delivery, new Date(Date.now() + 5000));
        return;
      }
      const body = await this.deliveryBody(delivery);
      signal.throwIfAborted();
      const status = await (this.deps.send ?? postServerEvent)({
        url: delivery.url,
        timeoutSeconds: delivery.timeoutSeconds,
        body,
        id: delivery._id,
        signal,
      });
      await this.outbox.success(delivery, status);
      logEvent("webhook.delivered", {
        sid: delivery.callId,
        event: delivery.event,
        deliveryId: delivery._id,
        attempt: delivery.attempts,
        status,
      });
    } catch (error) {
      const failure =
        error instanceof DeliveryError
          ? error
          : new DeliveryError(
              "Unable to prepare or acknowledge webhook delivery.",
              true,
            );
      const state = await this.outbox.failure(delivery, failure);
      logEvent(
        state === "failed" ? "webhook.failed" : "webhook.retry_scheduled",
        {
          sid: delivery.callId,
          event: delivery.event,
          deliveryId: delivery._id,
          attempt: delivery.attempts,
          message: failure.message,
          status: failure.status ?? 0,
        },
      );
    } finally {
      clearInterval(heartbeat);
    }
  }
  private async deliveryBody(delivery: Delivery) {
    const call = await this.deps.calls.get(delivery.callId);
    if (!call)
      throw new DeliveryError("Call was deleted; delivery cancelled.", false);
    const { db, userId, baseUrl, calls } = this.deps;
    const request = await db
      .collection("call_requests")
      .findOne({ orgId: userId, providerCallSid: call.sid });
    const phoneNumber = await db.collection("phone_numbers").findOne({
      orgId: userId,
      number: call.direction === "inbound" ? call.to : call.from,
    });
    // MongoDB is the durable source; reports must not depend on S3 or billing availability.
    const report = endOfCallReport({
      call,
      transcript: await calls.completeTranscript(call.sid),
      orgId: userId,
      baseUrl,
      timestamp: delivery.createdAt.getTime(),
      callId: request?.id,
      customerName: request?.customer?.name,
      name: request?.name,
      createdAt: request?.createdAt,
      phoneNumberId:
        request?.phoneNumberId ?? call.phoneNumberId ?? phoneNumber?.id,
    });
    const artifact = report.message.artifact;
    const fields = {
      monoRecording: "presignedMonoUrl",
      recording: "presignedStereoUrl",
      assistantRecording: "presignedAssistantUrl",
      customerRecording: "presignedCustomerUrl",
      logs: "presignedLogUrl",
    } as const;
    for (const [kind, field] of Object.entries(fields)) {
      const stored = call.artifact?.[kind as keyof typeof fields];
      if (stored) {
        try {
          artifact[
            field as keyof Pick<
              ReportArtifact,
              (typeof fields)[keyof typeof fields]
            >
          ] = await this.deps.objects.signedUrl(stored.key, 900, "inline");
        } catch (error) {
          if (kind !== "logs") throw error;
          logEvent("webhook.artifact_url_unavailable", { sid: call.sid, kind });
        }
      }
    }
    if (Object.values(fields).some((field) => artifact[field]))
      artifact.presignedUrlsExpiresAt = new Date(
        Date.now() + 900_000,
      ).toISOString();
    if (artifact.presignedStereoUrl) {
      artifact.stereoRecordingUrl = artifact.presignedStereoUrl;
      artifact.recording = { ...artifact.recording, stereoUrl: artifact.presignedStereoUrl };
    }
    if (artifact.presignedMonoUrl) {
      artifact.recordingUrl = artifact.presignedMonoUrl;
      artifact.recording = { ...artifact.recording, mono: {
        combinedUrl: artifact.presignedMonoUrl,
        ...(artifact.presignedAssistantUrl ? { assistantUrl: artifact.presignedAssistantUrl } : {}),
        ...(artifact.presignedCustomerUrl ? { customerUrl: artifact.presignedCustomerUrl } : {}),
      } };
    }
    report.message.call.artifact = artifact;
    return JSON.stringify(report);
  }
  async close() {
    this.stopped = true;
    clearInterval(this.timer);
    this.abort.abort();
    await this.running;
  }
}

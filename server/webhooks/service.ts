import { createHash } from "node:crypto";
import type { Db } from "mongodb";
import type { MongoCallRepository } from "../storage/calls";
import type { ObjectStore } from "../storage/objects";
import { logEvent } from "../observability/trace";
import {
  endOfCallReport,
  type EndOfCallReport,
  type ReportArtifact,
} from "./end-of-call-report";
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
    const { calls, db, objects, userId, baseUrl } = this.deps;
    const call = await calls.get(sid);
    // Never fall back to the current assistant: old/unowned calls must not inherit a destination.
    const server = call?.assistant?.server;
    if (
      !call ||
      !server?.url ||
      (await this.outbox.exists(sid, "end-of-call-report"))
    )
      return;
    if (!["completed", "failed"].includes(call.status) || !call.endedAt) return;
    if (call.cost?.reconciliationStatus !== "complete")
      throw new Error("Call billing is not ready for its end-of-call report.");
    const recording = await db
      .collection("recording_requests")
      .findOne({ _id: sid as never });
    if (recording && ["starting", "started"].includes(recording.state)) {
      if (Date.now() - Date.parse(call.endedAt) < 10 * 60_000)
        throw new Error(
          "Call recording is not ready for its end-of-call report.",
        );
      logEvent("webhook.recording_unavailable", {
        sid,
        message:
          "Recording did not arrive within ten minutes; reporting available artifacts.",
      });
    }
    const request = await db
      .collection("call_requests")
      .findOne({ orgId: userId, providerCallSid: sid });
    const phoneNumber = await db.collection("phone_numbers").findOne({
      orgId: userId,
      number: call.direction === "inbound" ? call.to : call.from,
    });
    const report = endOfCallReport({
      call,
      transcript: await calls.completeTranscript(sid),
      orgId: userId,
      baseUrl,
      callId: request?.id,
      customerName: request?.customer?.name,
      name: request?.name,
      createdAt: request?.createdAt,
      phoneNumberId: request?.phoneNumberId ?? phoneNumber?.id,
    });
    const body = JSON.stringify(report);
    const hash = createHash("sha256").update(body).digest("hex");
    const payload = await objects.put(
      `calls/${encodeURIComponent(sid)}/server-events/${hash}.json`,
      body,
      "application/json",
    );
    const current = await calls.get(sid);
    if (!current || current.storageRevision !== call.storageRevision)
      throw new Error("Call changed while preparing its end-of-call report.");
    await this.outbox.enqueue({
      callId: sid,
      event: "end-of-call-report",
      url: server.url,
      timeoutSeconds: server.timeoutSeconds,
      payload,
    });
  }
  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return (this.running ??= Promise.allSettled([
      this.deliverOne(),
      this.deliverOne(),
    ])
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
    const stream = await this.deps.objects.read(delivery.payload.key);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const report = JSON.parse(
      Buffer.concat(chunks).toString("utf8"),
    ) as EndOfCallReport;
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
      if (stored)
        artifact[
          field as keyof Pick<
            ReportArtifact,
            (typeof fields)[keyof typeof fields]
          >
        ] = await this.deps.objects.signedUrl(stored.key, 900);
    }
    if (Object.values(fields).some((field) => artifact[field]))
      artifact.presignedUrlsExpiresAt = new Date(
        Date.now() + 900_000,
      ).toISOString();
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

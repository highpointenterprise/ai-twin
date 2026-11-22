import type Redis from "ioredis";
import type { CallRequestDocument, CallRequestRepository } from "../api/v1/repositories/call-requests";
import { errorDetail } from "../observability/diagnostics";
import {
  activeLeases,
  callsDispatched,
  queueDepth,
  queueWait,
} from "../observability/metrics";
import { logEvent } from "../observability/trace";
import type { MongoCallRepository } from "../storage/calls";
import type { CallQueue } from "../storage/call-queue";
import type { RedisCallState } from "../storage/redis";
import type { CallLauncher } from "./launcher";

export type Readiness =
  | { state: "ready" }
  | { state: "updating" }
  | { state: "misconfigured"; message: string };

export interface DispatcherOptions {
  concurrencyLimit: number;
  dispatchesPerMinute: number;
  pollMs: number;
  parallelism: number;
  maxAttempts: number;
  leaseTtlMs: number;
}

export interface DispatcherDependencies {
  queue: CallQueue;
  requests: CallRequestRepository;
  launcher: CallLauncher;
  callState: RedisCallState;
  calls: MongoCallRepository;
  subscriber: Redis;
  readiness: () => Readiness;
  options: DispatcherOptions;
}

const PROCESSING_TTL_MS = 120_000;
const STALE_DIALING_MS = 90_000;
const STALE_QUEUED_MS = 60_000;
const MAINTENANCE_MS = 30_000;
const TRANSIENT_CODES = /^(ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|EPIPE|UND_ERR_.*)$/;

const isTransient = (error: unknown): boolean => {
  const candidate = error as { status?: unknown; code?: unknown } | null;
  if (typeof candidate?.status === "number") return candidate.status === 429 || candidate.status >= 500;
  return typeof candidate?.code === "string" && TRANSIENT_CODES.test(candidate.code);
};

const backoffMs = (attempt: number): number => Math.min(30_000, 1000 * 2 ** attempt);

export class CallDispatcher {
  private readonly inflight = new Set<Promise<void>>();
  private pollTimer?: NodeJS.Timeout;
  private maintenanceTimer?: NodeJS.Timeout;
  private wakeTimer?: NodeJS.Timeout;
  private pumping = false;
  private rerun = false;
  private stopped = true;

  constructor(private readonly deps: DispatcherDependencies) {}

  async start(): Promise<void> {
    const { subscriber, queue, options } = this.deps;
    this.stopped = false;
    await subscriber.subscribe(queue.capacityChannel);
    subscriber.on("message", () => this.kick());
    queueDepth.collect(() => queue.depth());
    activeLeases.collect(() => queue.activeLeases());
    this.pollTimer = setInterval(() => this.kick(), options.pollMs);
    this.maintenanceTimer = setInterval(() => void this.maintain(), MAINTENANCE_MS);
    this.pollTimer.unref();
    this.maintenanceTimer.unref();
    void this.maintain();
    this.kick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.pollTimer);
    clearInterval(this.maintenanceTimer);
    clearTimeout(this.wakeTimer);
    await this.deps.subscriber.unsubscribe(this.deps.queue.capacityChannel).catch(() => undefined);
    await Promise.allSettled([...this.inflight]);
  }

  kick(): void {
    if (this.stopped) return;
    if (this.pumping) {
      this.rerun = true;
      return;
    }
    this.pumping = true;
    void this.pump()
      .catch((error) => logEvent("callqueue.pump_failed", errorDetail(error)))
      .finally(() => {
        this.pumping = false;
        if (this.rerun) {
          this.rerun = false;
          this.kick();
        }
      });
  }

  private wake(afterMs: number): void {
    if (this.stopped) return;
    clearTimeout(this.wakeTimer);
    this.wakeTimer = setTimeout(() => this.kick(), Math.max(50, Math.min(afterMs, this.deps.options.pollMs)));
    this.wakeTimer.unref();
  }

  private async pump(): Promise<void> {
    const { queue, options } = this.deps;
    while (!this.stopped && this.inflight.size < options.parallelism) {
      const claim = await queue.claim({
        concurrencyLimit: options.concurrencyLimit,
        dispatchesPerMinute: options.dispatchesPerMinute,
        leaseTtlMs: options.leaseTtlMs,
        processingTtlMs: PROCESSING_TTL_MS,
      });
      if (claim.status === "rate-limited") {
        this.wake(claim.retryAfterMs);
        return;
      }
      if (claim.status === "idle") {
        if (claim.nextDueInMs !== undefined) this.wake(claim.nextDueInMs);
        return;
      }
      if (claim.status === "at-capacity") return;
      const task: Promise<void> = this.process(claim.id)
        .catch((error) => logEvent("callqueue.process_failed", { callId: claim.id, ...errorDetail(error) }))
        .finally(() => {
          this.inflight.delete(task);
          this.kick();
        });
      this.inflight.add(task);
    }
  }

  private async process(id: string): Promise<void> {
    const { requests, queue, callState, launcher, options } = this.deps;
    const request = await requests.beginDial(id);
    if (!request) {
      await queue.acknowledge(id);
      await callState.release(id);
      return;
    }
    const waitedFrom = Math.max(Date.parse(request.createdAt), request.runAt);
    queueWait.observe(Math.max(0, (Date.now() - waitedFrom) / 1000));
    const latest = request.schedulePlan?.latestAt;
    if (latest && Date.now() > Date.parse(latest)) {
      await this.giveUp(request, "call.start.error-schedule-expired", "The scheduled window ended before capacity was available.", "expired");
      return;
    }
    const readiness = this.deps.readiness();
    if (readiness.state === "updating") {
      await this.retryLater(request, 2000, "Telephony credentials are being updated.", "deferred");
      return;
    }
    if (readiness.state === "misconfigured") {
      await this.giveUp(request, "call.start.error-configuration", readiness.message, "misconfigured");
      return;
    }
    try {
      const sid = await launcher.launch(request);
      await requests.markPlaced(id, sid);
      await queue.acknowledge(id);
      callsDispatched.inc({ result: "placed" });
      logEvent("callqueue.placed", { callId: id, sid, attempt: request.attempts });
    } catch (error) {
      await callState.release(id);
      if (isTransient(error) && request.attempts < options.maxAttempts) {
        await this.retryLater(request, backoffMs(request.attempts), errorDetail(error).message as string, "retried");
        return;
      }
      await this.giveUp(request, "twilio-failed-to-connect-call", String(errorDetail(error).message ?? "Provider rejected the call."), "failed");
    }
  }

  private async retryLater(request: CallRequestDocument, delayMs: number, message: string, result: string): Promise<void> {
    const { requests, queue, callState } = this.deps;
    const runAt = Date.now() + delayMs;
    await requests.requeue(request.id, runAt, message);
    await queue.enqueue(request.id, runAt);
    await queue.acknowledge(request.id);
    await callState.release(request.id);
    callsDispatched.inc({ result });
    logEvent("callqueue.requeued", { callId: request.id, delayMs, result });
  }

  private async giveUp(request: CallRequestDocument, reason: string, message: string, result: string): Promise<void> {
    const { requests, queue, callState } = this.deps;
    await requests.fail(request.id, { reason, message: message.slice(0, 500) });
    await queue.acknowledge(request.id);
    await callState.release(request.id);
    callsDispatched.inc({ result });
    logEvent("callqueue.failed", { callId: request.id, reason, result });
  }

  private async maintain(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.recoverProcessing();
      await this.recoverDialing();
      await this.resyncQueued();
    } catch (error) {
      logEvent("callqueue.maintenance_failed", errorDetail(error));
    }
  }

  private async recoverProcessing(): Promise<void> {
    const { queue, requests, callState } = this.deps;
    for (const id of await queue.recoverStale()) {
      const request = await requests.get(id);
      if (!request) await callState.release(id);
      else if (request.phase === "queued" || request.phase === "scheduled") await queue.enqueue(id, request.runAt, true);
    }
  }

  private async recoverDialing(): Promise<void> {
    const { requests, calls, callState } = this.deps;
    for (const request of await requests.staleDialing(STALE_DIALING_MS)) {
      const placed = await calls.findByRequestId(request.id);
      if (placed) {
        await requests.markPlaced(request.id, placed.sid);
        continue;
      }
      await requests.fail(request.id, {
        reason: "call.start.error-dispatch-interrupted",
        message: "Dispatch was interrupted before the provider confirmed the call.",
      });
      await callState.release(request.id);
      logEvent("callqueue.dialing_recovered", { callId: request.id });
    }
  }

  private async resyncQueued(): Promise<void> {
    const { requests, queue } = this.deps;
    const stale = await requests.staleQueued(STALE_QUEUED_MS);
    for (const request of stale) await queue.enqueue(request.id, request.runAt, true);
    await requests.markSynced(stale.map((request) => request.id));
  }
}

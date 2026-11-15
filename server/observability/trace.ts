import { randomUUID } from "node:crypto";
import type { MongoCallRepository } from "../storage/calls";
import { PendingWrites } from "../storage/pending";
import type {
  CallTraceView,
  TraceEvent,
  TranscriptLine,
} from "../../lib/types";
import { UsageMeter } from "../billing/meter";
import { safeDetail, writeDiagnostic } from "./diagnostics";

type Detail = TraceEvent["detail"];

const MAX_EVENTS = 600;
const MAX_TRACES = 100;
let eventSequence = 0;
const eventIdentity = () =>
  `${String(++eventSequence).padStart(16, "0")}-${randomUUID()}`;

export const logEvent = (event: string, detail: Detail = {}): void => {
  writeDiagnostic("system", event, detail);
};

export class CallTrace {
  private readonly events: TraceEvent[] = [];
  private readonly transcript: TranscriptLine[] = [];
  private readonly latencies: number[] = [];
  private readonly startedAt = Date.now();
  private finished = false;
  readonly usage = new UsageMeter();
  private usageTimer?: NodeJS.Timeout;
  private readonly usageProducerId = randomUUID();
  private usageRevision = 0;
  private saveUsage = () => {
    clearTimeout(this.usageTimer);
    this.usageTimer = undefined;
    const snapshot = this.usage.snapshot(),
      revision = ++this.usageRevision;
    if (this.repository)
      this.pending.enqueue(async () =>
        this.repository!.saveUsageSegment(
          this.sid,
          this.usageProducerId,
          snapshot,
          revision,
        ),
      );
  };

  constructor(
    private readonly sid: string,
    private readonly repository?: MongoCallRepository,
    private readonly pending = new PendingWrites(),
  ) {
    if (this.repository)
      this.usage.subscribe(() => {
        this.usageTimer ??= setTimeout(this.saveUsage, 1000);
        this.usageTimer.unref();
      });
  }

  flushUsage(): void {
    if (this.usageTimer) this.saveUsage();
  }
  async flush(): Promise<void> {
    this.flushUsage();
    await this.pending.flush();
  }

  log(event: string, detail: Detail = {}): void {
    const at = Date.now();
    detail = safeDetail(detail);
    this.events.push({ at, event, detail });
    const eventId = eventIdentity();
    if (this.repository)
      this.pending.enqueue(async () =>
        this.repository!.appendEvent(this.sid, { at, event, detail }, eventId),
      );
    if (this.events.length > MAX_EVENTS) this.events.shift();
    writeDiagnostic(this.sid, event, detail);
  }

  say(role: TranscriptLine["role"], text: string, latencyMs?: number): void {
    const line = { at: Date.now(), role, text, latencyMs };
    this.transcript.push(line);
    if (this.transcript.length > MAX_EVENTS) this.transcript.shift();
    const eventId = eventIdentity();
    if (this.repository)
      this.pending.enqueue(async () =>
        this.repository!.appendTranscript(this.sid, line, eventId),
      );
    if (latencyMs !== undefined) this.latencies.push(latencyMs);
    if (this.latencies.length > MAX_EVENTS) this.latencies.shift();
    this.log(
      `transcript.${role}`,
      latencyMs === undefined ? { text } : { text, latency_ms: latencyMs },
    );
  }

  get isFinished(): boolean {
    return this.finished;
  }

  finish(): void {
    if (this.finished) return;
    this.finished = true;
    const { stats } = this.view();
    this.log("call.summary", {
      duration_s: Math.round((Date.now() - this.startedAt) / 1000),
      turns: stats.turns,
      avg_latency_ms: stats.avgLatencyMs,
      p50_latency_ms: stats.p50LatencyMs,
      max_latency_ms: stats.maxLatencyMs,
    });
  }

  view(): CallTraceView {
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const total = sorted.reduce((sum, value) => sum + value, 0);
    return {
      startedAt: this.startedAt,
      stats: {
        turns: sorted.length,
        avgLatencyMs: sorted.length ? Math.round(total / sorted.length) : 0,
        p50LatencyMs: sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0,
        maxLatencyMs: sorted.length ? sorted[sorted.length - 1] : 0,
      },
      transcript: this.transcript,
      events: this.events,
    };
  }
}

export class TraceStore {
  private readonly traces = new Map<string, CallTrace>();
  private readonly pending = new PendingWrites();
  constructor(private readonly repository?: MongoCallRepository) {}
  async flush(): Promise<void> {
    for (const trace of this.traces.values()) trace.flushUsage();
    await this.pending.flush();
  }

  for(sid: string): CallTrace {
    const existing = this.traces.get(sid);
    if (existing) return existing;
    const created = new CallTrace(sid, this.repository, this.pending);
    this.traces.set(sid, created);
    if (this.traces.size > MAX_TRACES) {
      const old = [...this.traces].find(
        ([id, trace]) => id !== sid && trace.isFinished,
      );
      if (old) this.traces.delete(old[0]);
    }
    return created;
  }

  get(sid: string): CallTrace | undefined {
    return this.traces.get(sid);
  }
}

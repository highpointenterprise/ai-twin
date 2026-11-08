import type { CallTraceView, TraceEvent, TranscriptLine } from "../../lib/types";

type Detail = TraceEvent["detail"];

const MAX_EVENTS = 600;
const MAX_TRACES = 100;

const format = (sid: string, at: number, event: string, detail: Detail): string => {
  const fields = Object.entries(detail)
    .map(([key, value]) => `${key}=${typeof value === "string" ? JSON.stringify(value) : value}`)
    .join(" ");
  return `${new Date(at).toISOString().slice(11, 23)} [${sid}] ${event}${fields ? ` ${fields}` : ""}`;
};

export const logEvent = (event: string, detail: Detail = {}): void => {
  console.log(format("system", Date.now(), event, detail));
};

export class CallTrace {
  private readonly events: TraceEvent[] = [];
  private readonly transcript: TranscriptLine[] = [];
  private readonly latencies: number[] = [];
  private readonly startedAt = Date.now();
  private finished = false;

  constructor(private readonly sid: string) {}

  log(event: string, detail: Detail = {}): void {
    const at = Date.now();
    this.events.push({ at, event, detail });
    if (this.events.length > MAX_EVENTS) this.events.shift();
    console.log(format(this.sid.slice(-8), at, event, detail));
  }

  say(role: TranscriptLine["role"], text: string, latencyMs?: number): void {
    this.transcript.push({ at: Date.now(), role, text, latencyMs });
    if (latencyMs !== undefined) this.latencies.push(latencyMs);
    this.log(`transcript.${role}`, latencyMs === undefined ? { text } : { text, latency_ms: latencyMs });
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
    const lines = this.transcript.map(
      (line) => `${line.role === "agent" ? "AGENT " : "CALLER"}${line.latencyMs === undefined ? "" : ` (${line.latencyMs}ms)`}: ${line.text}`,
    );
    console.log(`--- transcript [${this.sid.slice(-8)}] ---\n${lines.join("\n")}\n--- end transcript ---`);
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

  for(sid: string): CallTrace {
    const existing = this.traces.get(sid);
    if (existing) return existing;
    const created = new CallTrace(sid);
    this.traces.set(sid, created);
    if (this.traces.size > MAX_TRACES) this.traces.delete(this.traces.keys().next().value as string);
    return created;
  }

  get(sid: string): CallTrace | undefined {
    return this.traces.get(sid);
  }
}

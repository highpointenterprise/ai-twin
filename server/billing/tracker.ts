import type { CallCost, CallUsage } from "../../lib/types";
import type { TraceStore } from "../observability/trace";
import type { CallRegistry } from "../store/calls";
import { formatCost, priceCall } from "./cost";
import type { HostingConfig, Rates } from "./pricing";

export class CostTracker {
  private readonly pending = new Map<string, { timer: ReturnType<typeof setTimeout>; duration?: number }>();
  private readonly running = new Map<string, Promise<void>>();
  constructor(
    private readonly deps: {
      traces: TraceStore;
      registry: Pick<CallRegistry, "get" | "patch">;
      rates: () => Rates;
      hosting: HostingConfig;
      /** Retained for callers migrating from file storage; no file is written. */
      ledgerPath?: string;
      onFinalized?: (sid: string, cost: CallCost, usage: CallUsage) => Promise<void>;
      amdEnabled: (agentId: string) => boolean | Promise<boolean>;
      settleMs?: number;
    },
  ) {}

  finalize(sid: string, twilioDurationSec?: number): void {
    const existing = this.pending.get(sid);
    if (existing) {
      if (twilioDurationSec !== undefined) existing.duration = twilioDurationSec;
      return;
    }
    const timer = setTimeout(() => {
      const duration = this.pending.get(sid)?.duration;
      this.pending.delete(sid);
      void this.run(sid, duration).catch((error: unknown) => {
        console.error("billing.finalize_failed", error instanceof Error ? error.message : error);
      });
    }, this.deps.settleMs ?? 4000);
    timer.unref();
    this.pending.set(sid, { timer, duration: twilioDurationSec });
  }

  addTelephonyUsage(sid: string, value: { duration: string | null; price: string | null; priceUnit: string | null; callSid?: string }): void {
    this.deps.traces.for(sid).usage.setTelephony({
      callSid: value.callSid ?? sid,
      durationSeconds: value.duration === null ? 0 : Number(value.duration),
      price: value.price === null || value.price.trim() === "" ? null : Number(value.price),
      currency: value.priceUnit, source: "provider",
    });
  }

  /** Drain on shutdown so the settle delay cannot discard the final usage. */
  async flush(): Promise<void> {
    const pending = [...this.pending.entries()];
    this.pending.clear();
    for (const [, value] of pending) clearTimeout(value.timer);
    await Promise.all(pending.map(([sid, value]) => this.run(sid, value.duration)));
    await Promise.all([...this.running.values()]);
  }

  private run(sid: string, duration?: number): Promise<void> {
    // Serialize repeated callbacks. Persistence uses an upsert by call ID, so a
    // corrected provider duration replaces the same bill instead of duplicating it.
    const previous = this.running.get(sid) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(() => this.compute(sid, duration));
    this.running.set(sid, task);
    void task.finally(() => { if (this.running.get(sid) === task) this.running.delete(sid); }).catch(() => {});
    return task;
  }

  private async compute(sid: string, twilioDurationSec?: number): Promise<void> {
    const { traces, registry, hosting } = this.deps;
    const record = registry.get(sid);
    if (!record) return;
    const trace = traces.get(sid);
    // Never create an empty trace while pricing an old call after a restart.
    if (!trace) return;
    const providerDuration = trace.usage.telephony.get(sid)?.durationSeconds;
    const durationSec = twilioDurationSec !== undefined && Number.isFinite(twilioDurationSec)
      ? Math.max(0, twilioDurationSec)
      : providerDuration ?? Math.max(0, (record.updatedAt - trace.view().startedAt) / 1000);
    const cost = priceCall(trace.usage, {
      callSid: sid, direction: record.direction, to: record.to, durationSec,
      amd: await this.deps.amdEnabled(record.agentId),
    }, this.deps.rates(), hosting);
    if (this.deps.onFinalized) await this.deps.onFinalized(sid, cost, trace.usage.snapshot());
    registry.patch(sid, { cost });
    trace.log("call.cost", {
      total_usd: cost.totalUsd, services_usd: cost.servicesUsd,
      hosting_usd: cost.hostingUsd, duration_s: Math.round(durationSec),
      status: cost.status ?? "estimated",
    });
    console.log(formatCost(sid, cost));
  }
}

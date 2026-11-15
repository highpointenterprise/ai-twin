import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { TraceStore } from "../observability/trace";
import type { CallRegistry } from "../store/calls";
import { formatCost, priceCall } from "./cost";
import type { HostingConfig, Rates } from "./pricing";

export class CostTracker {
  private readonly done = new Set<string>();
  constructor(
    private readonly deps: {
      traces: TraceStore;
      registry: CallRegistry;
      rates: () => Rates;
      hosting: HostingConfig;
      ledgerPath: string;
      amdEnabled: (agentId: string) => boolean;
      settleMs?: number;
    },
  ) {}

  finalize(sid: string, twilioDurationSec?: number): void {
    if (this.done.has(sid)) return;
    this.done.add(sid);
    if (this.done.size > 1000) this.done.delete(this.done.values().next().value as string);
    setTimeout(() => this.compute(sid, twilioDurationSec), this.deps.settleMs ?? 4000).unref();
  }

  private compute(sid: string, twilioDurationSec?: number): void {
    try {
      const { traces, registry, hosting } = this.deps;
      const trace = traces.for(sid);
      const record = registry.get(sid);
      const durationSec =
        twilioDurationSec !== undefined && Number.isFinite(twilioDurationSec)
          ? twilioDurationSec
          : (Date.now() - trace.view().startedAt) / 1000;
      const cost = priceCall(
        trace.usage,
        {
          direction: record?.direction ?? "inbound",
          to: record?.to ?? "",
          durationSec,
          amd: !!record && this.deps.amdEnabled(record.agentId),
        },
        this.deps.rates(),
        hosting,
      );
      registry.patch(sid, { cost });
      trace.log("call.cost", {
        total_usd: cost.totalUsd,
        services_usd: cost.servicesUsd,
        hosting_usd: cost.hostingUsd,
        duration_s: Math.round(durationSec),
      });
      console.log(formatCost(sid, cost));
      mkdirSync(dirname(this.deps.ledgerPath), { recursive: true });
      appendFileSync(
        this.deps.ledgerPath,
        JSON.stringify({ at: new Date().toISOString(), sid, agentId: record?.agentId, direction: record?.direction, ...cost }) + "\n",
      );
    } catch (error) {
      console.error("billing.finalize_failed", error instanceof Error ? error.message : error);
    }
  }
}
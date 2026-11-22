import type { CallCost, CallUsage } from "../../lib/types";
import type { StoredCall } from "../storage/calls";
import { UsageMeter } from "./meter";
import { priceCall } from "./cost";
import type { HostingConfig, Rates } from "./pricing";

interface ProviderUsage { duration: string | null; price: string | null; priceUnit: string | null }
export interface ReconciliationResult {
  cost: CallCost;
  usage: CallUsage;
  /** Save the partial result before retrying, so unknown charges remain visible. */
  retryReasons: string[];
}
const nonnegative = (value: string | null): number | undefined => {
  if (value === null || !value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
};

/** Rebuild charges from durable usage; callers persist the result before scheduling retries. */
export async function reconcileCallCost(input: {
  record: StoredCall;
  usage: CallUsage | undefined;
  getProviderUsage: (sid: string) => Promise<ProviderUsage>;
  children?: StoredCall[];
  rates: Rates;
  hosting: HostingConfig;
  amd: boolean;
}): Promise<ReconciliationResult> {
  const { record } = input;
  const meter = new UsageMeter();
  const retryReasons: string[] = [];
  if (input.usage) meter.restore(input.usage);
  else if (record.startedAt) {
    meter.markMissing("call", "usage", "The call connected but durable provider usage has not arrived.");
    retryReasons.push("Connected call usage is not persisted yet.");
  }
  // Keep a previously reported provider charge if a later reconciliation lookup
  // temporarily fails; raw model usage still comes from the media worker.
  for (const charge of record.cost?.usage?.telephony ?? []) {
    if (!meter.telephony.has(charge.callSid)) meter.setTelephony(charge);
  }
  const fallbackDuration = Math.max(0, (Date.parse(record.endedAt ?? record.createdAt) - Date.parse(record.startedAt ?? record.createdAt)) / 1000);
  let durationSec = Number.isFinite(fallbackDuration) ? fallbackDuration : 0;
  try {
    const provider = await input.getProviderUsage(record.sid);
    durationSec = nonnegative(provider.duration) ?? meter.telephony.get(record.sid)?.durationSeconds ?? durationSec;
    const price = provider.price !== null && provider.price.trim() !== "" && Number.isFinite(Number(provider.price)) ? Math.abs(Number(provider.price)) : null;
    const previous = meter.telephony.get(record.sid);
    meter.setTelephony({ callSid: record.sid, durationSeconds: durationSec, price: price ?? previous?.price ?? null, currency: price !== null ? provider.priceUnit : previous?.currency ?? provider.priceUnit, source: "provider" });
    if (price === null || !provider.priceUnit || nonnegative(provider.duration) === undefined) retryReasons.push("Provider charge or duration is pending.");
  } catch {
    retryReasons.push("Provider usage lookup failed.");
  }
  const cost = priceCall(meter, {
    callSid: record.sid, direction: record.direction, to: record.to, durationSec, amd: input.amd,
    ...(record.recordingDurationSec !== undefined || record.artifact?.recording ? {
      recordingDurationSec: record.recordingDurationSec ?? durationSec,
      recordingDurationEstimated: record.recordingDurationSec === undefined,
    } : {}),
    conference: !!record.transferId,
    artifactBytes: record.artifact ? Object.values(record.artifact).reduce((sum, artifact) => sum + (artifact?.size ?? 0), 0) : undefined,
  }, input.rates, input.hosting);
  cost.reconciliationStatus = retryReasons.length ? "pending" : "complete";
  if (retryReasons.length) {
    cost.estimated = true;
    if (cost.status === "final") cost.status = "estimated";
    cost.warnings.push(...retryReasons);
  }
  if (input.children?.length) {
    const related = [...new Map(input.children.filter((child) => child.sid !== record.sid).map((child) => [child.sid, child])).values()];
    cost.relatedCalls = related.map((child) => ({
      callId: child.sid,
      totalUsd: child.cost?.totalWithRelatedUsd ?? child.cost?.totalUsd ?? null,
      status: child.cost?.status ?? "pending",
    }));
    cost.totalWithRelatedUsd = Number((cost.totalUsd + cost.relatedCalls.reduce((sum, child) => sum + (child.totalUsd ?? 0), 0)).toFixed(8));
    const pending = related.filter((child) => !child.cost || child.cost.reconciliationStatus === "pending" || !["completed", "failed"].includes(child.status));
    if (pending.length) {
      retryReasons.push("Transfer call charges are not finalized yet.");
      cost.reconciliationStatus = "pending";
      cost.warnings.push("Combined call cost excludes any transfer charges still pending.");
    }
  }
  return { cost, usage: meter.snapshot(), retryReasons };
}

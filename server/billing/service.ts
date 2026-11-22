import { randomUUID } from "node:crypto";
import { MongoServerError, type Db } from "mongodb";
import { HttpError } from "../core/errors";
import type { MongoCallRepository } from "../storage/calls";
import type { Telephony } from "../core/ports";
import { isCallUsage } from "./merge-usage";
import { PricingPolicies } from "./policy";
import { ProviderUsageReconciler } from "./provider-usage";
import { reconcileCallCost } from "./reconcile";

export class BillingService {
  readonly pricing: PricingPolicies;
  constructor(
    private readonly db: Db,
    private readonly calls: MongoCallRepository,
    private readonly telephony: {
      getCallUsage: (
        sid: string,
        accountSid?: string,
      ) => ReturnType<Telephony["getCallUsage"]>;
    },
    private readonly providerUsage = new ProviderUsageReconciler(),
  ) {
    this.pricing = new PricingPolicies(db);
  }
  async finalize(sid: string) {
    const locks = this.db.collection<{
      _id: string;
      token: string;
      expires: Date;
    }>("call_billing_locks");
    const token = randomUUID(),
      expiry = () => new Date(Date.now() + 120_000);
    try {
      await locks.updateOne(
        { _id: sid, expires: { $lte: new Date() } },
        { $set: { token, expires: expiry() } },
        { upsert: true },
      );
    } catch (e) {
      if (e instanceof MongoServerError && e.code === 11000)
        throw new HttpError(409, "Call costs are already being reconciled.");
      throw e;
    }
    let lost = false;
    const timer = setInterval(() => {
      void locks
        .updateOne({ _id: sid, token }, { $set: { expires: expiry() } })
        .then((result) => {
          if (!result.matchedCount) lost = true;
        })
        .catch(() => {
          lost = true;
        });
    }, 30_000);
    timer.unref();
    try {
      const record = await this.calls.get(sid);
      if (!record) throw new HttpError(404, "Call not found.");
      if (!["completed", "failed"].includes(record.status))
        throw new HttpError(409, "The call has not ended.");
      const policy = await this.pricing.forCall(sid),
        raw = await this.calls.getUsage(sid);
      const evidence = isCallUsage(raw)
        ? await this.providerUsage.reconcile(raw, record.cost?.usage)
        : undefined;
      const result = await reconcileCallCost({
        record,
        usage: evidence?.usage,
        getProviderUsage: (id) =>
          this.telephony.getCallUsage(id, record.twilioAccountSid),
        children: await this.calls.children(sid),
        rates: policy.rates,
        hosting: policy.hosting,
        amd: record.assistant?.voicemailDetection.enabled ?? false,
      });
      result.retryReasons.push(...(evidence?.retryReasons ?? []));
      result.cost.pricingVersion = policy.version;
      if (result.retryReasons.length) {
        result.cost.reconciliationStatus = "pending";
        result.cost.estimated = true;
        result.cost.warnings = [
          ...new Set([...result.cost.warnings, ...result.retryReasons]),
        ];
      }
      if (
        lost ||
        !(await locks.findOne({
          _id: sid,
          token,
          expires: { $gt: new Date() },
        }))
      )
        throw new Error("Billing lease expired; retry reconciliation.");
      await this.calls.saveCost(
        sid,
        result.cost,
        undefined,
        record.storageRevision ?? 0,
      );
      return result;
    } finally {
      clearInterval(timer);
      await locks.deleteOne({ _id: sid, token });
    }
  }
}

import { createHash } from "node:crypto";
import { MongoServerError, type Db } from "mongodb";
import { z } from "zod";
import { env } from "../../lib/env";
import { HttpError } from "../core/errors";
import {
  defaultRates,
  mergeRates,
  ratesSchema,
  type Rates,
  type HostingConfig,
} from "./pricing";

const amount = z.number().finite().nonnegative();
export const hostingSchema = z
  .object({
    configured: z.boolean().default(false),
    region: z.string().max(40).default("us-east-1"),
    monthlyUsd: amount,
    expectedMinutesPerMonth: z.number().positive(),
    egressUsdPerGb: amount,
    compute: z
      .object({
        vcpuPerCall: amount,
        memoryGbPerCall: amount,
        vcpuHourUsd: amount,
        memoryGbHourUsd: amount,
      })
      .strict()
      .optional(),
    storage: z
      .object({ gbMonthUsd: amount, retentionDays: amount.max(3650) })
      .strict()
      .optional(),
    overheadPerMinute: z.record(amount).optional(),
  })
  .strict()
  .refine(
    (v) => !(v.monthlyUsd > 0 && v.compute),
    "Use either monthly server allocation or compute allocation to avoid counting compute twice.",
  );
export const pricingUpdateSchema = z
  .object({
    expectedVersion: z.string(),
    rates: ratesSchema,
    hosting: hostingSchema,
    note: z.string().trim().min(1).max(500),
  })
  .strict();
export interface PricingPolicy {
  version: string;
  rates: Rates;
  hosting: HostingConfig;
  note: string;
  effectiveAt: string;
}
export const pricingSources = [
  "https://developers.openai.com/api/docs/pricing",
  "https://deepgram.com/pricing",
  "https://elevenlabs.io/pricing/api",
  "https://www.twilio.com/en-us/voice/pricing/us",
  "https://aws.amazon.com/fargate/pricing/",
  "https://aws.amazon.com/s3/pricing/",
];
export const pricingVersion = (rates: Rates, hosting: HostingConfig) =>
  createHash("sha256")
    .update(JSON.stringify({ rates, hosting }))
    .digest("hex")
    .slice(0, 16);
export class PricingPolicies {
  constructor(private readonly db: Db) {}
  async current(): Promise<PricingPolicy> {
    const saved = await this.db
      .collection<{
        _id: string;
        rates: unknown;
        hosting?: HostingConfig;
        note?: string;
        effectiveAt?: string;
      }>("billing_pricing")
      .findOne({ _id: "default" });
    const rates = saved
      ? mergeRates(defaultRates, saved.rates)
      : structuredClone(defaultRates);
    const hosting: HostingConfig = saved?.hosting ?? {
      monthlyUsd: env.HOSTING_MONTHLY_USD,
      expectedMinutesPerMonth: env.HOSTING_EXPECTED_MINUTES_PER_MONTH,
      egressUsdPerGb: env.HOSTING_EGRESS_USD_PER_GB,
      region: "us-east-1",
      configured:
        env.HOSTING_MONTHLY_USD > 0 || env.HOSTING_EGRESS_USD_PER_GB > 0,
    };
    return {
      rates,
      hosting,
      version: pricingVersion(rates, hosting),
      effectiveAt: saved?.effectiveAt ?? "2026-11-23T00:00:00.000Z",
      note:
        saved?.note ??
        "Reference USD rates. Verify account plans and destination rates; AWS allocation and credit pricing require configuration.",
    };
  }
  async update(input: unknown): Promise<PricingPolicy> {
    const parsed = pricingUpdateSchema.parse(input),
      current = await this.current();
    if (current.version !== parsed.expectedVersion)
      throw new HttpError(409, "Pricing changed. Reload before saving.");
    const policy: PricingPolicy = {
      rates: parsed.rates,
      hosting: parsed.hosting,
      version: pricingVersion(parsed.rates, parsed.hosting),
      note: parsed.note,
      effectiveAt: new Date().toISOString(),
    };
    const collection = this.db.collection<
      { _id: string } & Partial<PricingPolicy>
    >("billing_pricing");
    try {
      const result = await collection.updateOne(
        {
          _id: "default",
          $or: [{ version: current.version }, { version: { $exists: false } }],
        },
        { $set: policy },
        { upsert: true },
      );
      if (!result.matchedCount && !result.upsertedCount)
        throw new HttpError(409, "Pricing changed. Reload before saving.");
    } catch (error) {
      if (error instanceof MongoServerError && error.code === 11000)
        throw new HttpError(409, "Pricing changed. Reload before saving.");
      throw error;
    }
    await this.db
      .collection<{ _id: string } & PricingPolicy>("billing_pricing_history")
      .updateOne(
        { _id: policy.version },
        { $setOnInsert: policy },
        { upsert: true },
      );
    return policy;
  }
  async forCall(callId: string): Promise<PricingPolicy> {
    const snapshots = this.db.collection<{
      _id: string;
      policy: PricingPolicy;
    }>("call_pricing_snapshots");
    const saved = await snapshots.findOne({ _id: callId });
    if (saved) return saved.policy;
    const policy = await this.current();
    await snapshots.updateOne(
      { _id: callId },
      { $setOnInsert: { policy } },
      { upsert: true },
    );
    return (await snapshots.findOne({ _id: callId }))!.policy;
  }
}

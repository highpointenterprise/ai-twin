import type { Db } from "mongodb";
import { z } from "zod";

export interface ModelRates {
  input: number; cachedInput: number; output: number;
  audioInput?: number; audioCachedInput?: number; audioOutput?: number;
}
export interface Rates {
  deepgram: Record<string, number>; // USD per audio minute
  elevenlabs: Record<string, number>; // USD per 1k chars
  openai: Record<string, ModelRates>;
  models?: Record<string, ModelRates>; // USD per 1M tokens
  twilio: {
    inboundLocalPerMin: number;
    inboundTollFreePerMin: number;
    outboundPerMin: number;
    mediaStreamsPerMin: number;
    amdPerCall: number;
    recordingPerMin?: number;
    conferencePerParticipantMin?: number;
  };
}
export const defaultRates: Rates = {
  deepgram: { "flux-general-en": 0.0065, "flux-general-multi": 0.0078 },
  elevenlabs: { eleven_flash_v2_5: 0.05, eleven_turbo_v2_5: 0.05, eleven_multilingual_v2: 0.1 },
  openai: {
    "gpt-5.6-luna": { input: 0.2, cachedInput: 0.02, output: 1.2 },
    "gpt-4.1": { input: 2, cachedInput: 0.5, output: 8 },
    "gpt-4.1-mini": { input: 0.4, cachedInput: 0.1, output: 1.6 },
    "gpt-4o": { input: 2.5, cachedInput: 1.25, output: 10 },
    "gpt-4o-mini": { input: 0.15, cachedInput: 0.075, output: 0.6 },
  },
  twilio: {
    inboundLocalPerMin: 0.0085,
    inboundTollFreePerMin: 0.022,
    outboundPerMin: 0.014,
    mediaStreamsPerMin: 0.004,
    amdPerCall: 0.0075,
  },
};
const rate = z.number().finite().nonnegative();
const modelRatesSchema = z.object({ input: rate, cachedInput: rate, output: rate, audioInput: rate.optional(), audioCachedInput: rate.optional(), audioOutput: rate.optional() }).strict();
const ratesSchema = z.object({
  deepgram: z.record(rate), elevenlabs: z.record(rate), openai: z.record(modelRatesSchema), models: z.record(modelRatesSchema).optional(),
  twilio: z.object({ inboundLocalPerMin: rate, inboundTollFreePerMin: rate, outboundPerMin: rate, mediaStreamsPerMin: rate, amdPerCall: rate, recordingPerMin: rate.optional(), conferencePerParticipantMin: rate.optional() }).strict(),
}).strict();
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
function merge(base: unknown, override: unknown): unknown {
  if (!isObject(base) || !isObject(override)) return override;
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (["__proto__", "prototype", "constructor"].includes(key)) throw new Error("Invalid pricing key.");
    result[key] = Object.hasOwn(result, key) ? merge(result[key], value) : value;
  }
  return result;
}
/** Partial overrides are validated; bad account rates must never silently fall back. */
export function mergeRates(base: Rates, override: unknown): Rates {
  return ratesSchema.parse(merge(base, override));
}
export async function loadDatabaseRates(db: Db): Promise<Rates> {
  const document = await db.collection<{ _id: string; rates: unknown }>("billing_pricing").findOne({ _id: "default" });
  return document ? mergeRates(defaultRates, document.rates) : structuredClone(defaultRates);
}
export interface HostingConfig {
  monthlyUsd: number;
  expectedMinutesPerMonth: number;
  egressUsdPerGb: number;
}
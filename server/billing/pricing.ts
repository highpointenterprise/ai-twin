import { existsSync, readFileSync } from "node:fs";

export interface Rates {
  deepgram: Record<string, number>; // USD per audio minute
  elevenlabs: Record<string, number>; // USD per 1k chars
  openai: Record<string, { input: number; cachedInput: number; output: number }>; // USD per 1M tokens
  twilio: {
    inboundLocalPerMin: number;
    inboundTollFreePerMin: number;
    outboundPerMin: number;
    mediaStreamsPerMin: number;
    amdPerCall: number;
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
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const merge = <T>(base: T, over: unknown): T => {
  if (!isObject(base) || !isObject(over)) return (over ?? base) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = k in out ? merge(out[k], v) : v;
  return out as T;
};
// Optional override file: DATA_DIR/pricing.json (partial JSON, re-read every call)
export const loadRates = (overridePath?: string): Rates => {
  if (!overridePath || !existsSync(overridePath)) return defaultRates;
  try {
    return merge(defaultRates, JSON.parse(readFileSync(overridePath, "utf8")));
  } catch {
    return defaultRates;
  }
};
export interface HostingConfig {
  monthlyUsd: number;
  expectedMinutesPerMonth: number;
  egressUsdPerGb: number;
}
import type { CallUsage, LlmUsageTotals, TelephonyUsage } from "../../lib/types";

export function isCallUsage(value: unknown): value is CallUsage {
  if (!value || typeof value !== "object") return false;
  const u = value as Partial<CallUsage>;
  return Array.isArray(u.llm) && Array.isArray(u.transcriber) && Array.isArray(u.voice)
    && Array.isArray(u.telephony) && !!u.network;
}
const numericKeys = ["requests", "estimatedRequests", "prompt", "cached", "completion", "reasoning", "inputAudio", "cachedAudio", "outputAudio"] as const;
const count = (value: number | undefined): number => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

/** Sums independent producer totals, never multiple revisions of one producer. */
export class UsageAccumulator {
  private readonly requests = new Map<string, NonNullable<CallUsage["requests"]>[number]>();
  private readonly llm = new Map<string, LlmUsageTotals>();
  private readonly transcriber = new Map<string, CallUsage["transcriber"][number]>();
  private readonly voice = new Map<string, CallUsage["voice"][number]>();
  private readonly telephony = new Map<string, TelephonyUsage>();
  private readonly unmetered = new Map<string, NonNullable<CallUsage["unmetered"]>[number]>();
  private receivedBytes = 0;
  private mediaSeconds?: number;
  private sentBytes = 0;
  add(usage: CallUsage): void {
    if (usage.mediaSeconds !== undefined) this.mediaSeconds = (this.mediaSeconds ?? 0) + count(usage.mediaSeconds);
    for (const entry of usage.requests ?? []) {
      const prior = this.requests.get(entry.id);
      if (!prior || entry.quantity >= prior.quantity) this.requests.set(entry.id, { ...entry });
    }
    for (const item of usage.llm) {
      const key = JSON.stringify([item.provider, item.model]);
      const existing = this.llm.get(key) ?? { provider: item.provider, model: item.model, requests: 0, estimatedRequests: 0, prompt: 0, cached: 0, completion: 0, reasoning: 0, inputAudio: 0, cachedAudio: 0, outputAudio: 0 };
      for (const field of numericKeys) existing[field] += count(item[field]);
      this.llm.set(key, existing);
    }
    for (const item of usage.transcriber) {
      const key = JSON.stringify([item.provider, item.model]);
      const existing = this.transcriber.get(key) ?? { ...item, audioSeconds: 0 };
      existing.audioSeconds += count(item.audioSeconds);
      this.transcriber.set(key, existing);
    }
    for (const item of usage.voice) {
      const key = JSON.stringify([item.provider, item.model]);
      const existing = this.voice.get(key) ?? { ...item, characters: 0 };
      existing.characters += count(item.characters);
      this.voice.set(key, existing);
    }
    for (const item of usage.telephony) {
      // Provider call totals are observations of one leg, not additive segments.
      const prior = this.telephony.get(item.callSid);
      if (!prior || (prior.price === null && item.price !== null) || (prior.price === null) === (item.price === null) && item.durationSeconds > prior.durationSeconds)
        this.telephony.set(item.callSid, { ...item });
    }
    for (const item of usage.unmetered ?? []) this.unmetered.set(JSON.stringify([item.provider, item.model, item.reason]), { ...item });
    this.receivedBytes += count(usage.network.receivedBytes);
    this.sentBytes += count(usage.network.sentBytes);
  }
  missingLegacy(): void {
    const item = { provider: "call", model: "legacy-usage", reason: "Legacy usage has an unsupported shape and could not be included in the totals." };
    this.unmetered.set("legacy", item);
  }
  snapshot(): CallUsage {
    return {
      requests: [...this.requests.values()],
      ...(this.mediaSeconds !== undefined ? { mediaSeconds: this.mediaSeconds } : {}),
      llm: [...this.llm.values()].map(item => ({ ...item })),
      transcriber: [...this.transcriber.values()].map(item => ({ ...item })),
      voice: [...this.voice.values()].map(item => ({ ...item })),
      telephony: [...this.telephony.values()].map(item => ({ ...item })),
      unmetered: [...this.unmetered.values()].map(item => ({ ...item })),
      network: { receivedBytes: this.receivedBytes, sentBytes: this.sentBytes },
    };
  }
}
export function mergeUsage(segments: Iterable<CallUsage>): CallUsage {
  const accumulator = new UsageAccumulator();
  for (const usage of segments) accumulator.add(usage);
  return accumulator.snapshot();
}

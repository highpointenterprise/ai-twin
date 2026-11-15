import type { CallUsage, LlmUsageTotals, TelephonyUsage } from "../../lib/types";

export interface LlmUsage {
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  reasoningTokens?: number;
  inputAudioTokens?: number;
  cachedAudioTokens?: number;
  outputAudioTokens?: number;
  estimated?: boolean;
  provider?: string;
  requestId?: string;
}
const count = (value: number | undefined): number =>
  value !== undefined && Number.isFinite(value) && value >= 0 ? value : 0;

export class UsageMeter {
  readonly sttSeconds = new Map<string, number>();
  readonly ttsChars = new Map<string, number>();
  readonly llm = new Map<string, LlmUsageTotals>();
  readonly telephony = new Map<string, TelephonyUsage>();
  private readonly requests = new Set<string>();
  private readonly unmetered = new Map<string, { provider: string; model: string; reason: string }>();
  private readonly listeners = new Set<(usage: CallUsage) => void>();
  netInBytes = 0;
  netOutBytes = 0;
  subscribe(listener: (usage: CallUsage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private changed(): void {
    if (this.listeners.size) {
      const usage = this.snapshot();
      for (const listener of this.listeners) listener(usage);
    }
  }
  markMissing(provider: string, model: string, reason: string): void {
    this.unmetered.set(`${provider}:${model}:${reason}`, { provider, model, reason });
    this.changed();
  }
  addStt(model: string, seconds: number): void {
    this.sttSeconds.set(model, (this.sttSeconds.get(model) ?? 0) + count(seconds));
    this.changed();
  }
  addTts(model: string, chars: number): void {
    this.ttsChars.set(model, (this.ttsChars.get(model) ?? 0) + count(chars));
    this.changed();
  }
  addLlm(model: string, usage: LlmUsage): void {
    const provider = usage.provider ?? (model.includes(":") ? model.split(":", 1)[0] : "openai");
    const key = `${provider}:${model}`;
    if (usage.requestId) {
      const requestKey = `${provider}:${usage.requestId}`;
      if (this.requests.has(requestKey)) return;
      this.requests.add(requestKey);
    }
    const t = this.llm.get(key) ?? {
      provider, model, requests: 0, estimatedRequests: 0,
      prompt: 0, cached: 0, completion: 0, reasoning: 0,
      inputAudio: 0, cachedAudio: 0, outputAudio: 0,
    };
    t.requests++;
    if (usage.estimated) t.estimatedRequests++;
    const prompt = count(usage.promptTokens);
    const cached = Math.min(prompt, count(usage.cachedTokens));
    const completion = count(usage.completionTokens);
    t.prompt += prompt;
    t.cached += cached;
    t.completion += completion;
    t.reasoning += Math.min(completion, count(usage.reasoningTokens));
    t.inputAudio += Math.min(prompt, count(usage.inputAudioTokens));
    t.cachedAudio += Math.min(cached, count(usage.inputAudioTokens), count(usage.cachedAudioTokens));
    t.outputAudio += Math.min(completion, count(usage.outputAudioTokens));
    this.llm.set(key, t);
    this.changed();
  }
  setTelephony(value: TelephonyUsage): void {
    this.telephony.set(value.callSid, {
      ...value, durationSeconds: count(value.durationSeconds),
      price: value.price !== null && Number.isFinite(value.price) ? Math.abs(value.price) : null,
    });
    this.changed();
  }
  addNetwork(inBytes: number, outBytes: number): void {
    this.netInBytes += count(inBytes);
    this.netOutBytes += count(outBytes);
    this.changed();
  }
  snapshot(): CallUsage {
    return {
      unmetered: [...this.unmetered.values()].map((entry) => ({ ...entry })),
      llm: [...this.llm.values()].map((entry) => ({ ...entry })),
      transcriber: [...this.sttSeconds].map(([model, audioSeconds]) => ({ provider: "deepgram", model, audioSeconds, source: "submitted-audio" })),
      voice: [...this.ttsChars].map(([model, characters]) => ({ provider: "elevenlabs", model, characters, source: "submitted-text" })),
      telephony: [...this.telephony.values()].map((entry) => ({ ...entry })),
      network: { receivedBytes: this.netInBytes, sentBytes: this.netOutBytes },
    };
  }
  restore(usage: CallUsage): void {
    this.llm.clear(); this.sttSeconds.clear(); this.ttsChars.clear(); this.telephony.clear(); this.unmetered.clear();
    for (const entry of usage.unmetered ?? []) this.unmetered.set(`${entry.provider}:${entry.model}:${entry.reason}`, { ...entry });
    for (const entry of usage.llm) this.llm.set(`${entry.provider}:${entry.model}`, { ...entry });
    for (const entry of usage.transcriber) this.sttSeconds.set(entry.model, entry.audioSeconds);
    for (const entry of usage.voice) this.ttsChars.set(entry.model, entry.characters);
    for (const entry of usage.telephony) this.telephony.set(entry.callSid, { ...entry });
    this.netInBytes = usage.network.receivedBytes;
    this.netOutBytes = usage.network.sentBytes;
  }
}

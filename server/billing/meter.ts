export interface LlmUsage {
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  estimated?: boolean;
}
interface LlmTotals {
  requests: number;
  estimatedRequests: number;
  prompt: number;
  cached: number;
  completion: number;
}
export class UsageMeter {
  readonly sttSeconds = new Map<string, number>();
  readonly ttsChars = new Map<string, number>();
  readonly llm = new Map<string, LlmTotals>();
  netInBytes = 0;
  netOutBytes = 0;
  addStt(model: string, seconds: number): void {
    this.sttSeconds.set(model, (this.sttSeconds.get(model) ?? 0) + seconds);
  }
  addTts(model: string, chars: number): void {
    this.ttsChars.set(model, (this.ttsChars.get(model) ?? 0) + chars);
  }
  addLlm(model: string, u: LlmUsage): void {
    const t = this.llm.get(model) ?? { requests: 0, estimatedRequests: 0, prompt: 0, cached: 0, completion: 0 };
    t.requests++;
    if (u.estimated) t.estimatedRequests++;
    t.prompt += u.promptTokens;
    t.cached += u.cachedTokens;
    t.completion += u.completionTokens;
    this.llm.set(model, t);
  }
  addNetwork(inBytes: number, outBytes: number): void {
    this.netInBytes += inBytes;
    this.netOutBytes += outBytes;
  }
}
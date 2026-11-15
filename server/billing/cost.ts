import { createHash } from "node:crypto";
import type { CallCost, CostLine } from "../../lib/types";
import type { UsageMeter } from "./meter";
import type { HostingConfig, Rates } from "./pricing";

export interface CallFacts {
  callSid?: string;
  direction: "inbound" | "outbound";
  to: string;
  durationSec: number;
  amd: boolean;
  recordingDurationSec?: number;
  recordingDurationEstimated?: boolean;
  conference?: boolean;
}
const TOLL_FREE = /^\+1(800|833|844|855|866|877|888)/;
const round = (n: number, d = 8) => Number(n.toFixed(d));
const validRate = (n: number | undefined): n is number => n !== undefined && Number.isFinite(n) && n >= 0;

export function priceCall(usage: UsageMeter, facts: CallFacts, rates: Rates, hosting: HostingConfig): CallCost {
  const lines: CostLine[] = [];
  const warnings: string[] = [];
  const durationSec = Number.isFinite(facts.durationSec) ? Math.max(0, facts.durationSec) : 0;
  const add = (l: Omit<CostLine, "usd" | "rate"> & { rate?: number | null; usd?: number | null }) => {
    const rate = validRate(l.rate ?? undefined) ? l.rate! : null;
    const usd = l.usd !== undefined ? l.usd : rate === null ? null : l.quantity * rate;
    if (usd === null) warnings.push(`Missing price for ${l.provider} ${l.item}; total includes priced items only.`);
    lines.push({ ...l, rate, usd: usd === null ? null : round(usd), source: usd === null ? "unpriced" : l.source ?? "rate-card", estimated: l.source !== "provider" });
  };

  const billedMinutes = Math.ceil(durationSec / 60);
  if (billedMinutes > 0) {
    const inbound = facts.direction === "inbound";
    const tollFree = inbound && TOLL_FREE.test(facts.to);
    const providerCharges = [...usage.telephony.values()];
    const primary = facts.callSid ? providerCharges.find((leg) => leg.callSid === facts.callSid) : providerCharges[0];
    const actualUsd = primary?.currency?.toUpperCase() === "USD" ? primary.price : null;
    add({
      provider: "twilio", type: "transport",
      item: inbound ? (tollFree ? "Voice (inbound, toll-free)" : "Voice (inbound, local)") : "Voice (outbound)",
      quantity: billedMinutes, unit: "min",
      rate: actualUsd !== null ? null : inbound ? (tollFree ? rates.twilio.inboundTollFreePerMin : rates.twilio.inboundLocalPerMin) : rates.twilio.outboundPerMin,
      ...(actualUsd !== null ? { usd: actualUsd, source: "provider" as const } : {}),
      note: actualUsd !== null ? `Provider price for ${primary?.callSid ?? facts.callSid}` : "Estimated using configured destination rates; reconcile against the provider invoice.",
    });
    if (primary?.currency && primary.currency.toUpperCase() !== "USD") warnings.push(`Provider voice price is in ${primary.currency}; USD voice cost remains an estimate.`);
    for (const leg of providerCharges.filter((leg) => leg !== primary)) {
      add({ provider: "twilio", type: "transport", item: `Additional call leg (${leg.callSid})`, quantity: leg.durationSeconds, unit: "sec", usd: leg.currency?.toUpperCase() === "USD" ? leg.price : null, source: leg.price !== null && leg.currency?.toUpperCase() === "USD" ? "provider" : "unpriced" });
    }
    add({ provider: "twilio", type: "transport", item: "Media Streams", quantity: billedMinutes, unit: "min", rate: rates.twilio.mediaStreamsPerMin });
    if (facts.amd && !inbound) add({ provider: "twilio", type: "transport", item: "Answering machine detection", quantity: 1, unit: "call", rate: rates.twilio.amdPerCall });
  }
  if (facts.recordingDurationSec !== undefined) {
    add({ provider: "twilio", type: "transport", item: "Call recording", quantity: Math.ceil(Math.max(0, facts.recordingDurationSec) / 60), unit: "min", rate: rates.twilio.recordingPerMin, note: facts.recordingDurationEstimated ? "Recording duration estimated from call duration; exact recording usage is pending." : "Provider recording duration; configured account recording rate." });
  }
  if (facts.conference) {
    add({ provider: "twilio", type: "transport", item: "Transfer conference", quantity: 0, unit: "unknown", rate: rates.twilio.conferencePerParticipantMin, usd: null, note: "Conference participant duration is not available yet; conference charges are excluded from the known subtotal." });
  }
  for (const [model, seconds] of usage.sttSeconds) {
    add({ provider: "deepgram", type: "transcriber", model, item: `Speech-to-text (${model})`, quantity: seconds / 60, unit: "min", rate: rates.deepgram[model], note: "Submitted audio duration; provider invoice may apply minimums." });
  }
  for (const [model, chars] of usage.ttsChars) {
    add({ provider: "elevenlabs", type: "voice", model, item: `Text-to-speech (${model})`, quantity: chars / 1000, unit: "1k chars", rate: rates.elevenlabs[model], note: "Submitted text, including generated speech interrupted by the caller." });
  }
  for (const t of usage.llm.values()) {
    const model = t.model;
    const unprefixed = model.startsWith(`${t.provider}:`) ? model.slice(t.provider.length + 1) : model;
    const r = rates.models?.[`${t.provider}:${unprefixed}`] ?? (t.provider === "openai" ? rates.openai[unprefixed] : undefined);
    const inputText = Math.max(0, t.prompt - t.inputAudio);
    const cachedText = Math.min(inputText, Math.max(0, t.cached - t.cachedAudio));
    const outputText = Math.max(0, t.completion - t.outputAudio);
    const tokenLine = (item: string, quantity: number, rate: number | undefined) => {
      if (quantity <= 0) return;
      add({ provider: t.provider, type: "model", model, item: `LLM ${item} (${model})`, quantity, unit: "tokens", rate: validRate(rate) ? rate / 1e6 : undefined, note: `${t.requests} requests${t.estimatedRequests ? `; ${t.estimatedRequests} requests have estimated token counts` : ""}` });
    };
    tokenLine("input", inputText - cachedText, r?.input);
    tokenLine("cached input", cachedText, r?.cachedInput);
    tokenLine("output", outputText, r?.output);
    tokenLine("audio input", Math.max(0, t.inputAudio - t.cachedAudio), r?.audioInput);
    tokenLine("cached audio input", t.cachedAudio, r?.audioCachedInput);
    tokenLine("audio output", t.outputAudio, r?.audioOutput);
    if (t.estimatedRequests) warnings.push(`${model}: ${t.estimatedRequests} requests ended without provider usage; token counts are estimates.`);
  }
  const minutes = durationSec / 60;
  if (hosting.monthlyUsd > 0 && hosting.expectedMinutesPerMonth > 0)
    add({ provider: "hosting", type: "hosting", item: "Server share", quantity: minutes, unit: "min", rate: hosting.monthlyUsd / hosting.expectedMinutesPerMonth });
  if (hosting.egressUsdPerGb > 0)
    add({ provider: "hosting", type: "hosting", item: "Data transfer out", quantity: usage.netOutBytes / 1e9, unit: "GB", rate: hosting.egressUsdPerGb });

  const sum = (p: (l: CostLine) => boolean) => round(lines.filter(p).reduce((s, l) => s + (l.usd ?? 0), 0));
  const servicesUsd = sum((l) => l.provider !== "hosting");
  const hostingUsd = sum((l) => l.provider === "hosting");
  const totalUsd = round(servicesUsd + hostingUsd);
  const snapshot = usage.snapshot();
  const llmSum = (key: "prompt" | "completion" | "cached" | "inputAudio" | "outputAudio") => snapshot.llm.reduce((total, item) => total + item[key], 0);
  for (const entry of snapshot.unmetered ?? []) warnings.push(`${entry.provider} ${entry.model}: ${entry.reason}`);
  const incomplete = lines.some((l) => l.usd === null) || !!snapshot.unmetered?.length;
  const estimated = incomplete || lines.some((l) => l.estimated) || snapshot.llm.some((l) => l.estimatedRequests > 0);
  return {
    currency: "USD", durationSec, lines, servicesUsd, hostingUsd, totalUsd,
    knownSubtotalUsd: totalUsd, status: incomplete ? "incomplete" : estimated ? "estimated" : "final",
    calculatedAt: new Date().toISOString(), pricingVersion: createHash("sha256").update(JSON.stringify({ rates, hosting })).digest("hex").slice(0, 16),
    usage: snapshot,
    costBreakdown: {
      llm: sum((l) => l.type === "model"), stt: sum((l) => l.type === "transcriber"), tts: sum((l) => l.type === "voice"),
      transport: sum((l) => l.type === "transport"), hosting: hostingUsd, total: totalUsd,
      llmPromptTokens: llmSum("prompt"), llmCompletionTokens: llmSum("completion"), llmCachedPromptTokens: llmSum("cached"),
      llmInputAudioTokens: llmSum("inputAudio"), llmOutputAudioTokens: llmSum("outputAudio"),
      ttsCharacters: snapshot.voice.reduce((s, entry) => s + entry.characters, 0),
      transcriberSeconds: snapshot.transcriber.reduce((s, entry) => s + entry.audioSeconds, 0),
    }, estimated, warnings,
  };
}

export function formatCost(sid: string, c: CallCost): string {
  const rows = c.lines.map((l) => `  ${l.provider.padEnd(10)} ${l.item.padEnd(42)} ${String(round(l.quantity, 3)).padStart(10)} ${l.unit.padEnd(8)} ${l.usd === null ? "unpriced" : `$${l.usd.toFixed(4)}`}`);
  return [
    `Call cost ${sid} (${Math.round(c.durationSec)}s)`, ...rows,
    `  Services $${c.servicesUsd.toFixed(4)} | Hosting $${c.hostingUsd.toFixed(4)} | ${c.status === "incomplete" ? "KNOWN SUBTOTAL" : "TOTAL"} $${c.totalUsd.toFixed(4)} (${c.status ?? "estimated"})`,
    ...c.warnings.map((w) => `  ! ${w}`),
  ].join("\n");
}

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
  artifactBytes?: number;
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
    lines.push({ ...l, rate, usd: usd === null ? null : round(usd), source: usd === null ? "unpriced" : l.source ?? "rate-card", basis: usd === null ? "unknown" : l.basis ?? (l.source === "provider" ? "provider-charge" : l.type === "hosting" ? "infrastructure-estimate" : "estimated-usage"), estimated: l.source !== "provider" });
  };

  const billedMinutes = Math.ceil(durationSec / 60);
  if (billedMinutes > 0 || [...usage.telephony.values()].some((leg) => leg.price !== null)) {
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
    if (billedMinutes > 0) add({ provider: "twilio", type: "transport", item: "Media Streams", quantity: Math.ceil((usage.mediaSeconds ?? durationSec) / 60), unit: "min", rate: rates.twilio.mediaStreamsPerMin, basis: usage.mediaSeconds !== undefined ? "measured-usage" : "estimated-usage" });
    if (facts.amd && !inbound && billedMinutes > 0) add({ provider: "twilio", type: "transport", item: "Answering machine detection", quantity: 1, unit: "call", rate: rates.twilio.amdPerCall });
  }
  if (facts.recordingDurationSec !== undefined) {
    add({ provider: "twilio", type: "transport", item: "Call recording", quantity: Math.ceil(Math.max(0, facts.recordingDurationSec) / 60), unit: "min", rate: rates.twilio.recordingPerMin, basis: facts.recordingDurationEstimated ? "estimated-usage" : "measured-usage", note: facts.recordingDurationEstimated ? "Recording duration estimated from call duration; exact recording usage is pending." : "Provider recording duration; configured account recording rate." });
  }
  if (facts.conference) {
    add({ provider: "twilio", type: "transport", item: "Transfer conference", quantity: 0, unit: "unknown", rate: rates.twilio.conferencePerParticipantMin, usd: null, note: "Conference participant duration is not available yet; conference charges are excluded from the known subtotal." });
  }
  const requests = [...usage.providerRequests.values()];
  for (const request of requests) {
    if (request.quantity <= 0) continue;
    const common = { provider: request.provider, model: request.model, type: request.kind };
    if (request.usd !== undefined) {
      add({ ...common, item: `Provider request ${request.providerRequestId ?? request.id}`, quantity: request.reportedQuantity ?? request.quantity,
        unit: request.unit, usd: request.usd, source: "provider" });
    } else if (request.kind === "transcriber") {
      add({ ...common, item: `Speech-to-text (${request.model})`, quantity: (request.reportedQuantity ?? request.quantity) / 60, unit: "min", rate: rates.deepgram[request.model],
        basis: request.reportedQuantity !== undefined ? "measured-usage" : "estimated-usage", note: "Submitted audio is an estimate until matched to provider usage." });
    } else if (request.kind === "voice") {
      if (request.credits !== undefined) add({ ...common, item: `Voice credits (${request.model})`, quantity: request.credits, unit: "credits", rate: rates.elevenlabsCreditUsd,
        basis: "measured-usage", note: "Provider-reported credit debit; dollar conversion uses your configured plan rate." });
      else {
        const multiplier = rates.elevenlabsCreditsPerCharacter?.[request.model];
        add({ ...common, item: `Text-to-speech (${request.model})`, quantity: multiplier !== undefined ? request.quantity * multiplier : request.quantity / 1000,
          unit: multiplier !== undefined ? "credits" : "1k chars", rate: multiplier !== undefined ? rates.elevenlabsCreditUsd : rates.elevenlabs[request.model],
          basis: "estimated-usage", note: "Provider credit debit is unavailable. Submitted text includes interrupted generations." });
        warnings.push(`Voice request ${request.id}: actual credit usage is unavailable.`);
      }
    } else add({ ...common, item: `API requests (${request.model})`, quantity: request.quantity, unit: "requests", rate: rates.api?.[request.model],
      basis: "estimated-usage", note: "Attempted requests, including failures; configure a rate for this tool ID." });
    if (request.reconciliation === "unavailable" && request.kind === "transcriber") warnings.push(`Transcription request ${request.id}: provider reconciliation requires a request ID and project usage access.`);
  }
  for (const [model, seconds] of usage.sttSeconds) {
    const residual = Math.max(0, seconds - requests.filter((r) => r.provider === "deepgram" && r.model === model).reduce((sum, r) => sum + r.quantity, 0));
    if (residual > 0) add({ provider: "deepgram", type: "transcriber", model, item: `Speech-to-text (${model})`, quantity: residual / 60, unit: "min", rate: rates.deepgram[model], note: "Legacy submitted audio; per-request charges unavailable." });
  }
  for (const [model, chars] of usage.ttsChars) {
    const residual = Math.max(0, chars - requests.filter((r) => r.provider === "elevenlabs" && r.model === model).reduce((sum, r) => sum + r.quantity, 0));
    if (residual > 0) add({ provider: "elevenlabs", type: "voice", model, item: `Text-to-speech (${model})`, quantity: residual / 1000, unit: "1k chars", rate: rates.elevenlabs[model], note: "Legacy submitted text; actual credits unavailable." });
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
      add({ provider: t.provider, type: "model", model, item: `LLM ${item} (${model})`, quantity, unit: "tokens", basis: t.estimatedRequests ? "estimated-usage" : "measured-usage", rate: validRate(rate) ? rate / 1e6 : undefined, note: `${t.requests} requests${t.estimatedRequests ? `; ${t.estimatedRequests} requests have estimated token counts` : ""}` });
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
  if (hosting.configured === false) add({ provider: "hosting", type: "hosting", item: "Infrastructure allocation", quantity: minutes, unit: "min", usd: null, note: "Configure AWS compute, shared overhead, storage and bandwidth allocation; infrastructure is not free." });
  if (hosting.compute) {
    const c = hosting.compute;
    add({ provider: "hosting", type: "hosting", item: `AWS CPU allocation (${hosting.region ?? "configured region"})`, quantity: durationSec / 3600 * c.vcpuPerCall, unit: "vCPU-hour", rate: c.vcpuHourUsd });
    add({ provider: "hosting", type: "hosting", item: "AWS memory allocation", quantity: durationSec / 3600 * c.memoryGbPerCall, unit: "GB-hour", rate: c.memoryGbHourUsd });
  }
  for (const [service, rate] of Object.entries(hosting.overheadPerMinute ?? {})) add({ provider: "hosting", type: "hosting", item: `Allocated ${service}`, quantity: minutes, unit: "min", rate });
  if (hosting.storage && facts.artifactBytes === undefined) add({ provider: "hosting", type: "hosting", item: "Artifact storage retention", quantity: 0, unit: "unknown", usd: null, note: "Artifact sizes are pending." });
  if (hosting.storage && facts.artifactBytes !== undefined) add({ provider: "hosting", type: "hosting", item: "Artifact storage retention", quantity: facts.artifactBytes / 1024 ** 3 * hosting.storage.retentionDays / 30, unit: "GB-month", rate: hosting.storage.gbMonthUsd });
  if (hosting.monthlyUsd > 0 && hosting.expectedMinutesPerMonth > 0)
    add({ provider: "hosting", type: "hosting", item: "Server share", quantity: minutes, unit: "min", rate: hosting.monthlyUsd / hosting.expectedMinutesPerMonth });
  if (hosting.egressUsdPerGb > 0)
    add({ provider: "hosting", type: "hosting", item: "Data transfer out", quantity: usage.netOutBytes / 1024 ** 3, unit: "GB", rate: hosting.egressUsdPerGb });

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
    currency: "USD", durationSec, durationMinutes: round(durationSec / 60), lines, servicesUsd, hostingUsd, totalUsd,
    reportedUsd: sum((l) => l.basis === "provider-charge"), calculatedUsd: sum((l) => l.basis === "measured-usage"),
    estimatedUsd: sum((l) => l.basis === "estimated-usage" || l.basis === "infrastructure-estimate"), unpricedItems: lines.filter((l) => l.usd === null).length,
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

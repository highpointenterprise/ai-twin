import type { CallCost, CostLine } from "../../lib/types";
import type { UsageMeter } from "./meter";
import type { HostingConfig, Rates } from "./pricing";

export interface CallFacts {
  direction: "inbound" | "outbound";
  to: string;
  durationSec: number;
  amd: boolean;
}
const TOLL_FREE = /^\+1(800|833|844|855|866|877|888)/;
const round = (n: number, d = 6) => Number(n.toFixed(d));

export function priceCall(usage: UsageMeter, facts: CallFacts, rates: Rates, hosting: HostingConfig): CallCost {
  const lines: CostLine[] = [];
  const warnings: string[] = [];
  let estimated = false;
  const add = (l: Omit<CostLine, "usd"> & { usd?: number }) =>
    lines.push({ ...l, usd: round(l.usd ?? l.quantity * l.rate) });

  const billedMinutes = Math.ceil(facts.durationSec / 60); // Twilio bills started minutes
  if (billedMinutes > 0) {
    const inbound = facts.direction === "inbound";
    const tollFree = inbound && TOLL_FREE.test(facts.to);
    add({
      provider: "twilio",
      item: inbound ? (tollFree ? "Voice (inbound, toll-free)" : "Voice (inbound, local)") : "Voice (outbound)",
      quantity: billedMinutes,
      unit: "min",
      rate: inbound ? (tollFree ? rates.twilio.inboundTollFreePerMin : rates.twilio.inboundLocalPerMin) : rates.twilio.outboundPerMin,
    });
    add({ provider: "twilio", item: "Media Streams", quantity: billedMinutes, unit: "min", rate: rates.twilio.mediaStreamsPerMin });
    if (facts.amd && !inbound)
      add({ provider: "twilio", item: "Answering machine detection", quantity: 1, unit: "call", rate: rates.twilio.amdPerCall });
  }
  for (const [model, seconds] of usage.sttSeconds) {
    const rate = rates.deepgram[model];
    if (rate === undefined) warnings.push(`No Deepgram rate for "${model}", counted as $0.`);
    add({ provider: "deepgram", item: `Speech-to-text (${model})`, quantity: round(seconds / 60, 3), unit: "min", rate: rate ?? 0 });
  }
  for (const [model, chars] of usage.ttsChars) {
    const rate = rates.elevenlabs[model];
    if (rate === undefined) warnings.push(`No ElevenLabs rate for "${model}", counted as $0.`);
    add({ provider: "elevenlabs", item: `Text-to-speech (${model})`, quantity: round(chars / 1000, 3), unit: "1k chars", rate: rate ?? 0 });
  }
  for (const [model, t] of usage.llm) {
    const r = rates.openai[model];
    if (!r) warnings.push(`No OpenAI rate for "${model}", counted as $0.`);
    const fresh = Math.max(0, t.prompt - t.cached);
    const usd = r ? (fresh * r.input + t.cached * r.cachedInput + t.completion * r.output) / 1e6 : 0;
    if (t.estimatedRequests) estimated = true;
    add({
      provider: "openai",
      item: `LLM (${model})`,
      quantity: t.prompt + t.completion,
      unit: "tokens",
      rate: 0,
      usd,
      note: `${t.requests} requests, ${fresh} input + ${t.cached} cached + ${t.completion} output` +
        (t.estimatedRequests ? `, ${t.estimatedRequests} interrupted estimated` : ""),
    });
  }
  const minutes = facts.durationSec / 60;
  if (hosting.monthlyUsd > 0 && hosting.expectedMinutesPerMonth > 0)
    add({ provider: "hosting", item: "Server share", quantity: round(minutes, 3), unit: "min", rate: hosting.monthlyUsd / hosting.expectedMinutesPerMonth });
  if (hosting.egressUsdPerGb > 0)
    add({ provider: "hosting", item: "Data transfer out", quantity: round((usage.netInBytes + usage.netOutBytes) / 1e9, 6), unit: "GB", rate: hosting.egressUsdPerGb });

  const sum = (p: (l: CostLine) => boolean) => round(lines.filter(p).reduce((s, l) => s + l.usd, 0));
  const servicesUsd = sum((l) => l.provider !== "hosting");
  const hostingUsd = sum((l) => l.provider === "hosting");
  return { currency: "USD", durationSec: facts.durationSec, lines, servicesUsd, hostingUsd, totalUsd: round(servicesUsd + hostingUsd), estimated, warnings };
}

export function formatCost(sid: string, c: CallCost): string {
  const rows = c.lines.map(
    (l) => `  ${l.provider.padEnd(10)} ${l.item.padEnd(42)} ${String(l.quantity).padStart(10)} ${l.unit.padEnd(8)} $${l.usd.toFixed(4)}`,
  );
  return [
    `── Call cost ${sid} (${Math.round(c.durationSec)}s) ──`,
    ...rows,
    `  Services $${c.servicesUsd.toFixed(4)} | Hosting $${c.hostingUsd.toFixed(4)} | TOTAL $${c.totalUsd.toFixed(4)}${c.estimated ? " (partly estimated)" : ""}`,
    ...c.warnings.map((w) => `  ! ${w}`),
  ].join("\n");
}
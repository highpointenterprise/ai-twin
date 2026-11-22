export type ConversationMode = "standard" | "full-duplex";

import type { AssistantInput } from "./config";
export type AgentConfig = AssistantInput & { id: string };

export type AgentInput = Omit<AgentConfig, "id">;

export type CallStatus =
  | "initiating"
  | "ringing"
  | "connected"
  | "in-progress"
  | "completed"
  | "failed";

export interface LlmUsageTotals {
  provider: string;
  model: string;
  requests: number;
  estimatedRequests: number;
  prompt: number;
  cached: number;
  completion: number;
  reasoning: number;
  inputAudio: number;
  cachedAudio: number;
  outputAudio: number;
}
export interface TelephonyUsage {
  callSid: string;
  durationSeconds: number;
  price: number | null;
  currency: string | null;
  source: "provider" | "callback";
}
export interface CallUsage {
  mediaSeconds?: number;
  requests?: ProviderUsageRequest[];
  unmetered?: { provider: string; model: string; reason: string }[];
  llm: LlmUsageTotals[];
  transcriber: { provider: string; model: string; audioSeconds: number; source: "submitted-audio" }[];
  voice: { provider: string; model: string; characters: number; source: "submitted-text" }[];
  telephony: TelephonyUsage[];
  network: { receivedBytes: number; sentBytes: number };
}
export interface ProviderUsageRequest {
  id: string;
  provider: string;
  model: string;
  kind: "transcriber" | "voice" | "api";
  providerRequestId?: string;
  startedAt: string;
  endedAt?: string;
  quantity: number;
  unit: "seconds" | "characters" | "requests";
  status: "started" | "completed" | "failed";
  reportedQuantity?: number;
  credits?: number;
  usd?: number;
  reconciliation?: "pending" | "matched" | "unavailable";
}
export interface CostLine {
  provider: string;
  type?: "model" | "transcriber" | "voice" | "transport" | "hosting" | "api";
  model?: string;
  item: string;
  quantity: number;
  unit: string;
  rate: number | null;
  usd: number | null;
  source?: "provider" | "rate-card" | "unpriced";
  estimated?: boolean;
  basis?: "provider-charge" | "measured-usage" | "estimated-usage" | "infrastructure-estimate" | "unknown";
  note?: string;
}
export interface CallCost {
  currency: "USD";
  durationSec: number;
  durationMinutes?: number;
  reportedUsd?: number;
  calculatedUsd?: number;
  estimatedUsd?: number;
  unpricedItems?: number;
  lines: CostLine[];
  servicesUsd: number;
  hostingUsd: number;
  /** Known subtotal only when status is incomplete. */
  totalUsd: number;
  knownSubtotalUsd?: number;
  status?: "estimated" | "incomplete" | "final";
  calculatedAt?: string;
  pricingVersion?: string;
  reconciliationStatus?: "pending" | "complete";
  relatedCalls?: { callId: string; totalUsd: number | null; status: string }[];
  totalWithRelatedUsd?: number;
  usage?: CallUsage;
  costBreakdown?: {
    llm: number; stt: number; tts: number; transport: number; hosting: number; total: number;
    llmPromptTokens: number; llmCompletionTokens: number; llmCachedPromptTokens: number;
    llmInputAudioTokens: number; llmOutputAudioTokens: number; ttsCharacters: number;
    transcriberSeconds: number;
  };
  estimated: boolean;
  warnings: string[];
}

export interface CallRecord {
  sid: string;
  agentId: string;
  direction: "inbound" | "outbound";
  from: string;
  to: string;
  status: CallStatus;
  updatedAt: number;
  endedReason?: string;
  answeredBy?: string;
  screeningEncountered?: boolean;
  transferStatus?: string;
  transferId?: string;
  operatorCallSid?: string;
  parentCallSid?: string;
  requestId?: string;
  cost?: CallCost;
}

export interface PhoneNumberView {
  id?: string;
  sid: string;
  phoneNumber: string;
  label: string;
  agentId: string | null;
  capabilities?: { voice: boolean; sms: boolean; mms: boolean };
  voiceUrl?: string;
  routingStatus?: "ready" | "needs-update" | "unassigned";
}

export interface VoiceOption {
  id: string;
  name: string;
}

export interface TranscriptLine {
  at: number;
  role: "caller" | "agent";
  text: string;
  latencyMs?: number;
}

export interface TraceEvent {
  at: number;
  event: string;
  detail: Record<string, string | number | boolean>;
}

export interface CallTraceView {
  startedAt: number;
  stats: {
    turns: number;
    avgLatencyMs: number;
    p50LatencyMs: number;
    maxLatencyMs: number;
  };
  transcript: TranscriptLine[];
  events: TraceEvent[];
}

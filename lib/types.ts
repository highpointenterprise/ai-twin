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
}

export interface PhoneNumberView {
  sid: string;
  phoneNumber: string;
  label: string;
  agentId: string | null;
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

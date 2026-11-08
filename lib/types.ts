export type ConversationMode = "standard" | "full-duplex";

export interface AgentConfig {
  id: string;
  name: string;
  greeting: string;
  systemPrompt: string;
  mode: ConversationMode;
  voiceId: string;
  realtimeVoice: string;
  model: string;
  temperature: number;
}

export type AgentInput = Omit<AgentConfig, "id">;

export type CallStatus = "initiating" | "ringing" | "connected" | "in-progress" | "completed" | "failed";

export interface CallRecord {
  sid: string;
  agentId: string;
  direction: "inbound" | "outbound";
  from: string;
  to: string;
  status: CallStatus;
  updatedAt: number;
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
  stats: { turns: number; avgLatencyMs: number; p50LatencyMs: number; maxLatencyMs: number };
  transcript: TranscriptLine[];
  events: TraceEvent[];
}

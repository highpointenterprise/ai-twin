import type { AgentConfig } from "../../lib/types";
import type { CallTrace } from "../observability/trace";

export interface TranscriberEvents {
  onSpeechStart: () => void;
  onPartial: (text: string) => void;
  onEagerEnd: (text: string) => void;
  onResume: () => void;
  onEnd: (text: string) => void;
  onError: (error: Error) => void;
}

export interface Transcriber {
  sendAudio: (chunk: Buffer) => void;
  close: () => void;
}

export type TranscriberFactory = (events: TranscriberEvents) => Transcriber;

export interface SpeechSynthesizer {
  push: (text: string) => Promise<void>;
  end: () => Promise<void>;
  close: () => void;
}

export type SynthesizerFactory = (voiceId: string, onAudio: (mulawBase64: string) => void) => SpeechSynthesizer;

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ModelRequest {
  messages: ChatMessage[];
  model: string;
  temperature: number;
}

export interface LanguageModel {
  stream: (request: ModelRequest, signal: AbortSignal) => AsyncIterable<string>;
  complete: (request: ModelRequest) => Promise<string>;
}

export interface RealtimeConfig {
  instructions: string;
  voice: string;
  model: string;
}

export interface RealtimeEvents {
  onReady: () => void;
  onAudio: (mulawBase64: string, itemId: string) => void;
  onUserSpeechStart: () => void;
  onUserSpeechStop: () => void;
  onUserTranscript: (text: string) => void;
  onAgentTranscript: (text: string) => void;
  onResponseDone: () => void;
  onError: (message: string) => void;
}

export interface RealtimeClient {
  sendAudio: (mulawBase64: string) => void;
  say: (text: string) => void;
  truncate: (itemId: string, audioEndMs: number) => void;
  close: () => void;
}

export type RealtimeFactory = (config: RealtimeConfig, events: RealtimeEvents) => RealtimeClient;

export interface TelephonyNumber {
  sid: string;
  phoneNumber: string;
  label: string;
}

export interface Telephony {
  listNumbers: () => Promise<TelephonyNumber[]>;
  routeInbound: (numberSid: string, voiceUrl: string, statusUrl: string) => Promise<void>;
  placeCall: (request: { to: string; from: string; twiml: string; statusUrl: string }) => Promise<string>;
  validateWebhook: (url: string, params: Record<string, string>, signature: string) => boolean;
  streamTwiml: (wsUrl: string, params: Record<string, string>) => string;
  rejectTwiml: (message: string) => string;
}

export interface EngineDeps {
  transcribe: TranscriberFactory;
  synthesize: SynthesizerFactory;
  model: LanguageModel;
}

export interface ConversationSession {
  pushAudio: (mulawBase64: string) => void;
  handleMark: (name: string) => void;
  close: () => void;
}

export interface SessionInit {
  agent: AgentConfig;
  brief: string;
  streamSid: string;
  send: (message: object) => void;
  trace: CallTrace;
}

export type SessionFactory = (init: SessionInit) => ConversationSession;

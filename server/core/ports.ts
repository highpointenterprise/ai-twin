import type { ToolConfig } from "../../lib/config";
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

export type TranscriberFactory = (
  events: TranscriberEvents,
  config?: AgentConfig["transcriber"],
) => Transcriber;

export interface SpeechSynthesizer {
  push: (text: string) => Promise<void>;
  end: () => Promise<void>;
  close: () => void;
}

export type SynthesizerFactory = (
  voiceId: string,
  onAudio: (mulawBase64: string) => void,
  config?: AgentConfig["voice"],
) => SpeechSynthesizer;

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  toolCalls?: ToolCall[];
  toolCallId?: string;
  content: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}
export interface ModelTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
export type ModelDelta =
  | { type: "text"; text: string }
  | { type: "tool-call"; call: ToolCall };
export interface ToolOutcome {
  result: unknown;
  terminal?: boolean;
  waitForUser?: boolean;
}
export interface ToolContext {
  callSid: string;
  signal: AbortSignal;
  speak: (text: string) => Promise<void>;
  playAudio: (audio: Buffer) => Promise<void>;
}
export interface ModelRequest {
  messages: ChatMessage[];
  tools?: ModelTool[];
  model: string;
  temperature: number;
}

export interface LanguageModel {
  stream: (
    request: ModelRequest,
    signal: AbortSignal,
  ) => AsyncIterable<ModelDelta>;
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

export type RealtimeFactory = (
  config: RealtimeConfig,
  events: RealtimeEvents,
) => RealtimeClient;

export interface TelephonyNumber {
  sid: string;
  phoneNumber: string;
  label: string;
}

export interface Telephony {
  listNumbers: () => Promise<TelephonyNumber[]>;
  routeInbound: (
    numberSid: string,
    voiceUrl: string,
    statusUrl: string,
  ) => Promise<void>;
  placeCall: (request: {
    to: string;
    from: string;
    url: string;
    statusUrl: string;
    voicemail: AgentConfig["voicemailDetection"];
  }) => Promise<string>;
  transferCall: (
    sid: string,
    destination: { number: string; extension: string },
    timeout: number,
    statusUrl: string,
  ) => Promise<void>;
  endCall: (sid: string) => Promise<void>;
  validateWebhook: (
    url: string,
    params: Record<string, string>,
    signature: string,
  ) => boolean;
  streamTwiml: (wsUrl: string, params: Record<string, string>) => string;
  rejectTwiml: (message: string) => string;
}

export interface EngineDeps {
  transcribe: TranscriberFactory;
  synthesize: SynthesizerFactory;
  model: LanguageModel;
  executeTool?: (
    tool: ToolConfig,
    call: ToolCall,
    context: ToolContext,
  ) => Promise<ToolOutcome>;
  endCall?: (sid: string, reason: string) => Promise<void>;
  onScreening?: (sid: string) => void;
}

export interface ConversationSession {
  pushAudio: (mulawBase64: string) => void;
  handleDtmf?: (digit: string) => void;
  handleMark: (name: string) => void;
  close: () => void;
}

export interface SessionInit {
  callSid: string;
  purpose?: "conversation" | "voicemail";
  direction?: "inbound" | "outbound";
  tools?: ToolConfig[];
  agent: AgentConfig;
  brief: string;
  streamSid: string;
  send: (message: object) => void;
  trace: CallTrace;
}

export type SessionFactory = (init: SessionInit) => ConversationSession;

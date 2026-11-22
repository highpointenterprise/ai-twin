import type { CallCost, TranscriptLine } from "../../../../lib/types";
import type { StoredCall } from "../../../storage/calls";
import type { CallRequestDocument } from "../repositories/call-requests";
import type { PhoneNumberDocument } from "../repositories/resources";

export type VapiCallStatus = "scheduled" | "queued" | "ringing" | "in-progress" | "forwarding" | "ended";

export interface CallViewInput {
  orgId: string;
  baseUrl: string;
  request?: CallRequestDocument;
  call?: StoredCall;
  phoneNumbers: ReadonlyMap<string, PhoneNumberDocument>;
  transcript?: readonly TranscriptLine[];
}

const ENDED_REASONS: Readonly<Record<string, string>> = {
  "user-ended": "assistant-forced-hangup",
  voicemail: "voicemail",
  "answer-detection-ended": "voicemail",
  "max-duration": "exceeded-max-duration",
  "silence-timeout": "silence-timed-out",
  "screening-timeout": "silence-timed-out",
  "no-answer": "customer-did-not-answer",
  busy: "customer-busy",
  failed: "twilio-failed-to-connect-call",
  canceled: "assistant-forced-hangup",
  "server-restarted": "call.in-progress.error-server-restarted",
  "media-session-error": "phone-call-provider-closed-websocket",
  "transcriber-error": "pipeline-error-deepgram-transcriber-failed",
  "speech-provider-error": "pipeline-error-eleven-labs-voice-failed",
};

export const vapiEndedReason = (raw: string | undefined, status: VapiCallStatus): string | undefined => {
  if (status !== "ended") return undefined;
  if (!raw) return "customer-ended-call";
  if (raw.startsWith("transfer-") || raw.includes("transfer")) return "assistant-forwarded-call";
  if (raw.startsWith("media-stream-error")) return "phone-call-provider-closed-websocket";
  if (raw.endsWith("-provider-error")) return "pipeline-error-openai-llm-failed";
  return ENDED_REASONS[raw] ?? raw;
};

export const vapiStatus = (request?: CallRequestDocument, call?: StoredCall): VapiCallStatus => {
  if (request?.phase === "scheduled") return "scheduled";
  if (request?.phase === "queued" || request?.phase === "dialing") return "queued";
  if (request?.phase === "failed") return "ended";
  if (!call) return "queued";
  switch (call.status) {
    case "initiating":
      return "queued";
    case "ringing":
      return "ringing";
    case "completed":
    case "failed":
      return "ended";
    default:
      return call.transferStatus === "initiated" ? "forwarding" : "in-progress";
  }
};

const iso = (value: number | string | undefined): string | undefined =>
  value === undefined ? undefined : new Date(value).toISOString();

const costView = (cost: CallCost | undefined) => {
  if (!cost) return {};
  const breakdown = cost.costBreakdown;
  return {
    cost: cost.totalUsd,
    ...(breakdown
      ? {
          costBreakdown: {
            transport: breakdown.transport,
            stt: breakdown.stt,
            llm: breakdown.llm,
            tts: breakdown.tts,
            vapi: breakdown.hosting,
            total: breakdown.total,
            llmPromptTokens: breakdown.llmPromptTokens,
            llmCompletionTokens: breakdown.llmCompletionTokens,
            llmCachedPromptTokens: breakdown.llmCachedPromptTokens,
            ttsCharacters: breakdown.ttsCharacters,
          },
        }
      : {}),
    costs: cost.lines.map((line) => ({
      type: line.type === "hosting" ? "vapi" : (line.type ?? "model"),
      provider: line.provider,
      cost: line.usd ?? 0,
      ...(line.unit === "minute" || line.unit === "minutes" ? { minutes: line.quantity } : {}),
    })),
  };
};

const artifactView = (id: string, baseUrl: string, call: StoredCall | undefined, transcript?: readonly TranscriptLine[]) => {
  const stored = call?.artifact ?? {};
  const url = (path: string) => `${baseUrl}/call/${encodeURIComponent(id)}/${path}`;
  const started = Date.parse(call?.startedAt ?? call?.createdAt ?? "") || 0;
  const messages = transcript?.map((line) => ({
    role: line.role === "caller" ? "user" : "bot",
    message: line.text,
    time: line.at,
    secondsFromStart: Math.max(0, (line.at - started) / 1000),
    ...(line.latencyMs !== undefined ? { duration: line.latencyMs } : {}),
  }));
  return {
    ...(messages
      ? {
          messages,
          messagesOpenAIFormatted: transcript?.map((line) => ({
            role: line.role === "caller" ? "user" : "assistant",
            content: line.text,
          })),
          transcript: transcript?.map((line) => `${line.role === "caller" ? "User" : "AI"}: ${line.text}`).join("\n"),
        }
      : {}),
    ...(stored.recording
      ? { stereoRecordingUrl: url("stereo-recording"), recording: { stereoUrl: url("stereo-recording") } }
      : {}),
    ...(stored.monoRecording
      ? {
          recordingUrl: url("mono-recording"),
          recording: {
            ...(stored.recording ? { stereoUrl: url("stereo-recording") } : {}),
            mono: {
              combinedUrl: url("mono-recording"),
              ...(stored.customerRecording ? { customerUrl: url("customer-recording") } : {}),
              ...(stored.assistantRecording ? { assistantUrl: url("assistant-recording") } : {}),
            },
          },
        }
      : {}),
    ...(stored.logs ? { logUrl: url("call-logs") } : {}),
  };
};

export const toVapiCall = (input: CallViewInput): Record<string, unknown> => {
  const { request, call, orgId, baseUrl } = input;
  const id = request?.id ?? call!.id;
  const status = vapiStatus(request, call);
  const outbound = request ? true : call!.direction === "outbound";
  const number = request ? request.customer.number : outbound ? call!.to : call!.from;
  const ownNumber = request ? request.from : outbound ? call!.from : call!.to;
  const phoneNumber = input.phoneNumbers.get(ownNumber);
  const updatedMs = Math.max(
    request ? Date.parse(request.updatedAt) : 0,
    call?.updatedAt ?? 0,
  );
  const failure = request?.phase === "failed" ? request.failure : undefined;
  const artifact = artifactView(id, baseUrl, call, input.transcript);
  return {
    id,
    orgId,
    type: outbound ? "outboundPhoneCall" : "inboundPhoneCall",
    status,
    ...(status === "ended"
      ? { endedReason: failure?.reason ?? vapiEndedReason(call?.endedReason, status) }
      : {}),
    ...(failure ? { endedMessage: failure.message } : {}),
    ...(request?.name ? { name: request.name } : {}),
    ...(request?.assistantId ?? call?.assistantId ? { assistantId: request?.assistantId ?? call?.assistantId } : {}),
    ...(request?.transientAssistant ? { assistant: request.transientAssistant } : {}),
    ...(request?.assistantOverrides ? { assistantOverrides: request.assistantOverrides } : {}),
    ...(request?.phoneNumberId ?? phoneNumber?.id ? { phoneNumberId: request?.phoneNumberId ?? phoneNumber?.id } : {}),
    customer: { number, ...(request?.customer.name ? { name: request.customer.name } : {}) },
    ...(request?.schedulePlan ? { schedulePlan: request.schedulePlan } : {}),
    phoneCallProvider: "twilio",
    phoneCallTransport: "pstn",
    ...(request?.providerCallSid ?? call?.sid ? { phoneCallProviderId: request?.providerCallSid ?? call?.sid } : {}),
    createdAt: request?.createdAt ?? call!.createdAt,
    updatedAt: iso(updatedMs),
    ...(call?.startedAt ? { startedAt: call.startedAt } : {}),
    ...(call?.endedAt ? { endedAt: call.endedAt } : {}),
    ...costView(call?.cost),
    ...(Object.keys(artifact).length ? { artifact } : {}),
  };
};

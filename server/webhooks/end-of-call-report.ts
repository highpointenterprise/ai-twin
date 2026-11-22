import type { AgentConfig, CallCost, TranscriptLine } from "../../lib/types";
import type { StoredCall } from "../storage/calls";
import { vapiEndedReason } from "../api/v1/mappers/call";

export interface ReportArtifact {
  messages: {
    role: string;
    message: string;
    time: number;
    endTime?: number;
    secondsFromStart: number;
  }[];
  messagesOpenAIFormatted: { role: string; content: string }[];
  transcript: string;
  recording?: {
    stereoUrl?: string;
    mono?: {
      combinedUrl?: string;
      customerUrl?: string;
      assistantUrl?: string;
    };
  };
  recordingUrl?: string;
  stereoRecordingUrl?: string;
  logUrl?: string;
  presignedMonoUrl?: string;
  presignedStereoUrl?: string;
  presignedAssistantUrl?: string;
  presignedCustomerUrl?: string;
  presignedLogUrl?: string;
  presignedUrlsExpiresAt?: string;
}
export interface EndOfCallReport {
  message: {
    type: "end-of-call-report";
    timestamp: number;
    endedReason: string;
    artifact: ReportArtifact;
    analysis: Record<string, never>;
    startedAt?: string;
    endedAt: string;
    assistant?: Record<string, unknown>;
    customer: { number: string; name?: string };
    cost?: number;
    costs?: Record<string, unknown>[];
    call: Record<string, unknown>;
  };
}
export type ServerEvent = EndOfCallReport;
export type ServerEventType = ServerEvent["message"]["type"];

function modelConfig(model: string) {
  const match = /^(openrouter|groq|cerebras|together|custom):(.+)$/.exec(model);
  return {
    provider:
      match?.[1] === "together"
        ? "together-ai"
        : match?.[1] === "custom"
          ? "custom-llm"
          : (match?.[1] ?? "openai"),
    model: match?.[2] ?? model,
  };
}
function assistantView(a: AgentConfig): Record<string, unknown> {
  const model = modelConfig(a.model);
  return {
    name: a.name,
    ...(model.provider !== "custom-llm"
      ? {
          model: {
            ...model,
            messages: [{ role: "system", content: a.systemPrompt }],
            temperature: a.temperature,
            toolIds: a.toolIds,
          },
        }
      : {}),
    voice: { ...a.voice, voiceId: a.voiceId },
    transcriber: {
      provider: "deepgram",
      model: a.transcriber.model,
      eotThreshold: a.transcriber.eotThreshold,
      eotTimeoutMs: a.transcriber.eotTimeoutMs,
    },
    firstMessage: a.firstMessage,
    firstMessageMode: a.firstMessageMode,
    maxDurationSeconds: a.maxDurationSeconds,
    startSpeakingPlan: { waitSeconds: a.startSpeakingPlan.waitSeconds },
    stopSpeakingPlan: {
      numWords: a.stopSpeakingPlan.numWords,
      voiceSeconds: a.stopSpeakingPlan.voiceSeconds,
      backoffSeconds: a.stopSpeakingPlan.backoffSeconds,
      acknowledgementPhrases: a.stopSpeakingPlan.acknowledgementPhrases,
      interruptionPhrases: a.stopSpeakingPlan.interruptionPhrases,
    },
    ...(a.voicemailDetection.enabled
      ? {
          voicemailDetection: {
            provider: "twilio",
            machineDetectionTimeout:
              a.voicemailDetection.detectionTimeoutSeconds,
          },
          ...(a.voicemailDetection.action === "leave-message"
            ? { voicemailMessage: a.voicemailDetection.message }
            : {}),
        }
      : {}),
    ...(a.server?.url
      ? { server: a.server, serverMessages: ["end-of-call-report"] }
      : {}),
  };
}
function costView(
  cost: CallCost | undefined,
  assistant?: AgentConfig,
): {
  cost?: number;
  costs?: Record<string, unknown>[];
  costBreakdown?: Record<string, number>;
} {
  if (!cost) return {};
  const groups = new Map<string, typeof cost.lines>();
  for (const line of cost.lines) {
    const key = `${line.type}:${line.provider}:${line.model ?? ""}`;
    groups.set(key, [...(groups.get(key) ?? []), line]);
  }
  const costs: Record<string, unknown>[] = [];
  for (const lines of groups.values()) {
    const first = lines[0];
    // Unknown charges are not fabricated as zero-dollar provider costs.
    if (lines.some((line) => line.usd === null)) continue;
    const usd = Number(
      lines.reduce((sum, line) => sum + line.usd!, 0).toFixed(8),
    );
    switch (first.type) {
      case "transport":
        costs.push({
          type: "transport",
          provider: "twilio",
          minutes: cost.durationSec / 60,
          cost: usd,
        });
        break;
      case "hosting":
        costs.push({
          type: "vapi",
          subType: "normal",
          minutes: cost.durationSec / 60,
          cost: usd,
        });
        break;
      case "transcriber":
        costs.push({
          type: "transcriber",
          transcriber: { provider: first.provider, model: first.model },
          minutes: lines.reduce((sum, line) => sum + line.quantity, 0),
          cost: usd,
        });
        break;
      case "voice":
        costs.push({
          type: "voice",
          voice: {
            provider: "11labs",
            model: first.model,
            ...(assistant?.voiceId ? { voiceId: assistant.voiceId } : {}),
          },
          characters: lines.reduce(
            (sum, line) => sum + line.quantity * 1000,
            0,
          ),
          cost: usd,
        });
        break;
      case "model": {
        const usage = cost.usage?.llm.find(
          (u) => u.provider === first.provider && u.model === first.model,
        );
        if (usage)
          costs.push({
            type: "model",
            model: {
              ...modelConfig(usage.model),
              provider:
                usage.provider === "together"
                  ? "together-ai"
                  : usage.provider === "custom"
                    ? "custom-llm"
                    : usage.provider,
            },
            promptTokens: usage.prompt,
            completionTokens: usage.completion,
            cachedPromptTokens: usage.cached,
            reasoningTokens: usage.reasoning,
            cost: usd,
          });
      }
    }
  }
  const b = cost.costBreakdown;
  return {
    cost: cost.totalUsd,
    costs,
    ...(b
      ? {
          costBreakdown: {
            transport: b.transport,
            stt: b.stt,
            llm: b.llm,
            tts: b.tts,
            vapi: b.hosting,
            total: b.total,
            llmPromptTokens: b.llmPromptTokens,
            llmCompletionTokens: b.llmCompletionTokens,
            llmCachedPromptTokens: b.llmCachedPromptTokens,
            ttsCharacters: b.ttsCharacters,
          },
        }
      : {}),
  };
}
const knownReasons = new Set([
  "customer-ended-call",
  "assistant-ended-call",
  "assistant-forced-hangup",
  "assistant-forwarded-call",
  "voicemail",
  "silence-timed-out",
  "exceeded-max-duration",
  "customer-busy",
  "customer-did-not-answer",
  "twilio-failed-to-connect-call",
  "phone-call-provider-closed-websocket",
  "pipeline-error-deepgram-transcriber-failed",
  "pipeline-error-eleven-labs-voice-failed",
  "pipeline-error-openai-llm-failed",
]);

// Vapi contract: https://docs.vapi.ai/api-reference/webhooks/server-message
export function endOfCallReport(input: {
  call: StoredCall;
  transcript: TranscriptLine[];
  orgId: string;
  baseUrl: string;
  callId?: string;
  customerName?: string;
  name?: string;
  phoneNumberId?: string;
  createdAt?: string;
  timestamp?: number;
}): EndOfCallReport {
  const { call, transcript } = input;
  if (!["completed", "failed"].includes(call.status) || !call.endedAt)
    throw new Error("Cannot report a live call.");
  const id = input.callId ?? call.requestId ?? call.id;
  const start = Date.parse(call.startedAt ?? call.createdAt);
  const messages: ReportArtifact["messages"] = [
    ...(call.assistant?.systemPrompt
      ? [
          {
            role: "system",
            message: call.assistant.systemPrompt,
            time: start,
            secondsFromStart: 0,
          },
        ]
      : []),
    // Stored transcript entries are point-in-time observations, not measured audio segments.
    ...transcript.map((line) => ({
      role: line.role === "caller" ? "user" : "bot",
      message: line.text,
      time: line.at,
      endTime: line.at,
      secondsFromStart: Math.max(0, (line.at - start) / 1000),
    })),
  ];
  const artifact: ReportArtifact = {
    messages,
    messagesOpenAIFormatted: messages.map((m) => ({
      role: m.role === "bot" ? "assistant" : m.role,
      content: m.message,
    })),
    transcript: transcript
      .map((line) => `${line.role === "caller" ? "User" : "AI"}: ${line.text}`)
      .join("\n"),
  };
  const url = (path: string) =>
    `${input.baseUrl}/call/${encodeURIComponent(id)}/${path}`;
  if (call.artifact?.recording) {
    artifact.recording = { stereoUrl: url("stereo-recording") };
    artifact.stereoRecordingUrl = url("stereo-recording");
  }
  if (call.artifact?.monoRecording) {
    artifact.recording = {
      ...artifact.recording,
      mono: {
        combinedUrl: url("mono-recording"),
        ...(call.artifact.customerRecording
          ? { customerUrl: url("customer-recording") }
          : {}),
        ...(call.artifact.assistantRecording
          ? { assistantUrl: url("assistant-recording") }
          : {}),
      },
    };
    artifact.recordingUrl = url("mono-recording");
  }
  if (call.artifact?.logs) artifact.logUrl = url("call-logs");
  const mapped = vapiEndedReason(
    call.endedReason ?? (call.status === "failed" ? "failed" : undefined),
    "ended",
  )!;
  const endedReason = knownReasons.has(mapped)
    ? mapped
    : call.status === "failed"
      ? call.startedAt
        ? "phone-call-provider-closed-websocket"
        : "twilio-failed-to-connect-call"
      : "customer-ended-call";
  const customer = {
    number: call.direction === "inbound" ? call.from : call.to,
    ...(input.customerName ? { name: input.customerName } : {}),
  };
  const costs = costView(call.cost, call.assistant);
  const analysis = {};
  return {
    message: {
      type: "end-of-call-report",
      timestamp: input.timestamp ?? Date.now(),
      endedReason,
      artifact,
      analysis,
      ...(call.startedAt ? { startedAt: call.startedAt } : {}),
      endedAt: call.endedAt,
      ...(call.assistant ? { assistant: assistantView(call.assistant) } : {}),
      customer,
      ...(costs.cost !== undefined
        ? { cost: costs.cost, costs: costs.costs }
        : {}),
      call: {
        id,
        orgId: input.orgId,
        assistantId: call.assistantId,
        type: call.type,
        status: "ended",
        endedReason,
        ...(mapped !== endedReason || call.cost?.warnings.length
          ? {
              endedMessage: [
                mapped !== endedReason ? call.endedReason : "",
                ...(call.cost?.warnings ?? []),
              ]
                .filter(Boolean)
                .join(" "),
            }
          : {}),
        customer,
        createdAt: input.createdAt ?? call.createdAt,
        ...(input.name ? { name: input.name } : {}),
        ...(input.phoneNumberId ? { phoneNumberId: input.phoneNumberId } : {}),
        updatedAt: new Date(call.updatedAt).toISOString(),
        ...(call.startedAt ? { startedAt: call.startedAt } : {}),
        endedAt: call.endedAt,
        phoneCallProvider: "twilio",
        phoneCallProviderId: call.sid,
        phoneCallTransport: "pstn",
        ...costs,
        artifact,
        analysis,
      },
    },
  };
}

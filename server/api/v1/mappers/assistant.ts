import { assistantSchema, type AssistantInput } from "../../../../lib/config";
import type { AgentConfig } from "../../../../lib/types";
import { badRequest } from "../http/errors";
import { assistantBodySchema, type AssistantBody } from "../schemas/assistant";
import { deepMerge, isPlainObject } from "../schemas/common";

export interface AssistantDocument extends AgentConfig {
  orgId: string;
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

export interface VapiAssistant extends AssistantBody {
  id: string;
  orgId: string;
  createdAt: string;
  updatedAt: string;
}

const DEFAULT_NAME = "Untitled Assistant";
const DEFAULT_PROMPT = "You are a helpful voice assistant. Keep replies concise and conversational.";

const systemPrompt = (body: AssistantBody): string => {
  const messages = body.model?.messages ?? [];
  if (messages.some((entry) => entry.role !== "system"))
    throw badRequest("model.messages: only messages with role system are supported");
  return messages.map((entry) => entry.content).join("\n\n").trim() || DEFAULT_PROMPT;
};

const transcriberModel = (body: AssistantBody): "flux-general-en" | "flux-general-multi" =>
  body.transcriber?.model ?? (body.transcriber?.language === "multi" ? "flux-general-multi" : "flux-general-en");

export const toAgentInput = (body: AssistantBody): AssistantInput => {
  const detection = body.voicemailDetection;
  const voicemailEnabled = detection !== undefined && detection !== "off" && detection.enabled !== false;
  const timeout = detection && detection !== "off" ? detection.machineDetectionTimeout : undefined;
  return assistantSchema.parse({
    name: body.name ?? DEFAULT_NAME,
    server: body.server,
    systemPrompt: systemPrompt(body),
    firstMessage: body.firstMessage,
    firstMessageMode: body.firstMessageMode,
    voiceId: body.voice?.voiceId,
    model: body.model?.model,
    temperature: body.model?.temperature,
    toolIds: body.model?.toolIds,
    transcriber: {
      model: transcriberModel(body),
      eotThreshold: body.transcriber?.endOfTurnConfidenceThreshold,
      eagerEotThreshold: body.transcriber?.eagerEndOfTurnConfidenceThreshold,
      eotTimeoutMs: body.transcriber?.eotTimeoutMs,
    },
    voice: {
      model: body.voice?.model,
      stability: body.voice?.stability,
      similarityBoost: body.voice?.similarityBoost,
      speed: body.voice?.speed,
    },
    startSpeakingPlan: { waitSeconds: body.startSpeakingPlan?.waitSeconds },
    stopSpeakingPlan: body.stopSpeakingPlan ?? {},
    voicemailDetection: {
      enabled: voicemailEnabled,
      action: body.voicemailMessage ? "leave-message" : "hangup",
      message: body.voicemailMessage ?? "",
      detectionTimeoutSeconds: timeout,
    },
    silenceTimeoutSeconds: body.silenceTimeoutSeconds,
    maxDurationSeconds: body.maxDurationSeconds,
  });
};

export const toVapiAssistant = (document: AssistantDocument): VapiAssistant => {
  const voicemail = document.voicemailDetection;
  return {
    id: document.id,
    orgId: document.orgId,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
    name: document.name,
    server: document.server ?? { url: "", timeoutSeconds: 20 },
    model: {
      provider: "openai",
      model: document.model,
      messages: [{ role: "system", content: document.systemPrompt }],
      temperature: document.temperature,
      toolIds: document.toolIds,
    },
    voice: {
      provider: "11labs",
      voiceId: document.voiceId,
      model: document.voice.model,
      stability: document.voice.stability,
      similarityBoost: document.voice.similarityBoost,
      speed: document.voice.speed,
    },
    transcriber: {
      provider: "deepgram",
      model: document.transcriber.model,
      endOfTurnConfidenceThreshold: document.transcriber.eotThreshold,
      eagerEndOfTurnConfidenceThreshold: document.transcriber.eagerEotThreshold,
      eotTimeoutMs: document.transcriber.eotTimeoutMs,
    },
    firstMessage: document.firstMessage,
    firstMessageMode: document.firstMessageMode,
    voicemailDetection: voicemail.enabled
      ? { provider: "twilio", enabled: true, machineDetectionTimeout: voicemail.detectionTimeoutSeconds }
      : "off",
    ...(voicemail.enabled && voicemail.action === "leave-message" ? { voicemailMessage: voicemail.message } : {}),
    silenceTimeoutSeconds: document.silenceTimeoutSeconds,
    maxDurationSeconds: document.maxDurationSeconds,
    startSpeakingPlan: { waitSeconds: document.startSpeakingPlan.waitSeconds },
    stopSpeakingPlan: {
      numWords: document.stopSpeakingPlan.numWords,
      voiceSeconds: document.stopSpeakingPlan.voiceSeconds,
      backoffSeconds: document.stopSpeakingPlan.backoffSeconds,
      acknowledgementPhrases: document.stopSpeakingPlan.acknowledgementPhrases,
      interruptionPhrases: document.stopSpeakingPlan.interruptionPhrases,
    },
    ...(document.metadata ? { metadata: document.metadata } : {}),
  };
};

export const editableAssistant = (document: AssistantDocument): AssistantBody => {
  const { id: _id, orgId: _orgId, createdAt: _createdAt, updatedAt: _updatedAt, ...body } = toVapiAssistant(document);
  return body;
};

export const mergeAssistant = (base: AssistantBody, patch: unknown): AssistantBody => {
  const source: Record<string, unknown> = structuredClone(base) as Record<string, unknown>;
  if (isPlainObject(patch) && isPlainObject(patch.transcriber) && patch.transcriber.language && !patch.transcriber.model && isPlainObject(source.transcriber))
    delete source.transcriber.model;
  return assistantBodySchema.parse(deepMerge(source, patch));
};

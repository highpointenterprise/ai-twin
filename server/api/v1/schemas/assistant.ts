import { z } from "zod";
import { assistantServerSchema } from "../../../../lib/assistant-server";
import { listQuerySchema } from "./common";

const message = z
  .object({
    role: z.enum(["system", "assistant", "user"]),
    content: z.string().max(16000),
  })
  .strict();

const modelSchema = z
  .object({
    provider: z.literal("openai").optional(),
    model: z.string().trim().min(1).max(128).optional(),
    messages: z.array(message).max(20).optional(),
    temperature: z.number().min(0).max(1.2).optional(),
    toolIds: z.array(z.string().uuid()).max(30).optional(),
  })
  .strict();

const voiceSchema = z
  .object({
    provider: z.literal("11labs").optional(),
    voiceId: z.string().trim().max(128).optional(),
    model: z.enum(["eleven_flash_v2_5", "eleven_turbo_v2_5", "eleven_multilingual_v2"]).optional(),
    stability: z.number().min(0).max(1).optional(),
    similarityBoost: z.number().min(0).max(1).optional(),
    speed: z.number().min(0.7).max(1.2).optional(),
  })
  .strict();

const transcriberSchema = z
  .object({
    provider: z.literal("deepgram").optional(),
    model: z.enum(["flux-general-en", "flux-general-multi"]).optional(),
    language: z.enum(["en", "multi"]).optional(),
    endOfTurnConfidenceThreshold: z.number().min(0.5).max(0.9).optional(),
    eagerEndOfTurnConfidenceThreshold: z.number().min(0.3).max(0.9).nullable().optional(),
    eotTimeoutMs: z.number().int().min(500).max(10000).optional(),
  })
  .strict();

const phrases = z.array(z.string().trim().min(1).max(150)).max(30);

const startSpeakingPlanSchema = z.object({ waitSeconds: z.number().min(0).max(5).optional() }).strict();

const stopSpeakingPlanSchema = z
  .object({
    numWords: z.number().int().min(0).max(10).optional(),
    voiceSeconds: z.number().min(0.1).max(2).optional(),
    backoffSeconds: z.number().min(0).max(5).optional(),
    acknowledgementPhrases: phrases.optional(),
    interruptionPhrases: phrases.optional(),
  })
  .strict();

const voicemailDetectionSchema = z.union([
  z.literal("off"),
  z
    .object({
      provider: z.literal("twilio"),
      enabled: z.boolean().optional(),
      machineDetectionTimeout: z.number().int().min(3).max(59).optional(),
    })
    .strict(),
]);

export const assistantBodySchema = z
  .object({
    name: z.string().trim().min(1).max(40).optional(),
    server: assistantServerSchema.optional(),
    model: modelSchema.optional(),
    voice: voiceSchema.optional(),
    transcriber: transcriberSchema.optional(),
    firstMessage: z.string().trim().max(1500).optional(),
    firstMessageMode: z
      .enum([
        "assistant-speaks-first",
        "assistant-waits-for-user",
        "assistant-speaks-first-with-model-generated-message",
      ])
      .optional(),
    voicemailDetection: voicemailDetectionSchema.optional(),
    voicemailMessage: z.string().trim().max(1500).optional(),
    silenceTimeoutSeconds: z.number().min(10).max(600).optional(),
    maxDurationSeconds: z.number().int().min(30).max(7200).optional(),
    startSpeakingPlan: startSpeakingPlanSchema.optional(),
    stopSpeakingPlan: stopSpeakingPlanSchema.optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type AssistantBody = z.infer<typeof assistantBodySchema>;

export const assistantOverridesSchema = assistantBodySchema
  .extend({ variableValues: z.record(z.string(), z.unknown()).optional() })
  .strict();
export type AssistantOverrides = z.infer<typeof assistantOverridesSchema>;

export const assistantListQuerySchema = listQuerySchema;

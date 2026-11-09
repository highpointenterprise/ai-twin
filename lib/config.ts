import { z } from "zod";
export const e164 = z
  .string()
  .regex(/^\+[1-9]\d{6,14}$/, "Use an E.164 number, e.g. +14155550123.");
const phrases = z.array(z.string().trim().min(1).max(150)).max(30);
export const transcriberSchema = z.object({
  provider: z.literal("deepgram").default("deepgram"),
  model: z
    .enum(["flux-general-en", "flux-general-multi"])
    .default("flux-general-en"),
  eotThreshold: z.number().min(0.5).max(0.9).default(0.7),
  eotTimeoutMs: z.number().int().min(500).max(10000).default(5000),
});
export const voiceSchema = z.object({
  provider: z.literal("11labs").default("11labs"),
  model: z
    .enum(["eleven_flash_v2_5", "eleven_turbo_v2_5", "eleven_multilingual_v2"])
    .default("eleven_flash_v2_5"),
  stability: z.number().min(0).max(1).default(0.5),
  similarityBoost: z.number().min(0).max(1).default(0.75),
  speed: z.number().min(0.7).max(1.2).default(1),
});
export const startSpeakingSchema = z.object({
  waitSeconds: z.number().min(0).max(5).default(0.4),
  smartEndpointingProvider: z.literal("deepgram-flux").default("deepgram-flux"),
});
export const stopSpeakingSchema = z.object({
  numWords: z.number().int().min(0).max(10).default(2),
  voiceSeconds: z.number().min(0.1).max(2).default(0.2),
  backoffSeconds: z.number().min(0).max(5).default(0.8),
  acknowledgementPhrases: phrases.default(["yeah", "okay", "uh huh", "right"]),
  interruptionPhrases: phrases.default(["stop", "wait", "hold on"]),
});
export const voicemailSchema = z
  .object({
    enabled: z.boolean().default(false),
    provider: z.literal("twilio").default("twilio"),
    action: z.enum(["hangup", "leave-message"]).default("hangup"),
    message: z.string().trim().max(1500).default(""),
    detectionTimeoutSeconds: z.number().int().min(3).max(59).default(30),
    unknownAction: z.enum(["continue", "hangup"]).default("continue"),
  })
  .superRefine((v, ctx) => {
    if (v.enabled && v.action === "leave-message" && !v.message)
      ctx.addIssue({
        code: "custom",
        path: ["message"],
        message: "Enter a voicemail message.",
      });
  });
export const screeningSchema = z
  .object({
    enabled: z.boolean().default(false),
    response: z.string().trim().max(500).default(""),
    waitSeconds: z.number().int().min(15).max(120).default(60),
  })
  .superRefine((v, ctx) => {
    if (v.enabled && !v.response)
      ctx.addIssue({
        code: "custom",
        path: ["response"],
        message: "Enter your name and purpose for screeners.",
      });
  });
export const assistantSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    systemPrompt: z.string().trim().min(1).max(16000),
    firstMessage: z
      .string()
      .trim()
      .max(1500)
      .default("Hello! How can I help you today?"),
    firstMessageMode: z
      .enum([
        "assistant-speaks-first",
        "assistant-waits-for-user",
        "assistant-speaks-first-with-model-generated-message",
      ])
      .default("assistant-speaks-first"),
    mode: z.literal("standard").default("standard"),
    voiceId: z.string().trim().max(128).default(""),
    realtimeVoice: z.string().default("marin"),
    model: z.string().trim().min(1).max(64).default("gpt-4.1"),
    temperature: z.number().min(0).max(1.2).default(0.7),
    transcriber: transcriberSchema.default({}),
    voice: voiceSchema.default({}),
    startSpeakingPlan: startSpeakingSchema.default({}),
    stopSpeakingPlan: stopSpeakingSchema.default({}),
    voicemailDetection: voicemailSchema.default({}),
    callScreening: screeningSchema.default({}),
    toolIds: z.array(z.string().uuid()).max(30).default([]),
    silenceTimeoutSeconds: z.number().min(10).max(600).default(60),
    maxDurationSeconds: z.number().int().min(30).max(7200).default(1800),
  })
  .superRefine((v, ctx) => {
    if (v.firstMessageMode === "assistant-speaks-first" && !v.firstMessage)
      ctx.addIssue({
        code: "custom",
        path: ["firstMessage"],
        message: "Enter a first message or choose another mode.",
      });
    if (new Set(v.toolIds).size !== v.toolIds.length)
      ctx.addIssue({
        code: "custom",
        path: ["toolIds"],
        message: "Attach each tool once.",
      });
  });
const toolBase = {
  name: z
    .string()
    .regex(
      /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/,
      "Use a function name, e.g. lookup_customer.",
    ),
  description: z.string().trim().min(1).max(2000),
};
export const warmTransferSchema = z.object({
  operatorPrompt: z
    .string()
    .trim()
    .max(8000)
    .default(
      "Brief the recipient on why the caller needs help, answer relevant questions, and ask whether they can take the call.",
    ),
  firstMessage: z.string().trim().max(1500).default(""),
  maxDurationSeconds: z.number().int().min(30).max(600).default(120),
  silenceTimeoutSeconds: z.number().int().min(10).max(120).default(30),
  bridgeTimeoutSeconds: z.number().int().min(10).max(60).default(20),
  connectMessage: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .default("Thank you. I am connecting the caller now."),
  fallbackMessage: z
    .string()
    .trim()
    .min(1)
    .max(1000)
    .default(
      "I couldn't connect you with the team. I'm still here and can continue helping you.",
    ),
  endCallOnFailure: z.boolean().default(false),
  holdAudioUrl: z
    .string()
    .url()
    .refine((v) => {
      const u = new URL(v);
      return u.protocol === "https:" && !u.username && !u.password;
    }, "Use a public HTTPS audio URL.")
    .optional(),
});
export type WarmTransferPlan = z.infer<typeof warmTransferSchema>;
export const destinationSchema = z.object({
  id: z.string().min(1).max(64),
  number: e164,
  description: z.string().trim().max(1000).default(""),
  transferPhrase: z.string().trim().max(150).default(""),
  message: z.string().trim().max(500).default("Transferring your call now."),
  extension: z
    .string()
    .regex(/^[0-9*#wW]*$/)
    .max(32)
    .default(""),
});
export const toolSchema = z
  .discriminatedUnion("type", [
    z.object({
      ...toolBase,
      type: z.literal("transferCall"),
      transferMode: z.enum(["blind", "warm"]).default("blind"),
      warmTransfer: warmTransferSchema.default({}),
      routingMode: z.enum(["description", "phrase"]).default("description"),
      destinations: z.array(destinationSchema).min(1).max(20),
      timeoutSeconds: z.number().int().min(5).max(120).default(30),
    }),
    z.object({
      ...toolBase,
      type: z.literal("dtmf"),
      toneDurationMs: z.number().int().min(100).max(1000).default(200),
      gapMs: z.number().int().min(50).max(1000).default(100),
    }),
    z.object({
      ...toolBase,
      type: z.literal("function"),
      parameters: z.record(z.unknown()),
      server: z.object({
        url: z
          .string()
          .url()
          .refine((v) => {
            const u = new URL(v);
            return u.protocol === "https:" && !u.username && !u.password;
          }, "Use HTTPS without embedded credentials."),
        timeoutSeconds: z.number().int().min(1).max(60).default(15),
        secretEnv: z
          .string()
          .regex(/^TOOL_[A-Z0-9_]+$/)
          .optional(),
      }),
    }),
  ])
  .superRefine((v, ctx) => {
    if (v.type !== "transferCall") return;
    if (new Set(v.destinations.map((d) => d.id)).size !== v.destinations.length)
      ctx.addIssue({
        code: "custom",
        path: ["destinations"],
        message: "Destination IDs must be unique.",
      });
    for (const [i, d] of v.destinations.entries())
      if (!(v.routingMode === "phrase" ? d.transferPhrase : d.description))
        ctx.addIssue({
          code: "custom",
          path: ["destinations", i],
          message: "Provide a routing description or phrase.",
        });
  });
export type AssistantInput = z.infer<typeof assistantSchema>;
export type ToolInput = z.infer<typeof toolSchema>;
export type ToolConfig = ToolInput & { id: string };

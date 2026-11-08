import { z } from "zod";

export const E164_PATTERN = /^\+[1-9]\d{6,14}$/;

export const agentInputSchema = z.object({
  name: z.string().trim().min(1).max(60),
  greeting: z.string().trim().min(1).max(300),
  systemPrompt: z.string().trim().min(1).max(8000),
  mode: z.enum(["standard", "full-duplex"]),
  voiceId: z.string().trim().min(1).max(64),
  realtimeVoice: z.string().trim().min(1).max(32),
  model: z.string().trim().min(1).max(64),
  temperature: z.number().min(0).max(1.2),
});

export const callRequestSchema = z.object({
  agentId: z.string().uuid(),
  to: z.string().regex(E164_PATTERN, "Use E.164 format, like +14155550123."),
  context: z.string().trim().max(2000).optional(),
  plannedMinutes: z.number().int().min(1).max(120).optional(),
});

export const assignRequestSchema = z.object({ agentId: z.string().uuid() });

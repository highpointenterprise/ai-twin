import { z } from "zod";

export const E164_PATTERN = /^\+[1-9]\d{6,14}$/;

export { assistantSchema as agentInputSchema } from "../../lib/config";

export const callRequestSchema = z.object({
  agentId: z.string().uuid(),
  to: z.string().regex(E164_PATTERN, "Use E.164 format, like +14155550123."),
  from: z.string().regex(E164_PATTERN).optional(),
  context: z.string().trim().max(2000).optional(),
  plannedMinutes: z.number().int().min(1).max(120).optional(),
});

export const assignRequestSchema = z.object({ agentId: z.string().uuid() });

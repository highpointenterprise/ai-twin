import { z } from "zod";
import { e164 } from "../../../../lib/config";
import { assistantBodySchema, assistantOverridesSchema } from "./assistant";
import { limitShape, resourceId, timeRangeShape } from "./common";

const customerSchema = z
  .object({
    number: e164,
    name: z.string().trim().min(1).max(40).optional(),
    numberE164CheckEnabled: z.boolean().optional(),
  })
  .strict();
export type CustomerBody = z.infer<typeof customerSchema>;

const schedulePlanSchema = z
  .object({
    earliestAt: z.string().datetime({ offset: true }),
    latestAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict()
  .refine((plan) => !plan.latestAt || Date.parse(plan.latestAt) >= Date.parse(plan.earliestAt), {
    message: "latestAt must not be before earliestAt",
    path: ["latestAt"],
  });

export const createCallSchema = z
  .object({
    name: z.string().trim().min(1).max(40).optional(),
    assistantId: z.string().uuid().optional(),
    assistant: assistantBodySchema.optional(),
    assistantOverrides: assistantOverridesSchema.optional(),
    phoneNumberId: z.string().uuid().optional(),
    customer: customerSchema.optional(),
    customers: z.array(customerSchema).min(1).max(1000).optional(),
    schedulePlan: schedulePlanSchema.optional(),
  })
  .strict()
  .superRefine((body, context) => {
    if (!body.assistantId === !body.assistant)
      context.addIssue({ code: "custom", message: "Provide exactly one of assistantId or assistant", path: ["assistantId"] });
    if (!body.customer === !body.customers)
      context.addIssue({ code: "custom", message: "Provide exactly one of customer or customers", path: ["customer"] });
  });
export type CreateCallBody = z.infer<typeof createCallSchema>;

export const updateCallSchema = z.object({ name: z.string().trim().min(1).max(40).optional() }).strict();

export const callListQuerySchema = z
  .object({
    id: resourceId.optional(),
    assistantId: z.string().uuid().optional(),
    phoneNumberId: z.string().uuid().optional(),
    ...limitShape,
    ...timeRangeShape,
  })
  .strict();
export type CallListQuery = z.infer<typeof callListQuerySchema>;

export const idempotencyKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,128}$/)
  .optional();

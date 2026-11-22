import { z } from "zod";
import { e164 } from "../../../../lib/config";
import { listQuerySchema, timeRangeShape } from "./common";

export const phoneNumberCreateSchema = z
  .object({
    provider: z.literal("twilio"),
    number: e164,
    twilioAccountSid: z
      .string()
      .regex(/^AC[a-f0-9]{32}$/i)
      .optional(),
    twilioAuthToken: z.string().max(128).optional(),
    smsEnabled: z.boolean().optional(),
    name: z.string().trim().min(1).max(40).optional(),
    assistantId: z.string().uuid().nullable().optional(),
  })
  .strict();
export type PhoneNumberCreate = z.infer<typeof phoneNumberCreateSchema>;

export const phoneNumberUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(40).optional(),
    assistantId: z.string().uuid().nullable().optional(),
    twilioAccountSid: z
      .string()
      .regex(/^AC[a-f0-9]{32}$/i)
      .optional(),
    twilioAuthToken: z.string().max(128).optional(),
    smsEnabled: z.boolean().optional(),
  })
  .strict();
export type PhoneNumberUpdate = z.infer<typeof phoneNumberUpdateSchema>;

export const phoneNumberListQuerySchema = listQuerySchema;

export const phoneNumberPageQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(1000).default(100),
    sortOrder: z.enum(["ASC", "DESC"]).default("DESC"),
    search: z.string().trim().max(100).optional(),
    cursor: z.string().max(512).optional(),
    ...timeRangeShape,
  })
  .strict();
export type PhoneNumberPageQuery = z.infer<typeof phoneNumberPageQuerySchema>;

import { z } from "zod";
import { e164 } from "./config";

export const numberSearchSchema = z
  .object({
    country: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{2}$/)
      .default("US"),
    type: z.enum(["local", "tollFree", "mobile"]).default("local"),
    contains: z
      .string()
      .trim()
      .regex(/^[0-9]*$/)
      .max(15)
      .default(""),
  })
  .strict();
export type NumberSearch = z.infer<typeof numberSearchSchema>;
export const numberPurchaseSchema = numberSearchSchema.extend({
  phoneNumber: e164,
  monthlyPrice: z.string().regex(/^\d+(\.\d+)?$/),
  currency: z.string().regex(/^[A-Z]{3}$/),
  confirmPurchase: z.literal(true),
  addressSid: z
    .string()
    .regex(/^AD[a-f0-9]{32}$/i)
    .optional(),
  bundleSid: z
    .string()
    .regex(/^BU[a-f0-9]{32}$/i)
    .optional(),
});
export type NumberPurchase = z.infer<typeof numberPurchaseSchema>;
export const numberAssignmentSchema = z
  .object({ agentId: z.string().uuid().nullable() })
  .strict();
export const numberRenameSchema = z
  .object({ label: z.string().trim().min(1).max(64) })
  .strict();
export interface AvailableNumber {
  phoneNumber: string;
  locality: string;
  region: string;
  country: string;
  capabilities: { voice: boolean; sms: boolean; mms: boolean };
  addressRequirements: string;
}
export interface NumberSearchResult {
  numbers: AvailableNumber[];
  monthlyPrice: string;
  currency: string;
}

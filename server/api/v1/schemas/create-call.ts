import { z } from "zod";
import { e164 } from "../../../../lib/config";
const value = z.union([z.string().max(16000), z.number().finite(), z.boolean(), z.null()]);
const reserved = new Set(["clientId", "agentId", "fromNumber", "toNumber", "customData", "__proto__", "constructor", "prototype"]);
export const simpleCallSchema = z.object({
  clientId: z.string().uuid(), agentId: z.string().uuid(),
  fromNumber: e164.optional(), toNumber: e164,
  contactId: z.string().max(128).optional(), email: z.string().email().max(254).optional(),
  full_name: z.string().trim().min(1).max(40).optional(),
  customData: z.record(z.string().max(128), value).optional(),
}).catchall(value).superRefine((body, ctx) => {
  for (const key of Object.keys(body.customData ?? {})) if (reserved.has(key)) ctx.addIssue({ code: "custom", path: ["customData", key], message: "Routing and reserved fields cannot be overridden by customData." });
  if (Object.keys(body).length + Object.keys(body.customData ?? {}).length > 100) ctx.addIssue({ code: "custom", message: "At most 100 fields are allowed." });
});
export type SimpleCallBody = z.infer<typeof simpleCallSchema>;

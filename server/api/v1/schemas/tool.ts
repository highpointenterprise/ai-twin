import { z } from "zod";
import { e164 } from "../../../../lib/config";
import { listQuerySchema } from "./common";

const functionName = z
  .string()
  .regex(/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/, "Use a function name, e.g. lookup_customer.");

const httpsUrl = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  }, "Use HTTPS without embedded credentials.");

const serverSchema = z
  .object({
    url: httpsUrl,
    timeoutSeconds: z.number().int().min(1).max(60).optional(),
    secretEnv: z
      .string()
      .regex(/^TOOL_[A-Z0-9_]+$/)
      .optional(),
  })
  .strict();

const functionTool = z
  .object({
    type: z.literal("function"),
    function: z
      .object({
        name: functionName,
        description: z.string().trim().min(1).max(2000),
        parameters: z.record(z.unknown()),
      })
      .strict(),
    server: serverSchema,
    async: z.literal(false).optional(),
  })
  .strict();

const destination = z
  .object({
    type: z.literal("number"),
    number: e164,
    name: z.string().min(1).max(64).optional(),
    description: z.string().trim().max(1000).optional(),
    message: z.string().trim().max(500).optional(),
    extension: z
      .string()
      .regex(/^[0-9*#wW]*$/)
      .max(32)
      .optional(),
    transferPlan: z
      .object({
        mode: z.enum([
          "blind-transfer",
          "warm-transfer-say-message",
          "warm-transfer-say-summary",
          "warm-transfer-wait-for-operator-to-speak-first-and-then-say-message",
        ]),
        message: z.string().trim().max(1500).optional(),
        timeout: z.number().int().min(5).max(120).optional(),
        holdAudioUrl: httpsUrl.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const functionInfo = z
  .object({ name: functionName.optional(), description: z.string().trim().min(1).max(2000).optional() })
  .strict();

const transferTool = z
  .object({
    type: z.literal("transferCall"),
    function: functionInfo.optional(),
    destinations: z.array(destination).min(1).max(20),
  })
  .strict();

const dtmfTool = z.object({ type: z.literal("dtmf"), function: functionInfo.optional() }).strict();

export const toolBodySchema = z.discriminatedUnion("type", [functionTool, transferTool, dtmfTool]);
export type ToolBody = z.infer<typeof toolBodySchema>;

export const toolListQuerySchema = listQuerySchema;

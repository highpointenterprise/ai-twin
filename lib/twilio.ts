import { z } from "zod";
import type { PhoneNumberView } from "./types";

export const twilioCredentialsSchema = z
  .object({
    accountSid: z
      .string()
      .trim()
      .regex(
        /^AC[a-f0-9]{32}$/i,
        "Enter a Twilio Account SID starting with AC followed by 32 hexadecimal characters.",
      ),
    authToken: z
      .string()
      .trim()
      .regex(/^[a-f0-9]{32}$/i, "Enter your 32-character Twilio Auth Token."),
  })
  .strict();
export type TwilioCredentials = z.infer<typeof twilioCredentialsSchema>;
export interface TwilioConnectionStatus {
  configured: boolean;
  accountSid: string | null;
  source: "workspace" | "environment" | "none";
}
export interface TwilioConnectionResult {
  connection: TwilioConnectionStatus;
  numbers: PhoneNumberView[];
  missing: string[];
}

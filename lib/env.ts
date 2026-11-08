import { z } from "zod";

const schema = z.object({
  TWILIO_ACCOUNT_SID: z.string().startsWith("AC"),
  TWILIO_AUTH_TOKEN: z.string().min(1),
  TWILIO_PHONE_NUMBER: z.string().optional(),
  DEEPGRAM_API_KEY: z.string().min(1),
  OPENAI_API_KEY: z.string().min(1),
  OPENAI_MODEL: z.string().default("gpt-4.1"),
  OPENAI_REALTIME_MODEL: z.string().default("gpt-realtime-2"),
  OPENAI_SUMMARY_MODEL: z.string().default("gpt-4.1-mini"),
  ELEVENLABS_API_KEY: z.string().min(1),
  ELEVENLABS_VOICE_ID: z.string().min(1),
  PUBLIC_BASE_URL: z
    .string()
    .url()
    .startsWith("https://")
    .transform((value) => value.replace(/\/+$/, "")),
  STREAM_SECRET: z.string().min(32),
  PORT: z.coerce.number().int().positive().default(8080),
  ADMIN_PORT: z.coerce.number().int().positive().default(8081),
  MAX_CONCURRENT_CALLS: z.coerce.number().int().positive().default(50),
});

export const env = schema.parse(process.env);

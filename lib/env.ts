import { z } from "zod";
const schema = z.object({
  TWILIO_ACCOUNT_SID: z.string().default(""),
  TWILIO_AUTH_TOKEN: z.string().default(""),
  TWILIO_PHONE_NUMBER: z.string().optional(),
  DEEPGRAM_API_KEY: z.string().default(""),
  OPENAI_API_KEY: z.string().default(""),
  OPENAI_MODEL: z.string().default("gpt-4.1"),
  OPENAI_REALTIME_MODEL: z.string().default("gpt-realtime-2"),
  OPENAI_SUMMARY_MODEL: z.string().default("gpt-4.1-mini"),
  ELEVENLABS_API_KEY: z.string().default(""),
  ELEVENLABS_VOICE_ID: z.string().default(""),
  PUBLIC_BASE_URL: z
    .string()
    .default("")
    .transform((v) => v.replace(/\/+$/, "")),
  STREAM_SECRET: z.string().default(""),
  PORT: z.coerce.number().int().positive().default(8080),
  ADMIN_PORT: z.coerce.number().int().positive().default(8081),
  MAX_CONCURRENT_CALLS: z.coerce.number().int().positive().default(50),
  DATA_DIR: z.string().default(".data"),
  FUNCTION_ALLOWED_HOSTS: z.string().default(""),
});
export const env = schema.parse(process.env);
export const missingCallConfiguration = (): string[] => {
  const names = [
    "TWILIO_ACCOUNT_SID",
    "TWILIO_AUTH_TOKEN",
    "DEEPGRAM_API_KEY",
    "OPENAI_API_KEY",
    "ELEVENLABS_API_KEY",
  ] as const;
  const missing: string[] = names.filter((k) => !env[k]);
  if (
    env.TWILIO_ACCOUNT_SID &&
    !/^AC[a-f0-9]{32}$/i.test(env.TWILIO_ACCOUNT_SID)
  )
    missing.push("TWILIO_ACCOUNT_SID (invalid)");
  try {
    const u = new URL(env.PUBLIC_BASE_URL);
    if (
      u.protocol !== "https:" ||
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      u.pathname !== "/"
    )
      throw new Error();
  } catch {
    missing.push("PUBLIC_BASE_URL (public HTTPS origin)");
  }
  if (env.STREAM_SECRET.length < 32)
    missing.push("STREAM_SECRET (at least 32 characters)");
  return missing;
};

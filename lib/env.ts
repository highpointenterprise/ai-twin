import "dotenv/config";
import { z } from "zod";
import type { TwilioCredentials } from "./twilio";
const schema = z.object({
  TWILIO_ACCOUNT_SID: z.string().default(""),
  TWILIO_AUTH_TOKEN: z.string().default(""),
  TWILIO_PHONE_NUMBER: z.string().optional(),
  DEEPGRAM_API_KEY: z.string().default(""),
  DEEPGRAM_PROJECT_ID: z.string().default(""),
  OPENAI_API_KEY: z.string().default(""),
  OPENROUTER_API_KEY: z.string().default(""),
  GROQ_API_KEY: z.string().default(""),
  CEREBRAS_API_KEY: z.string().default(""),
  TOGETHER_API_KEY: z.string().default(""),
  CUSTOM_LLM_BASE_URL: z
    .string()
    .default("")
    .refine(
      (v) => !v || /^https:\/\/[^/@\s]+(\/.*)?$/.test(v),
      "CUSTOM_LLM_BASE_URL must be an https URL without credentials.",
    ),
  CUSTOM_LLM_API_KEY: z.string().default(""),
  OPENAI_MODEL: z.string().default("gpt-4.1"),
  OPENAI_REASONING_EFFORT: z
    .enum(["none", "minimal", "low", "medium", "high"])
    .default("none"),
  OPENAI_REALTIME_MODEL: z.string().default("gpt-realtime-2"),
  OPENAI_SUMMARY_MODEL: z.string().default("gpt-4.1-mini"),
  ELEVENLABS_API_KEY: z.string().default(""),
  ELEVENLABS_VOICE_ID: z.string().default(""),
  PUBLIC_BASE_URL: z
    .string()
    .default("")
    .transform((v) => v.replace(/\/+$/, "")),
  STREAM_SECRET: z.string().default(""),
  PORT: z.coerce.number().int().min(0).default(8080),
  ADMIN_PORT: z.coerce.number().int().min(0).default(8081),
  WORKSPACE_USER_ID: z.string().default(""),
  AUTH_DATABASE: z.string().default(""),
  OBJECT_PREFIX: z.string().default(""),
  MAX_WORKSPACE_WORKERS: z.coerce.number().int().min(1).max(256).default(32),
  WORKSPACE_DATABASE_FORMAT: z.enum(["legacy", "compact"]).default("legacy"),
  ADMIN_HOST: z.string().default("127.0.0.1"),
  AUTH_APP_URL: z.string().default(""),
  AUTH_EMAIL_FROM: z.string().default(""),
  AUTH_EMAIL_REGION: z.string().default("us-east-2"),
  AUTH_API_SECRET: z.string().default(""),
  MAX_CONCURRENT_CALLS: z.coerce.number().int().positive().default(50),
  MONGODB_URI: z.string().default("mongodb://127.0.0.1:27017"),
  MONGODB_DATABASE: z.string().default("ai_twin"),
  REDIS_PREFIX: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/)
    .default("ai-twin"),
  REDIS_URL: z.string().default("redis://127.0.0.1:6379"),
  S3_ENDPOINT: z.string().url().default("http://127.0.0.1:9000"),
  S3_REGION: z.string().default("auto"),
  S3_BUCKET: z.string().default("call-artifacts"),
  S3_ACCESS_KEY_ID: z.string().default(""),
  S3_SECRET_ACCESS_KEY: z.string().default(""),
  S3_FORCE_PATH_STYLE: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  CREDENTIAL_ENCRYPTION_KEY: z.string().default(""),
  RECORDING_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  CALLS_PER_MINUTE: z.coerce.number().int().positive().default(60),
  DATA_DIR: z.string().default(".data"),
  FUNCTION_ALLOWED_HOSTS: z.string().default(""),
  LIVEAVATAR_API_KEY: z.string().default(""),
  LIVEAVATAR_AVATAR_ID: z.string().default(""),
  CHROMIUM_EXECUTABLE_PATH: z.string().default(""),
  MEET_GOOGLE_STORAGE_STATE_PATH: z.string().default(""),
  MEET_CHROMIUM_NO_SANDBOX: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  HOSTING_MONTHLY_USD: z.coerce.number().min(0).default(0),
  HOSTING_EXPECTED_MINUTES_PER_MONTH: z.coerce
    .number()
    .positive()
    .default(10000),
  HOSTING_EGRESS_USD_PER_GB: z.coerce.number().min(0).default(0),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
  API_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(600),
  MAX_QUEUED_CALLS: z.coerce.number().int().positive().default(10000),
  DISPATCH_POLL_MS: z.coerce.number().int().min(100).max(60000).default(1000),
  DIAL_PARALLELISM: z.coerce.number().int().min(1).max(100).default(10),
  CALL_START_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  WEBHOOK_RECORDING_WAIT_SECONDS: z.coerce.number().int().min(0).max(1800).default(600),
  FFPROBE_PATH: z.string().default("ffprobe"),
  FFMPEG_PATH: z.string().default("ffmpeg"),
  RECORDING_CUSTOMER_CHANNEL: z.enum(["0", "1"]).default("0").transform(Number),
  MAX_CONCURRENT_MEETINGS: z.coerce.number().int().min(1).max(10).default(2),
});
export const env = schema.parse(process.env);
export const missingCallConfiguration = (
  twilio?: TwilioCredentials,
): string[] => {
  const configured = {
    ...env,
    ...(twilio
      ? {
          TWILIO_ACCOUNT_SID: twilio.accountSid,
          TWILIO_AUTH_TOKEN: twilio.authToken,
        }
      : {}),
  };
  const names = [
    "TWILIO_ACCOUNT_SID",
    "TWILIO_AUTH_TOKEN",
    "DEEPGRAM_API_KEY",
    "OPENAI_API_KEY",
    "ELEVENLABS_API_KEY",
  ] as const;
  const missing: string[] = names.filter((k) => !configured[k]);
  if (
    configured.TWILIO_ACCOUNT_SID &&
    !/^AC[a-f0-9]{32}$/i.test(configured.TWILIO_ACCOUNT_SID)
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
      u.pathname !== (env.WORKSPACE_USER_ID ? `/workspaces/${env.WORKSPACE_USER_ID}` : "/")
    )
      throw new Error();
  } catch {
    missing.push("PUBLIC_BASE_URL (public HTTPS origin)");
  }
  if (env.STREAM_SECRET.length < 32)
    missing.push("STREAM_SECRET (at least 32 characters)");
  return missing;
};

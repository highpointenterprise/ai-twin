import { env } from "../../lib/env";

export type ProviderId =
  | "openai"
  | "openrouter"
  | "groq"
  | "cerebras"
  | "together"
  | "custom";

export interface ProviderEndpoint {
  readonly baseURL?: string;
  readonly apiKey: () => string;
  readonly keyName: string;
}

const PROVIDERS: Readonly<Record<ProviderId, ProviderEndpoint>> = {
  openai: { apiKey: () => env.OPENAI_API_KEY, keyName: "OPENAI_API_KEY" },
  openrouter: {
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: () => env.OPENROUTER_API_KEY,
    keyName: "OPENROUTER_API_KEY",
  },
  groq: {
    baseURL: "https://api.groq.com/openai/v1",
    apiKey: () => env.GROQ_API_KEY,
    keyName: "GROQ_API_KEY",
  },
  cerebras: {
    baseURL: "https://api.cerebras.ai/v1",
    apiKey: () => env.CEREBRAS_API_KEY,
    keyName: "CEREBRAS_API_KEY",
  },
  together: {
    baseURL: "https://api.together.xyz/v1",
    apiKey: () => env.TOGETHER_API_KEY,
    keyName: "TOGETHER_API_KEY",
  },
  custom: {
    baseURL: env.CUSTOM_LLM_BASE_URL || undefined,
    apiKey: () => env.CUSTOM_LLM_API_KEY,
    keyName: "CUSTOM_LLM_API_KEY",
  },
};

export interface ModelRoute {
  readonly provider: ProviderId;
  readonly model: string;
  readonly endpoint: ProviderEndpoint;
}

const isProvider = (value: string): value is ProviderId =>
  Object.hasOwn(PROVIDERS, value);

export const resolveModel = (spec: string): ModelRoute => {
  const separator = spec.indexOf(":");
  const prefix = separator > 0 ? spec.slice(0, separator) : "";
  const provider: ProviderId = isProvider(prefix) ? prefix : "openai";
  const model = isProvider(prefix) ? spec.slice(separator + 1) : spec;
  if (!model) throw new Error(`Model name is missing in "${spec}".`);
  const endpoint = PROVIDERS[provider];
  if (provider === "custom" && !endpoint.baseURL)
    throw new Error("CUSTOM_LLM_BASE_URL is not configured.");
  if (!endpoint.apiKey())
    throw new Error(
      `${endpoint.keyName} is not configured for model "${spec}".`,
    );
  return { provider, model, endpoint };
};

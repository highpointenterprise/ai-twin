import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { env } from "../../lib/env";
import type { ChatMessage, LanguageModel, ToolCall } from "../core/ports";
import { providerAgent } from "./network";
import { resolveModel, type ModelRoute } from "./model-routing";
const isReasoningModel = (model: string): boolean => /^(gpt-5|o\d)/.test(model);
const sampling = (
  route: ModelRoute,
  temperature: number,
  limit: number,
): { temperature?: number; max_tokens?: number } =>
  (route.provider === "openai" && isReasoningModel(route.model)
    ? {
        max_completion_tokens: limit,
        reasoning_effort: env.OPENAI_REASONING_EFFORT,
      }
    : { temperature, max_tokens: limit }) as unknown as {
    temperature?: number;
    max_tokens?: number;
  };
const convert = (messages: ChatMessage[]): ChatCompletionMessageParam[] =>
  messages.map((m) => {
    if (m.role === "tool")
      return { role: "tool", content: m.content, tool_call_id: m.toolCallId! };
    if (m.role === "assistant")
      return {
        role: "assistant",
        content: m.content || null,
        tool_calls: m.toolCalls?.map((t) => ({
          id: t.id,
          type: "function",
          function: { name: t.name, arguments: t.arguments },
        })),
      };
    return { role: m.role, content: m.content };
  });
export const createOpenAiModel = (): LanguageModel => {
  const clients = new Map<string, OpenAI>();
  const client = (route: ModelRoute): OpenAI => {
    const key = `${route.provider}`;
    const existing = clients.get(key);
    if (existing) return existing;
    const created = new OpenAI({
      apiKey: route.endpoint.apiKey(),
      baseURL: route.endpoint.baseURL,
      httpAgent: providerAgent(),
      maxRetries: 0,
      timeout: 30000,
    });
    clients.set(key, created);
    return created;
  };
  return {
    async *stream({ messages, model: spec, temperature, tools, trace }, signal) {
      const route = resolveModel(spec);
      const model = spec;
      const stream = await client(route).chat.completions.create(
        {
          model: route.model,
          messages: convert(messages),
          stream: true,
          stream_options: { include_usage: true },
          ...sampling(route, temperature, 600),
          ...(tools?.length
            ? {
                tools: tools.map((t) => ({
                  type: "function" as const,
                  function: t,
                })),
                parallel_tool_calls: false,
              }
            : {}),
        },
        { signal },
      );
      const calls = new Map<number, ToolCall>();
      let reported = false,
        outChars = 0;
      try {
        for await (const chunk of stream) {
          if (chunk.usage) {
            trace?.log("openai.usage", {
              model,
              input_tokens: chunk.usage.prompt_tokens,
              output_tokens: chunk.usage.completion_tokens,
              total_tokens: chunk.usage.total_tokens,
              cached_input_tokens:
                chunk.usage.prompt_tokens_details?.cached_tokens ?? 0,
            });
          }

          const delta = chunk.choices[0]?.delta;
          if (delta?.content) {
            outChars += delta.content.length;
            yield { type: "text", text: delta.content };
          }
          for (const item of delta?.tool_calls ?? []) {
            const call = calls.get(item.index) ?? {
              id: "",
              name: "",
              arguments: "",
            };
            if (item.id) call.id = item.id;
            if (item.function?.name) call.name += item.function.name;
            if (item.function?.arguments) {
              call.arguments += item.function.arguments;
              outChars += item.function.arguments.length;
            }
            if (call.arguments.length > 64000)
              throw new Error("Tool arguments exceeded limit.");
            calls.set(item.index, call);
          }
        }
        for (const call of calls.values()) {
          if (!call.id || !call.name)
            throw new Error("Incomplete model tool call.");
          yield { type: "tool-call", call };
        }
      } finally {
        
      }
    },
    complete: async ({ messages, model: spec, temperature }) => {
      const route = resolveModel(spec);
      const r = await client(route).chat.completions.create({
        model: route.model,
        messages: convert(messages),
        ...sampling(route, temperature, 500),
      });
      return r.choices[0]?.message.content?.trim() ?? "";
    },
  };
};

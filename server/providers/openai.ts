import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { env } from "../../lib/env";
import type { ChatMessage, LanguageModel, ToolCall } from "../core/ports";
import { providerAgent } from "./network";
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
  const client = () =>
    new OpenAI({
      apiKey: env.OPENAI_API_KEY,
      httpAgent: providerAgent(),
      maxRetries: 0,
      timeout: 30000,
    });
  return {
    async *stream({ messages, model, temperature, tools }, signal) {
      const stream = await client().chat.completions.create(
        {
          model,
          temperature,
          messages: convert(messages),
          stream: true,
          max_tokens: 600,
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
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (delta?.content) yield { type: "text", text: delta.content };
        for (const item of delta?.tool_calls ?? []) {
          const call = calls.get(item.index) ?? {
            id: "",
            name: "",
            arguments: "",
          };
          if (item.id) call.id = item.id;
          if (item.function?.name) call.name += item.function.name;
          if (item.function?.arguments)
            call.arguments += item.function.arguments;
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
    },
    complete: async ({ messages, model, temperature }) => {
      const r = await client().chat.completions.create({
        model,
        temperature,
        messages: convert(messages),
        max_tokens: 500,
      });
      return r.choices[0]?.message.content?.trim() ?? "";
    },
  };
};

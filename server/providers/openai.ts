import OpenAI from "openai";
import { env } from "../../lib/env";
import type { LanguageModel } from "../core/ports";

export const createOpenAiModel = (): LanguageModel => {
  const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  return {
    async *stream({ messages, model, temperature }, signal) {
      const stream = await client.chat.completions.create(
        { model, temperature, messages, stream: true, max_tokens: 200 },
        { signal },
      );
      for await (const chunk of stream) {
        const piece = chunk.choices[0]?.delta?.content;
        if (piece) yield piece;
      }
    },
    complete: async ({ messages, model, temperature }) => {
      const response = await client.chat.completions.create({ model, temperature, messages, max_tokens: 500 });
      return response.choices[0]?.message.content?.trim() ?? "";
    },
  };
};

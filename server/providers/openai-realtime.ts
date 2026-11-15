import WebSocket from "ws";
import { z } from "zod";
import { env } from "../../lib/env";
import { parseJson } from "../../lib/json";
import type { ProviderTrace, RealtimeFactory } from "../core/ports";

const eventSchema = z.object({
  type: z.string(),
  delta: z.string().optional(),
  item_id: z.string().optional(),
  transcript: z.string().optional(),
  error: z.object({ message: z.string().optional() }).optional(),
  response: z.object({ id: z.string().optional(), usage: z.unknown().optional() }).optional(),
  usage: z.unknown().optional(),
});

export const createOpenAiRealtime: RealtimeFactory = (config, events) => {
  const socket = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(config.model)}`, {
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
  });

  const send = (payload: object): void => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
  };

  let configured = false;

  socket.on("message", (raw) => {
    const parsed = eventSchema.safeParse(parseJson(raw.toString()));
    if (!parsed.success) return;
    const { type, delta, item_id: itemId, transcript, error, response, usage } = parsed.data;
    switch (type) {
      case "session.created":
        send({
          type: "session.update",
          session: {
            type: "realtime",
            output_modalities: ["audio"],
            instructions: config.instructions,
            audio: {
              input: {
                format: { type: "audio/pcmu" },
                noise_reduction: { type: "near_field" },
                transcription: { model: "gpt-4o-mini-transcribe" },
                turn_detection: { type: "semantic_vad", eagerness: "high", create_response: true, interrupt_response: true },
              },
              output: { format: { type: "audio/pcmu" }, voice: config.voice },
            },
          },
        });
        break;
      case "session.updated":
        if (!configured) {
          configured = true;
          events.onReady();
        }
        break;
      case "response.output_audio.delta":
      case "response.audio.delta":
        if (delta) events.onAudio(delta, itemId ?? "");
        break;
      case "input_audio_buffer.speech_started":
        events.onUserSpeechStart();
        break;
      case "input_audio_buffer.speech_stopped":
        events.onUserSpeechStop();
        break;
      case "conversation.item.input_audio_transcription.completed":
        recordRealtimeUsage(config.trace, "gpt-4o-mini-transcribe", usage, itemId);
        if (transcript?.trim()) events.onUserTranscript(transcript.trim());
        break;
      case "response.output_audio_transcript.done":
      case "response.audio_transcript.done":
        if (transcript?.trim()) events.onAgentTranscript(transcript.trim());
        break;
      case "response.done":
        recordRealtimeUsage(config.trace, config.model, response?.usage, response?.id);
        events.onResponseDone();
        break;
      case "error":
        events.onError(error?.message ?? "unknown realtime error");
        break;
    }
  });
  socket.on("error", (error) => events.onError(error.message));
  socket.on("close", (code, reason) => console.info("openai realtime closed", code, reason.toString()));

  return {
    sendAudio: (payload) => send({ type: "input_audio_buffer.append", audio: payload }),
    say: (text) => send({ type: "response.create", response: { instructions: `Say exactly this and nothing else: ${text}` } }),
    truncate: (itemId, audioEndMs) =>
      send({ type: "conversation.item.truncate", item_id: itemId, content_index: 0, audio_end_ms: audioEndMs }),
    close: () => socket.close(),
  };
};


const usageSchema = z.object({
  input_tokens: z.number().nonnegative(),
  output_tokens: z.number().nonnegative(),
  input_token_details: z.object({
    audio_tokens: z.number().nonnegative().optional(),
    cached_tokens: z.number().nonnegative().optional(),
    cached_tokens_details: z.object({ audio_tokens: z.number().nonnegative().optional() }).optional(),
  }).optional(),
  output_token_details: z.object({ audio_tokens: z.number().nonnegative().optional() }).optional(),
});
/** Realtime tokens have independent audio and text prices. */
export function recordRealtimeUsage(trace: ProviderTrace | undefined, model: string, raw: unknown, requestId?: string): void {
  const parsed = usageSchema.safeParse(raw);
  if (!parsed.success) {
    trace?.usage?.markMissing("openai", model, "Provider did not return valid realtime token usage.");
    trace?.log("realtime.usage_missing", { model });
    return;
  }
  const usage = parsed.data;
  trace?.usage?.addLlm(model, {
    provider: "openai", requestId,
    promptTokens: usage.input_tokens,
    cachedTokens: usage.input_token_details?.cached_tokens ?? 0,
    completionTokens: usage.output_tokens,
    inputAudioTokens: usage.input_token_details?.audio_tokens ?? 0,
    cachedAudioTokens: usage.input_token_details?.cached_tokens_details?.audio_tokens ?? 0,
    outputAudioTokens: usage.output_token_details?.audio_tokens ?? 0,
  });
}

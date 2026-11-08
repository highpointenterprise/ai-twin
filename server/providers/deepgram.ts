import WebSocket from "ws";
import { z } from "zod";
import { env } from "../../lib/env";
import { parseJson } from "../../lib/json";
import type { TranscriberFactory } from "../core/ports";

const DEEPGRAM_URL =
  "wss://api.deepgram.com/v2/listen?model=flux-general-en&encoding=mulaw&sample_rate=8000" +
  "&eager_eot_threshold=0.5&eot_threshold=0.75&eot_timeout_ms=4000";

const turnInfoSchema = z.object({
  type: z.literal("TurnInfo"),
  event: z.enum(["Update", "StartOfTurn", "EagerEndOfTurn", "TurnResumed", "EndOfTurn"]),
  transcript: z.string().default(""),
});

export const createDeepgramTranscriber: TranscriberFactory = (events) => {
  const socket = new WebSocket(DEEPGRAM_URL, { headers: { Authorization: `Token ${env.DEEPGRAM_API_KEY}` } });

  socket.on("message", (raw) => {
    const parsed = turnInfoSchema.safeParse(parseJson(raw.toString()));
    if (!parsed.success) return;
    const text = parsed.data.transcript.trim();
    switch (parsed.data.event) {
      case "StartOfTurn":
        events.onSpeechStart();
        break;
      case "Update":
        events.onPartial(text);
        break;
      case "EagerEndOfTurn":
        events.onEagerEnd(text);
        break;
      case "TurnResumed":
        events.onResume();
        break;
      case "EndOfTurn":
        events.onEnd(text);
        break;
    }
  });
  socket.on("error", (error) => events.onError(error));
  socket.on("close", (code, reason) => console.info("deepgram closed", code, reason.toString()));

  return {
    sendAudio: (chunk) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(chunk);
    },
    close: () => socket.close(),
  };
};

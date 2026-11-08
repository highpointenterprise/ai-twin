import WebSocket from "ws";
import { env } from "../../lib/env";
import { transcriberSchema } from "../../lib/config";
import { parseJson } from "../../lib/json";
import type { TranscriberFactory } from "../core/ports";
import { providerAgent } from "./network";
export const createDeepgramTranscriber: TranscriberFactory = (
  events,
  config = transcriberSchema.parse({}),
) => {
  const query = new URLSearchParams({
    model: config.model,
    encoding: "mulaw",
    sample_rate: "8000",
    eot_threshold: String(config.eotThreshold),
    eot_timeout_ms: String(config.eotTimeoutMs),
  });
  const socket = new WebSocket(`wss://api.deepgram.com/v2/listen?${query}`, {
    headers: { Authorization: `Token ${env.DEEPGRAM_API_KEY}` },
    agent: providerAgent(),
    handshakeTimeout: 10000,
  });
  let closed = false;
  const pending: Buffer[] = [];
  socket.on("open", () => {
    for (const b of pending.splice(0)) socket.send(b);
  });
  socket.on("message", (raw) => {
    const d = parseJson(raw.toString()) as {
      type?: string;
      event?: string;
      transcript?: string;
      description?: string;
    } | null;
    if (d?.type === "Error") {
      events.onError(new Error(d.description || "Deepgram error"));
      return;
    }
    if (d?.type !== "TurnInfo") return;
    const text = d.transcript?.trim() ?? "";
    switch (d.event) {
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
  socket.on("error", (e) => {
    if (!closed) events.onError(e);
  });
  socket.on("close", () => {
    if (!closed)
      events.onError(new Error("Deepgram connection closed unexpectedly."));
  });
  return {
    sendAudio: (chunk) => {
      if (closed) return;
      if (socket.readyState === WebSocket.OPEN) socket.send(chunk);
      else if (
        socket.readyState === WebSocket.CONNECTING &&
        pending.length < 250
      )
        pending.push(chunk);
    },
    close: () => {
      closed = true;
      pending.length = 0;
      socket.close();
    },
  };
};

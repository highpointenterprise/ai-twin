import WebSocket from "ws";
import { env } from "../../lib/env";
import { transcriberSchema } from "../../lib/config";
import { parseJson } from "../../lib/json";
import type { TranscriberFactory } from "../core/ports";
import { providerAgent } from "./network";
import { logEvent } from "../observability/trace";
import { errorDetail, redactText } from "../observability/diagnostics";
export const deepgramTranscriberFactory =
  (
    connect: (url: string, options: WebSocket.ClientOptions) => WebSocket = (
      url,
      options,
    ) => new WebSocket(url, options),
  ): TranscriberFactory =>
  (
    events,
    config = transcriberSchema.parse({}),
    format = { encoding: "mulaw", sampleRate: 8000 },
    trace,
  ) => {
    const log = trace?.log.bind(trace) ?? logEvent,
      began = Date.now();
    log("stt.connecting", {
      provider: "deepgram",
      model: config.model,
      encoding: format.encoding,
      sampleRate: format.sampleRate,
    });
    const query = new URLSearchParams({
      model: config.model,
      encoding: format.encoding === "mulaw" ? "mulaw" : "linear16",
      sample_rate: String(format.sampleRate),
      eot_threshold: String(config.eotThreshold),
      eot_timeout_ms: String(config.eotTimeoutMs),
    });
    const socket = connect(`wss://api.deepgram.com/v2/listen?${query}`, {
      headers: { Authorization: `Token ${env.DEEPGRAM_API_KEY}` },
      agent: providerAgent(),
      handshakeTimeout: 10000,
    });
    let closed = false;
    let failed = false,
      packets = 0,
      bytes = 0,
      lastReport = 0;
    const fail = (error: Error) => {
      if (closed || failed) return;
      failed = true;
      log("stt.failed", errorDetail(error));
      events.onError(error);
    };
    const pending: Buffer[] = [];
    socket.on("open", () => {
      log("stt.connected", {
        ms: Date.now() - began,
        bufferedPackets: pending.length,
      });
      for (const b of pending.splice(0)) socket.send(b);
    });
    socket.on("unexpected-response", (_req, response) => {
      fail(
        new Error(
          `Deepgram WebSocket handshake rejected (HTTP ${response.statusCode}). Check DEEPGRAM_API_KEY, Flux model access and network access.`,
        ),
      );
      response.resume();
      socket.terminate();
    });
    socket.on("message", (raw) => {
      const d = parseJson(raw.toString()) as {
        type?: string;
        event?: string;
        transcript?: string;
        description?: string;
      } | null;
      if (d?.type === "Error") {
        fail(new Error(redactText(d.description || "Deepgram error")));
        return;
      }
      if (d?.type !== "TurnInfo") return;
      const text = d.transcript?.trim() ?? "";
      log("stt.event", { type: d.event ?? "unknown", characters: text.length });
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
    socket.on("error", fail);
    socket.on("close", (code, reason) => {
      log("stt.closed", {
        code,
        reason: redactText(reason.toString()).slice(0, 300),
        packets,
        bytes,
        cancelled: closed,
      });
      if (!closed)
        fail(
          new Error(
            `Deepgram connection closed unexpectedly (code ${code}). ${redactText(reason.toString()).slice(0, 300)}`,
          ),
        );
    });
    return {
      sendAudio: (chunk) => {
        if (closed) return;
        packets++;
        bytes += chunk.length;
        if (packets === 1 || Date.now() - lastReport >= 5000) {
          lastReport = Date.now();
          log("stt.audio", {
            packets,
            bytes,
            readyState: socket.readyState,
            pending: pending.length,
          });
        }
        if (socket.readyState === WebSocket.OPEN) socket.send(chunk);
        else if (
          socket.readyState === WebSocket.CONNECTING &&
          pending.length < 250
        )
          pending.push(chunk);
        else if (socket.readyState === WebSocket.CONNECTING)
          fail(
            new Error(
              "Deepgram did not connect before the input audio buffer filled.",
            ),
          );
      },
      close: () => {
        closed = true;
        pending.length = 0;
        socket.close();
      },
    };
  };
export const createDeepgramTranscriber = deepgramTranscriberFactory();

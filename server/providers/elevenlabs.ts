import WebSocket from "ws";
import { env } from "../../lib/env";
import { voiceSchema } from "../../lib/config";
import { parseJson } from "../../lib/json";
import type { VoiceOption } from "../../lib/types";
import type { SynthesizerFactory } from "../core/ports";
import { providerAgent } from "./network";
import { logEvent } from "../observability/trace";
import { errorDetail, redactText } from "../observability/diagnostics";

export const elevenLabsSynthesizerFactory =
  (
    connect: (url: string, options: WebSocket.ClientOptions) => WebSocket = (
      url,
      options,
    ) => new WebSocket(url, options),
  ): SynthesizerFactory =>
  (
    voiceId,
    onAudio,
    config = voiceSchema.parse({}),
    format = { encoding: "mulaw", sampleRate: 8000 },
    trace,
  ) => {
    const log = trace?.log.bind(trace) ?? logEvent,
      began = Date.now();
    const outputFormat =
      format.encoding === "mulaw" ? "ulaw_8000" : `pcm_${format.sampleRate}`;
    log("tts.connecting", {
      provider: "elevenlabs",
      voiceId,
      model: config.model,
      format: outputFormat,
    });
    const query = new URLSearchParams({
      model_id: config.model,
      output_format: outputFormat,
      auto_mode: "true",
    });
    const socket = connect(
      `wss://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream-input?${query}`,
      {
        headers: { "xi-api-key": env.ELEVENLABS_API_KEY },
        agent: providerAgent(),
        handshakeTimeout: 10000,
      },
    );
    let readyResolve!: () => void,
      readyReject!: (e: Error) => void,
      doneResolve!: () => void,
      doneReject!: (e: Error) => void;
    let settled = false,
      closed = false,
      endRequested = false,
      audioBytes = 0,
      packets = 0;
    const ready = new Promise<void>((r, j) => {
        readyResolve = r;
        readyReject = j;
      }),
      done = new Promise<void>((r, j) => {
        doneResolve = r;
        doneReject = j;
      });
    void ready.catch(() => {});
    void done.catch(() => {});
    const timeout = setTimeout(
      () => fail(new Error("ElevenLabs synthesis timed out after 45 seconds.")),
      45000,
    );
    const fail = (error: Error) => {
      if (settled || closed) return;
      settled = true;
      clearTimeout(timeout);
      log("tts.failed", {
        ...errorDetail(error),
        bytes: audioBytes,
        packets,
        ms: Date.now() - began,
      });
      readyReject(error);
      doneReject(error);
      socket.close();
    };
    const finish = (via: string) => {
      if (settled || closed) return;
      if (!audioBytes) {
        fail(
          new Error(
            "ElevenLabs completed without audio. Check the voice ID, model access and account credits.",
          ),
        );
        return;
      }
      settled = true;
      clearTimeout(timeout);
      log("tts.completed", {
        via,
        bytes: audioBytes,
        packets,
        ms: Date.now() - began,
      });
      doneResolve();
    };
    socket.on("open", () => {
      if (closed) return;
      log("tts.connected", { ms: Date.now() - began });
      socket.send(
        JSON.stringify({
          text: " ",
          voice_settings: {
            stability: config.stability,
            similarity_boost: config.similarityBoost,
            speed: config.speed,
          },
        }),
      );
      readyResolve();
    });
    socket.on("unexpected-response", (_req, response) => {
      const error = new Error(
        `ElevenLabs WebSocket handshake rejected (HTTP ${response.statusCode}). Check API key, voice access, credits and network access.`,
      );
      fail(error);
      response.resume();
      socket.terminate();
    });
    socket.on("message", (raw) => {
      if (closed || settled) return;
      const d = parseJson(raw.toString()) as {
        audio?: string;
        isFinal?: boolean;
        error?: unknown;
        message?: string;
        detail?: unknown;
      } | null;
      if (!d) {
        fail(new Error("ElevenLabs sent invalid JSON."));
        return;
      }
      if (d.error || d.detail) {
        fail(
          new Error(
            `ElevenLabs rejected synthesis: ${redactText(typeof d.message === "string" ? d.message : typeof d.error === "string" ? d.error : JSON.stringify(d.detail ?? d.error)).slice(0, 600)}`,
          ),
        );
        return;
      }
      if (typeof d.audio === "string" && d.audio) {
        const bytes = Buffer.from(d.audio, "base64").length;
        audioBytes += bytes;
        packets++;
        if (packets === 1)
          log("tts.first_audio", { bytes, ms: Date.now() - began });
        try {
          onAudio(d.audio);
        } catch (e) {
          fail(e instanceof Error ? e : new Error("Audio output failed."));
          return;
        }
      }
      if (d.isFinal) {
        finish("final-marker");
        socket.close();
      }
    });
    socket.on("error", fail);
    socket.on("close", (code, reason) => {
      log("tts.closed", {
        code,
        reason: redactText(reason.toString()).slice(0, 300),
        bytes: audioBytes,
        packets,
        endRequested,
        settled,
        cancelled: closed,
      });
      if (settled || closed) return;
      // The provider may close normally after EOS without a separate isFinal
      // packet. Preserve already received audio; reject early/error/empty closes.
      if (endRequested && audioBytes > 0 && (code === 1000 || code === 1005))
        finish("clean-eos-close");
      else
        fail(
          new Error(
            `ElevenLabs closed before speech completed (code ${code}, ${audioBytes} audio bytes). ${redactText(reason.toString()).slice(0, 300)}`,
          ),
        );
    });
    return {
      push: async (text) => {
        await ready;
        if (closed) throw new Error("Synthesis cancelled.");
        if (socket.readyState !== WebSocket.OPEN)
          throw new Error("ElevenLabs socket closed before text was sent.");
        socket.send(JSON.stringify({ text: `${text} `, flush: true }));
        log("tts.text_sent", { characters: text.length });
      },
      end: async () => {
        await ready;
        if (closed) throw new Error("Synthesis cancelled.");
        if (!endRequested) {
          endRequested = true;
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ text: "" }));
            log("tts.eos_sent");
          }
        }
        await done;
      },
      close: () => {
        if (closed) return;
        closed = true;
        clearTimeout(timeout);
        const error = new Error("Synthesis cancelled.");
        readyReject(error);
        doneReject(error);
        socket.close();
      },
    };
  };
export const createElevenLabsSynthesizer = elevenLabsSynthesizerFactory();
export const listElevenLabsVoices = async (): Promise<VoiceOption[]> => {
  if (!env.ELEVENLABS_API_KEY)
    throw new Error("ELEVENLABS_API_KEY is not configured.");
  const response = await fetch("https://api.elevenlabs.io/v1/voices", {
    headers: { "xi-api-key": env.ELEVENLABS_API_KEY },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`ElevenLabs returned ${response.status}.`);
  const body = (await response.json()) as {
    voices: { voice_id: string; name: string }[];
  };
  return body.voices.map((v) => ({ id: v.voice_id, name: v.name }));
};

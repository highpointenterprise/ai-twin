import WebSocket from "ws";
import { env } from "../../lib/env";
import { voiceSchema } from "../../lib/config";
import { parseJson } from "../../lib/json";
import type { VoiceOption } from "../../lib/types";
import type { SynthesizerFactory } from "../core/ports";
import { providerAgent } from "./network";
export const createElevenLabsSynthesizer: SynthesizerFactory = (
  voiceId,
  onAudio,
  config = voiceSchema.parse({}),
  format = { encoding: "mulaw", sampleRate: 8000 },
) => {
  const query = new URLSearchParams({
    model_id: config.model,
    output_format:
      format.encoding === "mulaw" ? "ulaw_8000" : `pcm_${format.sampleRate}`,
    auto_mode: "true",
  });
  const socket = new WebSocket(
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
  let final = false,
    closed = false;
  const ready = new Promise<void>((r, j) => {
    readyResolve = r;
    readyReject = j;
  });
  const done = new Promise<void>((r, j) => {
    doneResolve = r;
    doneReject = j;
  });
  void ready.catch(() => {});
  void done.catch(() => {});
  const timeout = setTimeout(
    () => fail(new Error("ElevenLabs synthesis timed out.")),
    45000,
  );
  const fail = (e: Error) => {
    readyReject(e);
    doneReject(e);
    clearTimeout(timeout);
    socket.close();
  };
  socket.on("open", () => {
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
  socket.on("message", (raw) => {
    const d = parseJson(raw.toString()) as {
      audio?: string;
      isFinal?: boolean;
      error?: string;
    } | null;
    if (closed || !d) return;
    if (d.error) return fail(new Error("ElevenLabs synthesis failed."));
    if (d.audio) onAudio(d.audio);
    if (d.isFinal) {
      final = true;
      clearTimeout(timeout);
      doneResolve();
      socket.close();
    }
  });
  socket.on("error", fail);
  socket.on("close", () => {
    if (!final && !closed)
      fail(new Error("ElevenLabs closed before final audio."));
  });
  return {
    push: async (text) => {
      await ready;
      if (!closed && socket.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify({ text: `${text} `, flush: true }));
    },
    end: async () => {
      await ready;
      if (closed) return;
      socket.send(JSON.stringify({ text: "" }));
      await done;
    },
    close: () => {
      closed = true;
      clearTimeout(timeout);
      const e = new Error("Synthesis cancelled");
      readyReject(e);
      doneReject(e);
      socket.close();
    },
  };
};
export const listElevenLabsVoices = async (): Promise<VoiceOption[]> => {
  if (!env.ELEVENLABS_API_KEY)
    throw new Error("ELEVENLABS_API_KEY is not configured.");
  const r = await fetch("https://api.elevenlabs.io/v1/voices", {
    headers: { "xi-api-key": env.ELEVENLABS_API_KEY },
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`ElevenLabs returned ${r.status}.`);
  const body = (await r.json()) as {
    voices: { voice_id: string; name: string }[];
  };
  return body.voices.map((v) => ({ id: v.voice_id, name: v.name }));
};

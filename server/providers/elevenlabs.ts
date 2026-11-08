import WebSocket from "ws";
import { z } from "zod";
import { env } from "../../lib/env";
import { parseJson } from "../../lib/json";
import type { VoiceOption } from "../../lib/types";
import type { SynthesizerFactory } from "../core/ports";

const audioMessageSchema = z.object({ audio: z.string().nullish(), isFinal: z.boolean().nullish() });
const voicesSchema = z.object({ voices: z.array(z.object({ voice_id: z.string(), name: z.string() })) });

export const createElevenLabsSynthesizer: SynthesizerFactory = (voiceId, onAudio) => {
  const url =
    `wss://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream-input` +
    `?model_id=eleven_flash_v2_5&output_format=ulaw_8000&auto_mode=true`;
  const socket = new WebSocket(url, { headers: { "xi-api-key": env.ELEVENLABS_API_KEY } });

  const ready = new Promise<void>((resolve, reject) => {
    socket.once("open", () => {
      socket.send(
        JSON.stringify({
          text: " ",
          voice_settings: { stability: 0.4, similarity_boost: 0.8, style: 0.3, use_speaker_boost: true },
        }),
      );
      resolve();
    });
    socket.once("error", reject);
  });
  ready.catch(() => undefined);

  const finished = new Promise<void>((resolve) => {
    socket.on("message", (raw) => {
      const message = audioMessageSchema.safeParse(parseJson(raw.toString()));
      if (!message.success) return;
      if (message.data.audio) onAudio(message.data.audio);
      else if (!message.data.isFinal) console.warn("elevenlabs message", raw.toString().slice(0, 300));
      if (message.data.isFinal) resolve();
    });
    socket.on("close", (code, reason) => {
      if (code !== 1000 && code !== 1005) console.warn("elevenlabs closed", code, reason.toString());
      resolve();
    });
    socket.on("error", (error) => {
      console.error("elevenlabs error", error.message);
      resolve();
    });
  });

  const send = async (payload: object): Promise<void> => {
    await ready;
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
  };

  return {
    push: (text) => send({ text: `${text} `, flush: true }),
    end: async () => {
      await send({ text: "" });
      await finished;
    },
    close: () => socket.close(),
  };
};

export const listElevenLabsVoices = async (): Promise<VoiceOption[]> => {
  const response = await fetch("https://api.elevenlabs.io/v1/voices", {
    headers: { "xi-api-key": env.ELEVENLABS_API_KEY },
  });
  if (!response.ok) throw new Error(`ElevenLabs voices request failed with ${response.status}`);
  const body = voicesSchema.parse(await response.json());
  return body.voices.map((voice) => ({ id: voice.voice_id, name: voice.name }));
};

import { env } from "../../lib/env";
import type { RealtimeFactory, SessionFactory } from "../core/ports";
import { buildSystemPrompt } from "./prompt";

const MULAW_BYTES_PER_MS = 8;

export const createRealtimeSessionFactory =
  (connect: RealtimeFactory): SessionFactory =>
  ({ agent, brief, streamSid, send, trace }) => {
    let itemId = "";
    let responseStartedAt = 0;
    let receivedMs = 0;
    let speaking = false;
    let speechStoppedAt = 0;
    let pendingLatency: number | undefined;
    let markSeq = 0;
    let lastMark = "";

    const client = connect(
      {
        instructions: buildSystemPrompt(agent, brief),
        voice: agent.realtimeVoice,
        model: env.OPENAI_REALTIME_MODEL,
      },
      {
        onReady: () => {
          trace.log("realtime.ready", {
            model: env.OPENAI_REALTIME_MODEL,
            voice: agent.realtimeVoice,
          });
          client.say(agent.firstMessage);
        },
        onAudio: (payload, id) => {
          if (id !== itemId) {
            itemId = id;
            responseStartedAt = Date.now();
            receivedMs = 0;
            if (speechStoppedAt) {
              pendingLatency = Date.now() - speechStoppedAt;
              speechStoppedAt = 0;
              trace.log("realtime.first_audio", { latency_ms: pendingLatency });
            }
          }
          speaking = true;
          receivedMs += Math.floor(
            (payload.length * 3) / 4 / MULAW_BYTES_PER_MS,
          );
          send({ event: "media", streamSid, media: { payload } });
        },
        onUserSpeechStart: () => {
          trace.log("realtime.user_speech_started", {
            agent_speaking: speaking,
          });
          if (!speaking) return;
          speaking = false;
          const playedMs = Math.min(Date.now() - responseStartedAt, receivedMs);
          send({ event: "clear", streamSid });
          client.truncate(itemId, playedMs);
          trace.log("barge_in", { played_ms: playedMs });
        },
        onUserSpeechStop: () => {
          speechStoppedAt = Date.now();
          trace.log("realtime.user_speech_stopped");
        },
        onUserTranscript: (text) => trace.say("caller", text),
        onAgentTranscript: (text) => {
          trace.say("agent", text, pendingLatency);
          pendingLatency = undefined;
        },
        onResponseDone: () => {
          lastMark = `resp-${++markSeq}`;
          send({ event: "mark", streamSid, mark: { name: lastMark } });
          trace.log("realtime.response_done");
        },
        onError: (message) => trace.log("realtime.error", { message }),
      },
    );

    return {
      pushAudio: (payload) => client.sendAudio(payload),
      handleMark: (name) => {
        if (name === lastMark) speaking = false;
      },
      close: () => client.close(),
    };
  };

import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { z } from "zod";
import { env } from "../../lib/env";
import { providerAgent } from "../providers/network";
import type { AvatarEvents, AvatarSession } from "./ports";
const API = "https://api.liveavatar.com";
const tokenResponse = z.object({
  code: z.literal(1000),
  data: z.object({ session_token: z.string().min(1) }),
});
const startResponse = z.object({
  code: z.literal(1000),
  data: z.object({
    livekit_url: z.string().url(),
    livekit_client_token: z.string().min(1),
    ws_url: z.string().url(),
  }),
});

type SocketFactory = (url: string) => WebSocket;
// Official LiveAvatar LITE protocol: the existing agent owns STT, LLM and TTS.
export async function createLiveAvatar(
  avatarId: string,
  events: AvatarEvents,
  signal: AbortSignal,
  request: typeof fetch = fetch,
  socketFactory: SocketFactory = (url) =>
    new WebSocket(url, { agent: providerAgent(), handshakeTimeout: 15000 }),
): Promise<AvatarSession> {
  let token = "",
    socket: WebSocket | undefined,
    keepAlive: NodeJS.Timeout | undefined,
    stopped = false;
  let stopping: Promise<void> | undefined;
  const api = async (path: string, body?: unknown, duringCleanup = false) => {
    const response = await request(API + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token
          ? { Authorization: `Bearer ${token}` }
          : { "X-API-KEY": env.LIVEAVATAR_API_KEY }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: duringCleanup
        ? AbortSignal.timeout(10000)
        : AbortSignal.any([signal, AbortSignal.timeout(20000)]),
    });
    if (!response.ok)
      throw new Error(
        `LiveAvatar request failed (${response.status}). Check its API key, avatar access and network connectivity.`,
      );
    const result = (await response.json().catch(() => {
      throw new Error("Invalid LiveAvatar API response.");
    })) as { code?: number } | null;
    if (result?.code !== 1000)
      throw new Error(
        "LiveAvatar rejected the session request. Check account access and usage limits.",
      );
    return result;
  };
  const stop = (): Promise<void> => {
    if (stopping) return stopping;
    stopped = true;
    clearInterval(keepAlive);
    socket?.close();
    return (stopping = token
      ? api("/v1/sessions/stop", undefined, true).then(() => {})
      : Promise.resolve());
  };
  try {
    signal.throwIfAborted();
    token = tokenResponse.parse(
      await api("/v1/sessions/token", { mode: "LITE", avatar_id: avatarId }),
    ).data.session_token;
    const data = startResponse.parse(await api("/v1/sessions/start")).data;
    for (const url of [data.livekit_url, data.ws_url])
      if (new URL(url).protocol !== "wss:")
        throw new Error("LiveAvatar returned an insecure media endpoint.");
    signal.throwIfAborted();
    socket = socketFactory(data.ws_url);
    const ws = socket;
    // Closing a connecting ws can emit an error after the connect waiter settles.
    ws.on("error", () => {});
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        cleanup();
        ws.close();
        reject(new Error("Avatar connection cancelled."));
      };
      const fail = () => {
        cleanup();
        reject(new Error("Could not connect to the LiveAvatar media socket."));
      };
      const open = () => {
        cleanup();
        resolve();
      };
      const timeout = setTimeout(fail, 15000);
      const cleanup = () => {
        clearTimeout(timeout);
        signal.removeEventListener("abort", abort);
        ws.off("error", fail);
        ws.off("close", fail);
        ws.off("open", open);
      };
      signal.addEventListener("abort", abort, { once: true });
      ws.once("error", fail);
      ws.once("close", fail);
      ws.once("open", open);
      if (signal.aborted) abort();
    });
    ws.on("error", () => {
      if (!stopped)
        events.onError(new Error("LiveAvatar media connection failed."));
    });
    ws.on("close", () => {
      if (!stopped)
        events.onError(new Error("LiveAvatar media connection closed."));
    });
    ws.on("message", (raw) => {
      if (stopped) return;
      try {
        const event = JSON.parse(raw.toString()) as {
          type?: string;
          event_id?: string;
        };
        if (event.type === "agent.speak_started" && event.event_id)
          events.onStarted(event.event_id);
        else if (event.type === "agent.speak_ended" && event.event_id)
          events.onEnded(event.event_id);
        else if (event.type === "error")
          events.onError(new Error("LiveAvatar could not render the speech."));
      } catch {
        events.onError(new Error("Invalid LiveAvatar media event."));
      }
    });
    const send = (data: object) => {
      if (stopped || ws.readyState !== WebSocket.OPEN)
        throw new Error("Avatar is disconnected.");
      if (ws.bufferedAmount > 2 * 1024 * 1024)
        throw new Error("Avatar audio connection is too slow.");
      ws.send(JSON.stringify(data));
    };
    let current = "",
      pending = Buffer.alloc(0),
      first = true;
    const flush = (end = false) => {
      let size = first ? 19200 : 48000;
      while (pending.length >= size || (end && pending.length)) {
        const chunk = pending.subarray(0, size);
        pending = pending.subarray(chunk.length);
        send({
          type: "agent.speak",
          event_id: current,
          audio: chunk.toString("base64"),
        });
        first = false;
        size = 48000;
      }
    };
    keepAlive = setInterval(() => {
      void api("/v1/sessions/keep-alive").catch(() => {
        if (!stopped)
          events.onError(new Error("LiveAvatar keep-alive failed."));
      });
    }, 60000);
    return {
      room: { url: data.livekit_url, token: data.livekit_client_token },
      pushAudio: (audio, eventId) => {
        if (current && current !== eventId)
          throw new Error(
            "Finish or interrupt the previous avatar utterance first.",
          );
        current = eventId;
        const pcm = Buffer.from(audio, "base64");
        if (pcm.length % 2) throw new Error("Avatar audio must be PCM16.");
        pending = Buffer.concat([pending, pcm]);
        flush();
      },
      finish: (eventId) => {
        if (current !== eventId) throw new Error("Avatar utterance mismatch.");
        flush(true);
        send({ type: "agent.speak_end", event_id: eventId });
        current = "";
        first = true;
      },
      interrupt: () => {
        current = "";
        pending = Buffer.alloc(0);
        first = true;
        if (!stopped && ws.readyState === WebSocket.OPEN)
          send({ type: "agent.interrupt", event_id: randomUUID() });
      },
      stop,
    };
  } catch (error) {
    try {
      await stop();
    } catch {
      /* The session is also bounded by LiveAvatar's idle timeout. */
    }
    if (signal.aborted) throw new Error("Avatar setup cancelled.");
    throw error instanceof z.ZodError
      ? new Error(
          "LiveAvatar response is missing the required LITE media fields.",
        )
      : error;
  }
}

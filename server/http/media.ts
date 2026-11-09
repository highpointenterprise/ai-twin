import type { Server } from "node:http";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { parseJson } from "../../lib/json";
import { verifyStreamToken } from "../../lib/token";
import type { ConversationSession, SessionFactory } from "../core/ports";
import type { SessionPool } from "../engine/pool";
import type { TraceStore } from "../observability/trace";
import type { CallRegistry } from "../store/calls";
import type { ContextStore } from "../store/contexts";
import { randomUUID } from "node:crypto";
import {
  writeDiagnostic,
  errorDetail,
  redactText,
} from "../observability/diagnostics";
const startSchema = z.object({
  event: z.literal("start"),
  start: z.object({
    streamSid: z.string(),
    callSid: z.string(),
    mediaFormat: z.object({
      encoding: z.literal("audio/x-mulaw"),
      sampleRate: z.literal(8000),
      channels: z.literal(1),
    }),
    customParameters: z.object({
      agentId: z.string(),
      callId: z.string(),
      token: z.string(),
    }),
  }),
});
export function attachMediaServer(
  server: Server,
  deps: {
    factory: SessionFactory;
    pool: SessionPool;
    registry: CallRegistry;
    traces: TraceStore;
    contexts: ContextStore;
    onResumed?: (transferId: string, sid: string) => void;
  },
): WebSocketServer {
  const wss = new WebSocketServer({
    server,
    path: "/media",
    maxPayload: 64 * 1024,
  });
  wss.on("connection", (socket) => {
    let session: ConversationSession | undefined;
    let sid = "",
      authenticated = false,
      inPackets = 0,
      inBytes = 0,
      outPackets = 0,
      outBytes = 0,
      lastAudioLog = 0;
    const connectionId = randomUUID(),
      began = Date.now();
    const log = (
      event: string,
      detail: Record<string, string | number | boolean> = {},
    ) => {
      if (sid) deps.traces.for(sid).log(event, { connectionId, ...detail });
      else writeDiagnostic(connectionId, event, detail);
    };
    log("media.socket_connected");
    const timeout = setTimeout(() => {
      log("media.start_missing", {
        hint: "WebSocket opened but Twilio did not send its start event.",
      });
      socket.close(1008, "Missing start event");
    }, 10000);
    const release = () => {
      clearTimeout(timeout);
      if (session) {
        session.close();
        deps.pool.remove(session);
        session = undefined;
      }
    };
    socket.on("message", (raw) => {
      try {
        const data = parseJson(raw.toString()) as {
          event?: string;
          media?: { payload?: string };
          mark?: { name?: string };
          dtmf?: { digit?: string };
        } | null;
        if (!data) {
          log("media.invalid_json");
          return;
        }
        if (data.event === "connected") {
          log("media.protocol_connected");
          return;
        }
        if (data.event === "start") {
          const { start } = startSchema.parse(data),
            p = start.customParameters;
          sid = start.callSid;
          const context = deps.contexts.get(p.callId);
          const reason = session
            ? "duplicate-start"
            : deps.pool.isFull
              ? "capacity"
              : !context
                ? "context-missing-or-consumed"
                : context.agent.id !== p.agentId
                  ? "assistant-mismatch"
                  : context.sid !== start.callSid
                    ? "call-sid-mismatch"
                    : !verifyStreamToken(p.agentId, p.callId, p.token)
                      ? "invalid-stream-token"
                      : "";
          if (reason) {
            log("media.rejected", {
              reason,
              callId: p.callId,
              hint: "The webhook and WebSocket must reach the same running backend with the same STREAM_SECRET.",
            });
            socket.close(1008, "Rejected stream");
            return;
          }
          const snapshot = deps.contexts.take(p.callId, start.callSid)!;
          authenticated = true;
          clearTimeout(timeout);
          log("media.started", {
            streamSid: start.streamSid,
            agentId: p.agentId,
            encoding: start.mediaFormat.encoding,
            sampleRate: start.mediaFormat.sampleRate,
          });
          session = deps.factory({
            ...snapshot,
            callSid: sid,
            streamSid: start.streamSid,
            trace: deps.traces.for(sid),
            transportClose: () => socket.close(),
            send: (message) => {
              const event = message as {
                event?: string;
                media?: { payload?: string };
                mark?: { name?: string };
              };
              if (socket.readyState !== socket.OPEN) {
                log("media.send_dropped", {
                  event: event.event ?? "unknown",
                  readyState: socket.readyState,
                });
                if (event.event === "media" || event.event === "mark")
                  throw new Error("Twilio media socket is closed.");
                return;
              }
              socket.send(JSON.stringify(message), (error) => {
                if (error) log("media.send_failed", errorDetail(error));
              });
              if (event.event === "media" && event.media?.payload) {
                outPackets++;
                outBytes += Buffer.from(event.media.payload, "base64").length;
                if (outPackets === 1)
                  log("media.first_outbound_audio", { bytes: outBytes });
              } else
                log("media.sent", {
                  event: event.event ?? "unknown",
                  mark: event.mark?.name ?? "",
                });
            },
          });
          if (snapshot.resumeTransferId)
            deps.onResumed?.(snapshot.resumeTransferId, sid);
          deps.pool.add(session);
          deps.registry.update(sid, "in-progress");
          log("media.session_ready");
        } else if (
          data.event === "media" &&
          typeof data.media?.payload === "string"
        ) {
          inPackets++;
          inBytes += Buffer.from(data.media.payload, "base64").length;
          if (inPackets === 1 || Date.now() - lastAudioLog >= 5000) {
            lastAudioLog = Date.now();
            log("media.audio_progress", {
              inPackets,
              inBytes,
              outPackets,
              outBytes,
              sessionReady: !!session,
            });
          }
          session?.pushAudio(data.media.payload);
        } else if (data.event === "mark" && typeof data.mark?.name === "string")
          session?.handleMark(data.mark.name);
        else if (data.event === "dtmf" && typeof data.dtmf?.digit === "string")
          session?.handleDtmf?.(data.dtmf.digit);
        else if (data.event === "stop") {
          log("media.stop_received");
          release();
          socket.close();
        }
      } catch (error) {
        log("media.invalid_event", errorDetail(error));
        if (authenticated)
          deps.registry.patch(sid, { endedReason: "media-session-error" });
        socket.close(1008, "Invalid media event");
        release();
      }
    });
    socket.on("close", (code, reason) => {
      log("media.socket_closed", {
        code,
        reason: redactText(reason.toString()).slice(0, 300),
        inPackets,
        inBytes,
        outPackets,
        outBytes,
        ms: Date.now() - began,
      });
      release();
    });
    socket.on("error", (error) => {
      log("media.socket_failed", errorDetail(error));
      release();
    });
  });
  return wss;
}

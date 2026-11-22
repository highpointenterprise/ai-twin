import type { Server } from "node:http";
import { WebSocketServer, type RawData } from "ws";
import { z } from "zod";
import { parseJson } from "../../lib/json";
import { base64ByteLength } from "../speech/audio";
import { verifyStreamToken } from "../../lib/token";
import type { ConversationSession, SessionFactory } from "../core/ports";
import type { SessionPool } from "../engine/pool";
import type { TraceStore } from "../observability/trace";
import type { CallRegistry } from "../store/calls";
import type { ContextStore } from "../store/contexts";
import { randomUUID } from "node:crypto";
import { env } from "../../lib/env";
import type { RedisCallState } from "../storage/redis";
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
    onResumed?: (transferId: string, sid: string) => void | Promise<void>;
    callState?: RedisCallState;
    maxConcurrentCalls?: number;
    onStarted?: (sid: string) => Promise<void>;
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
    let leaseId: string | undefined;
    let heartbeat: NodeJS.Timeout | undefined;
    let liveUpdate = Promise.resolve();
    let released = false;
    let mediaBegan: number | undefined;
    const release = () => {
      released = true;
      clearInterval(heartbeat);
      if (leaseId && deps.callState) {
        const id = leaseId;
        leaseId = undefined;
        void liveUpdate.catch(() => {}).then(async () => {
          await deps.callState!.release(id);
          await deps.callState!.removeLiveCall(sid, id);
        }).catch((error) => log("media.lease_release_failed", errorDetail(error)));
      }
      clearTimeout(timeout);
      if (session) {
        session.close();
        deps.pool.remove(session);
        session = undefined;
      }
    };
    const processMessage = async (raw: RawData): Promise<void> => {
      if (socket.readyState !== socket.OPEN) return;
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
          if (!verifyStreamToken(p.agentId, p.callId, p.token)) {
            log("media.rejected", { reason: "invalid-stream-token" });
            socket.close(1008, "Rejected stream");
            return;
          }
          const context = await deps.contexts.getAsync(p.callId);
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
          if (deps.callState && !(await deps.callState.reserve(p.callId, deps.maxConcurrentCalls ?? env.MAX_CONCURRENT_CALLS))) {
            socket.close(1013, "Concurrent call limit reached");
            return;
          }
          const snapshot = await deps.contexts.takeAsync(p.callId, start.callSid);
          if (snapshot) { leaseId = p.callId; sid = start.callSid; }
          if (!snapshot || socket.readyState !== socket.OPEN || deps.pool.isFull) {
            if (snapshot) release();
            socket.close(1008, "Call context consumed or session unavailable");
            return;
          }
          leaseId = p.callId;
          released = false;
          const record = await deps.registry.load(sid);
          if (deps.registry.repository && !record) throw new Error("Call record is not available.");
          // Each trace persists its own cumulative producer segment. A resumed
          // worker starts a new segment; restoring call totals here would bill
          // prior workers' usage again.
          const refreshLiveState = async () => {
            if (released || !deps.callState) return;
            if (!(await deps.callState.reserve(p.callId, deps.maxConcurrentCalls ?? env.MAX_CONCURRENT_CALLS)))
              throw new Error("Live call lease could not be renewed.");
            if (!released) await deps.callState.setLiveCall(sid, {
              contextId: p.callId,
              streamSid: start.streamSid,
              assistantId: snapshot.agent.id,
              status: "in-progress",
              updatedAt: Date.now(),
            });
          };
          await refreshLiveState();
          if (released || socket.readyState !== socket.OPEN) { release(); return; }
          heartbeat = setInterval(() => {
            liveUpdate = liveUpdate.then(refreshLiveState).catch((error) => {
              log("media.lease_failed", errorDetail(error));
              socket.close(1011, "Live call state unavailable");
              release();
            });
          }, 30_000);
          heartbeat.unref();
          authenticated = true;
          mediaBegan = Date.now();
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
                outBytes += base64ByteLength(event.media.payload);
                if (outPackets === 1)
                  log("media.first_outbound_audio", { bytes: outBytes });
              } else
                log("media.sent", {
                  event: event.event ?? "unknown",
                  mark: event.mark?.name ?? "",
                });
            },
          });
          deps.pool.add(session);
          if (snapshot.resumeTransferId)
            await deps.onResumed?.(snapshot.resumeTransferId, sid);
          if (released || socket.readyState !== socket.OPEN) { release(); return; }
          deps.registry.update(sid, "in-progress");
          log("media.session_ready");
          if (deps.onStarted) void deps.onStarted(sid).catch((error) => log("media.recording_start_failed", errorDetail(error)));
        } else if (
          data.event === "media" &&
          typeof data.media?.payload === "string"
        ) {
          inPackets++;
          inBytes += base64ByteLength(data.media.payload);
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
    };
    // Serialize the async handshake and later frames; never deliver audio before
    // the shared one-use context has been consumed. Bound a stalled handshake.
    let pendingMessages = 0;
    let messages = Promise.resolve();
    socket.on("message", (raw) => {
      if (pendingMessages >= 512) {
        socket.close(1013, "Media queue is full");
        return;
      }
      pendingMessages++;
      messages = messages.then(() => processMessage(raw)).finally(() => { pendingMessages--; });
    });
    socket.on("close", (code, reason) => {
      if (sid && mediaBegan !== undefined) deps.traces.for(sid).usage.addMediaSeconds((Date.now() - mediaBegan) / 1000);
      if (sid) deps.traces.for(sid).usage.addNetwork(inBytes, outBytes);
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

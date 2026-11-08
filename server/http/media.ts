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
    let sid = "";
    const timeout = setTimeout(
      () => socket.close(1008, "Missing start event"),
      10000,
    );
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
        if (!data) return;
        if (data.event === "start") {
          const { start } = startSchema.parse(data),
            p = start.customParameters;
          const context = deps.contexts.get(p.callId);
          if (
            session ||
            deps.pool.isFull ||
            !context ||
            context.agent.id !== p.agentId ||
            context.sid !== start.callSid ||
            !verifyStreamToken(p.agentId, p.callId, p.token)
          ) {
            socket.close(1008, "Rejected stream");
            return;
          }
          const snapshot = deps.contexts.take(p.callId, start.callSid)!;
          sid = start.callSid;
          clearTimeout(timeout);
          session = deps.factory({
            ...snapshot,
            callSid: sid,
            streamSid: start.streamSid,
            trace: deps.traces.for(sid),
            transportClose: () => socket.close(),
            send: (message) => {
              if (socket.readyState === socket.OPEN)
                socket.send(JSON.stringify(message));
            },
          });
          if (snapshot.resumeTransferId)
            deps.onResumed?.(snapshot.resumeTransferId, sid);
          deps.pool.add(session);
          deps.registry.update(sid, "in-progress");
        } else if (
          data.event === "media" &&
          typeof data.media?.payload === "string"
        )
          session?.pushAudio(data.media.payload);
        else if (data.event === "mark" && typeof data.mark?.name === "string")
          session?.handleMark(data.mark.name);
        else if (data.event === "dtmf" && typeof data.dtmf?.digit === "string")
          session?.handleDtmf?.(data.dtmf.digit);
        else if (data.event === "stop") {
          release();
          socket.close();
        }
      } catch {
        if (sid) deps.traces.for(sid).log("media.invalid_event");
        socket.close(1008, "Invalid media event");
        release();
      }
    });
    socket.on("close", release);
    socket.on("error", release);
  });
  return wss;
}

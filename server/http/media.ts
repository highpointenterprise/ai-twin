import type { Server } from "node:http";
import { WebSocketServer } from "ws";
import { z } from "zod";
import type { ConversationMode } from "../../lib/types";
import { parseJson } from "../../lib/json";
import { verifyStreamToken } from "../../lib/token";
import type { ConversationSession, SessionFactory } from "../core/ports";
import type { SessionPool } from "../engine/pool";
import { logEvent, type TraceStore } from "../observability/trace";
import type { AgentStore } from "../store/agents";
import type { CallRegistry } from "../store/calls";
import type { ContextStore } from "../store/contexts";

const startEvent = z.object({
  event: z.literal("start"),
  start: z.object({
    streamSid: z.string(),
    callSid: z.string(),
    customParameters: z.object({ agentId: z.string(), callId: z.string(), token: z.string() }),
  }),
});
const mediaEvent = z.object({ event: z.literal("media"), media: z.object({ payload: z.string() }) });
const markEvent = z.object({ event: z.literal("mark"), mark: z.object({ name: z.string() }) });
const stopEvent = z.object({ event: z.literal("stop") });

interface MediaDeps {
  factories: Record<ConversationMode, SessionFactory>;
  store: AgentStore;
  registry: CallRegistry;
  pool: SessionPool;
  traces: TraceStore;
  contexts: ContextStore;
}

export const attachMediaServer = (server: Server, deps: MediaDeps): WebSocketServer => {
  const { factories, store, registry, pool, traces, contexts } = deps;
  const wss = new WebSocketServer({ server, path: "/media", maxPayload: 64 * 1024 });

  wss.on("connection", (socket) => {
    let session: ConversationSession | null = null;
    let callSid = "";

    const release = (): void => {
      if (!session) return;
      session.close();
      pool.remove(session);
      session = null;
      traces.for(callSid).finish();
    };

    socket.on("message", (raw) => {
      const data = parseJson(raw.toString());

      const start = startEvent.safeParse(data);
      if (start.success) {
        const { streamSid, callSid: sid, customParameters: p } = start.data.start;
        callSid = sid;
        const trace = traces.for(sid);
        const agent = store.find(p.agentId);
        const reason = !agent
          ? "unknown_agent"
          : !verifyStreamToken(p.agentId, p.callId, p.token)
            ? "bad_token"
            : pool.isFull
              ? "capacity"
              : session
                ? "duplicate_start"
                : "";
        if (!agent || reason) {
          trace.log("media.rejected", { reason });
          socket.close(1008, "rejected");
          return;
        }
        trace.log("media.connected", { stream: streamSid, mode: agent.mode });
        session = factories[agent.mode]({
          agent,
          brief: contexts.take(p.callId),
          streamSid,
          trace,
          send: (message) => {
            if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
          },
        });
        pool.add(session);
        registry.update(sid, "in-progress");
        return;
      }

      const media = mediaEvent.safeParse(data);
      if (media.success) return session?.pushAudio(media.data.media.payload);

      const mark = markEvent.safeParse(data);
      if (mark.success) return session?.handleMark(mark.data.mark.name);

      if (stopEvent.safeParse(data).success) {
        logEvent("media.stop", { call: callSid.slice(-8) });
        release();
      }
    });

    socket.on("close", release);
    socket.on("error", release);
  });

  return wss;
};

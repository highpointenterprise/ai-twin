import { warmTransferRoutes } from "../transfers/routes";
import { meetingRoutes } from "../meetings/routes";
import type { MeetingService } from "../meetings/service";
import type { WarmTransferCoordinator } from "../transfers/coordinator";
import { randomUUID } from "node:crypto";
import express, {
  type Express,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import { z, ZodError } from "zod";
import { toolSchema } from "../../lib/config";
import { env, missingCallConfiguration } from "../../lib/env";
import { signStreamToken, verifyStreamToken } from "../../lib/token";
import type { CallStatus, PhoneNumberView, VoiceOption } from "../../lib/types";
import { HttpError, logError } from "../core/errors";
import type { Telephony } from "../core/ports";
import {
  agentInputSchema,
  assignRequestSchema,
  callRequestSchema,
} from "../core/schemas";
import type { SessionPool } from "../engine/pool";
import { buildBrief } from "../engine/prompt";
import type { TraceStore } from "../observability/trace";
import type { AgentStore } from "../store/agents";
import type { CallRegistry } from "../store/calls";
import type { ContextStore } from "../store/contexts";
import type { ToolRegistry } from "../tools/registry";
import { voicemailAction } from "../calls/voicemail";
import {
  environmentTwilioCredentials,
  twilioConnectionStatus,
  type TwilioSettings,
} from "../providers/twilio-settings";
export interface HttpDeps {
  store: AgentStore;
  registry: CallRegistry;
  telephony: Telephony;
  pool: SessionPool;
  traces: TraceStore;
  contexts: ContextStore;
  tools: ToolRegistry;
  listVoices: () => Promise<VoiceOption[]>;
  pendingCalls: number;
  warmTransfers?: WarmTransferCoordinator;
  twilioSettings?: TwilioSettings;
  meetings?: MeetingService;
}
const statusMap: Record<string, CallStatus> = {
  queued: "initiating",
  initiated: "initiating",
  ringing: "ringing",
  "in-progress": "connected",
  completed: "completed",
  busy: "failed",
  failed: "failed",
  "no-answer": "failed",
  canceled: "failed",
};
const handle =
  (
    action: (req: Request, res: Response) => unknown | Promise<unknown>,
  ): RequestHandler =>
  (req, res, next) => {
    Promise.resolve()
      .then(() => action(req, res))
      .catch(next);
  };
const onError = (
  error: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void => {
  if (error instanceof ZodError) {
    res.status(400).json({
      error: error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; "),
    });
    return;
  }
  if (error instanceof HttpError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  logError(error);
  res.status(502).json({
    error:
      "The operation failed. Check provider configuration and the server log.",
  });
};
const capacity = (d: HttpDeps): boolean =>
  !!d.twilioSettings?.isUpdating ||
  d.pendingCalls + d.registry.activeCount >= env.MAX_CONCURRENT_CALLS;
const missingConfiguration = (d: HttpDeps): string[] =>
  missingCallConfiguration(d.twilioSettings?.current());
const requireTwilioStable = (d: HttpDeps): void => {
  if (d.twilioSettings?.isUpdating)
    throw new HttpError(
      409,
      "Twilio credentials are being updated. Try again when the connection finishes.",
    );
};
const requireReady = (d: HttpDeps, voiceId: string): void => {
  requireTwilioStable(d);
  const missing = missingConfiguration(d);
  if (!voiceId) missing.push("Assistant voice ID");
  if (missing.length)
    throw new HttpError(
      503,
      `Live calling is not configured: ${missing.join(", ")}`,
    );
};
export const createAdminApp = (d: HttpDeps): Express => {
  const { store, registry, telephony, tools, contexts, traces } = d;
  const app = express();
  app.use(express.json({ limit: "128kb" }));
  // This API binds to loopback. Prevent a foreign website from mutating it through a browser.
  app.use((req, res, next) => {
    const origin = req.get("origin");
    if (
      origin &&
      new URL(origin).host !== (req.get("x-forwarded-host") || req.get("host"))
    ) {
      res.status(403).json({ error: "Cross-origin request rejected." });
      return;
    }
    next();
  });
  app.get("/api/health", (_req, res) =>
    res.set("Cache-Control", "no-store").json({
      status: "ok",
      callingReady: missingConfiguration(d).length === 0,
      missing: missingConfiguration(d),
      twilio:
        d.twilioSettings?.status() ??
        twilioConnectionStatus(environmentTwilioCredentials(), "environment"),
      providers: {
        telephony: "twilio",
        transcriber: "deepgram",
        voice: "11labs",
        model: "openai",
      },
    }),
  );
  app.put(
    "/api/integrations/twilio",
    handle(async (req, res) => {
      res.set("Cache-Control", "no-store");
      if (!d.twilioSettings)
        throw new HttpError(503, "Twilio connection settings are unavailable.");
      const numbers = await d.twilioSettings.connect(
        req.body,
        () =>
          registry.activeCount > 0 ||
          d.pendingCalls > 0 ||
          d.pool.size > 0 ||
          !!d.warmTransfers?.hasActiveTransfers,
      );
      return res.json({
        connection: d.twilioSettings.status(),
        numbers: numbers.map((n) => ({
          ...n,
          agentId: store.agentForNumber(n.phoneNumber)?.id ?? null,
        })),
        missing: missingConfiguration(d),
      });
    }),
  );
  app.get("/api/agents", (_req, res) => res.json(store.list()));
  app.post(
    "/api/agents",
    handle((req, res) => {
      const input = agentInputSchema.parse(req.body);
      tools.resolve(input.toolIds);
      return res.status(201).json(store.create(input));
    }),
  );
  app.put(
    "/api/agents/:id",
    handle((req, res) => {
      const input = agentInputSchema.parse(req.body);
      tools.resolve(input.toolIds);
      return res.json(store.update(req.params.id, input));
    }),
  );
  app.get("/api/tools", (_req, res) => res.json(tools.list()));
  app.post(
    "/api/tools",
    handle((req, res) =>
      res.status(201).json(tools.save(toolSchema.parse(req.body))),
    ),
  );
  app.put(
    "/api/tools/:id",
    handle((req, res) => {
      tools.get(req.params.id);
      return res.json(tools.save(toolSchema.parse(req.body), req.params.id));
    }),
  );
  app.delete(
    "/api/tools/:id",
    handle((req, res) => {
      if (store.list().some((a) => a.toolIds.includes(req.params.id)))
        throw new HttpError(
          409,
          "Detach this tool from assistants before deleting it.",
        );
      tools.delete(req.params.id);
      return res.status(204).end();
    }),
  );
  app.get(
    "/api/voices",
    handle(async (_req, res) => {
      if (!env.ELEVENLABS_API_KEY)
        throw new HttpError(
          503,
          "Configure ELEVENLABS_API_KEY to load voices.",
        );
      return res.json(await d.listVoices());
    }),
  );
  app.get(
    "/api/numbers",
    handle(async (_req, res) => {
      requireTwilioStable(d);
      const credentials =
        d.twilioSettings?.current() ?? environmentTwilioCredentials();
      if (!credentials.accountSid || !credentials.authToken)
        throw new HttpError(
          503,
          "Connect your Twilio account to load phone numbers.",
        );
      const list: PhoneNumberView[] = (await telephony.listNumbers()).map(
        (n) => ({
          ...n,
          agentId: store.agentForNumber(n.phoneNumber)?.id ?? null,
        }),
      );
      return res.json(list);
    }),
  );
  app.post(
    "/api/numbers/:sid/assign",
    handle(async (req, res) => {
      const agent = store.get(assignRequestSchema.parse(req.body).agentId);
      requireReady(d, agent.voiceId);
      d.pendingCalls++;
      try {
        const n = (await telephony.listNumbers()).find(
          (n) => n.sid === req.params.sid,
        );
        if (!n) throw new HttpError(404, "Twilio number not found.");
        await telephony.routeInbound(
          n.sid,
          `${env.PUBLIC_BASE_URL}/twilio/voice/inbound`,
          `${env.PUBLIC_BASE_URL}/twilio/status`,
        );
        store.assign(n.phoneNumber, agent.id);
        return res.json({ ...n, agentId: agent.id });
      } finally {
        d.pendingCalls--;
      }
    }),
  );
  app.get("/api/calls", (_req, res) => res.json(registry.list()));
  app.post(
    "/api/calls",
    handle(async (req, res) => {
      const input = callRequestSchema.parse(req.body),
        agent = store.get(input.agentId);
      requireReady(d, agent.voiceId);
      if (capacity(d))
        throw new HttpError(503, "Concurrent call limit reached.");
      d.pendingCalls++;
      const callId = randomUUID();
      try {
        const from =
          input.from ??
          store.numberForAgent(agent.id) ??
          env.TWILIO_PHONE_NUMBER;
        if (!from)
          throw new HttpError(
            409,
            "Assign or select a Twilio phone number first.",
          );
        if (
          !(await telephony.listNumbers()).some((n) => n.phoneNumber === from)
        )
          throw new HttpError(
            400,
            "Select a number owned by your connected Twilio account.",
          );
        contexts.set(callId, {
          agent,
          tools: tools.resolve(agent.toolIds),
          brief: buildBrief(input.context, input.plannedMinutes),
          direction: "outbound",
          purpose: "conversation",
          from,
          to: input.to,
        });
        const query = new URLSearchParams({
          callId,
          agentId: agent.id,
          token: signStreamToken(agent.id, callId),
        });
        const sid = await telephony.placeCall({
          to: input.to,
          from,
          url: `${env.PUBLIC_BASE_URL}/twilio/voice/outbound?${query}`,
          statusUrl: `${env.PUBLIC_BASE_URL}/twilio/status?callId=${callId}`,
          voicemail: agent.voicemailDetection,
        });
        contexts.bind(callId, sid);
        const record =
          registry.get(sid) ??
          registry.create({
            sid,
            agentId: agent.id,
            direction: "outbound",
            from,
            to: input.to,
            status: "initiating",
          });
        traces.for(sid).log("call.placed", { agent: agent.name });
        return res.status(201).json(record);
      } catch (e) {
        contexts.delete(callId);
        throw e;
      } finally {
        d.pendingCalls--;
      }
    }),
  );
  app.get(
    "/api/calls/:sid/transfer",
    handle((req, res) =>
      res.json(d.warmTransfers?.view(req.params.sid) ?? null),
    ),
  );
  app.post(
    "/api/calls/:sid/transfer/retry",
    handle(async (req, res) => {
      const record = d.warmTransfers?.forCaller(req.params.sid);
      if (!record || !d.warmTransfers)
        throw new HttpError(404, "Warm transfer not found.");
      await d.warmTransfers.retry(record.id);
      return res.json(d.warmTransfers.view(req.params.sid));
    }),
  );
  app.get(
    "/api/calls/:sid",
    handle((req, res) => {
      const r = registry.get(req.params.sid);
      if (!r) throw new HttpError(404, "Call not found.");
      return res.json(r);
    }),
  );
  app.post(
    "/api/calls/:sid/end",
    handle(async (req, res) => {
      const r = registry.get(req.params.sid);
      if (!r) throw new HttpError(404, "Call not found.");
      if (!["completed", "failed"].includes(r.status)) {
        await telephony.endCall(r.sid);
        await d.warmTransfers?.callerEnded(r.sid);
        registry.patch(r.sid, { endedReason: "user-ended" });
        registry.update(r.sid, "completed");
      }
      return res.json(registry.get(r.sid));
    }),
  );
  app.get(
    "/api/calls/:sid/trace",
    handle((req, res) => {
      const trace = traces.get(req.params.sid);
      if (!trace) throw new HttpError(404, "No trace available for this call.");
      return res.json(trace.view());
    }),
  );
  if (d.meetings) app.use(meetingRoutes(d.meetings));
  app.use(onError);
  return app;
};
export const createPublicApp = (d: HttpDeps): Express => {
  const { telephony, store, tools, registry, traces, contexts } = d;
  const app = express();
  app.use(express.urlencoded({ extended: false, limit: "64kb" }));
  app.get("/health", (_req, res) => res.json({ status: "ok" }));
  const verified: RequestHandler = (req, res, next) => {
    if (
      !telephony.validateWebhook(
        `${env.PUBLIC_BASE_URL}${req.originalUrl}`,
        req.body as Record<string, string>,
        req.get("x-twilio-signature") ?? "",
      )
    ) {
      res.status(403).end();
      return;
    }
    next();
  };
  const bodySchema = z.object({
    CallSid: z.string().min(1),
    From: z.string().default(""),
    To: z.string().default(""),
    AnsweredBy: z.string().default(""),
    CallStatus: z.string().optional(),
  });
  const stream = (agentId: string, callId: string) =>
    telephony.streamTwiml(
      `${env.PUBLIC_BASE_URL.replace(/^https/, "wss")}/media`,
      { agentId, callId, token: signStreamToken(agentId, callId) },
    );
  app.post(
    "/twilio/voice/inbound",
    verified,
    handle((req, res) => {
      const b = bodySchema.parse(req.body),
        agent = store.agentForNumber(b.To);
      res.type("text/xml");
      const existingId = contexts.idForSid(b.CallSid);
      if (agent && existingId) return res.send(stream(agent.id, existingId));
      if (
        !agent ||
        capacity(d) ||
        missingConfiguration(d).length ||
        !agent.voiceId
      )
        return res.send(
          telephony.rejectTwiml(
            "Sorry, this number is not available right now.",
          ),
        );
      const callId = randomUUID();
      contexts.set(callId, {
        agent,
        tools: tools.resolve(agent.toolIds),
        brief: "",
        direction: "inbound",
        purpose: "conversation",
        sid: b.CallSid,
      });
      registry.create({
        sid: b.CallSid,
        agentId: agent.id,
        direction: "inbound",
        from: b.From,
        to: b.To,
        status: "connected",
      });
      return res.send(stream(agent.id, callId));
    }),
  );
  app.post(
    "/twilio/voice/outbound",
    verified,
    handle((req, res) => {
      const b = bodySchema.parse(req.body),
        q = z
          .object({
            agentId: z.string(),
            callId: z.string(),
            token: z.string(),
          })
          .parse(req.query);
      const context = contexts.get(q.callId);
      if (
        !context ||
        context.agent.id !== q.agentId ||
        !verifyStreamToken(q.agentId, q.callId, q.token) ||
        !contexts.bind(q.callId, b.CallSid)
      )
        throw new HttpError(403, "Invalid call context.");
      if (!registry.get(b.CallSid))
        registry.create({
          sid: b.CallSid,
          agentId: q.agentId,
          direction: "outbound",
          from: b.From,
          to: b.To,
          status: "connected",
        });
      registry.patch(b.CallSid, { answeredBy: b.AnsweredBy });
      const action = voicemailAction(
        b.AnsweredBy,
        context.agent.voicemailDetection,
      );
      traces.for(b.CallSid).log("answer.detected", {
        answeredBy: b.AnsweredBy || "not-detected",
        action,
      });
      res.type("text/xml");
      if (action === "hangup") {
        contexts.delete(q.callId);
        registry.patch(b.CallSid, {
          endedReason: b.AnsweredBy.startsWith("machine")
            ? "voicemail"
            : "answer-detection-ended",
        });
        return res.send("<Response><Hangup/></Response>");
      }
      context.purpose = action;
      return res.send(stream(q.agentId, q.callId));
    }),
  );
  app.post(
    "/twilio/status",
    verified,
    handle((req, res) => {
      const b = bodySchema.parse(req.body),
        status = b.CallStatus ? statusMap[b.CallStatus] : undefined;
      if (!registry.get(b.CallSid) && typeof req.query.callId === "string") {
        const c = contexts.get(req.query.callId);
        if (c && contexts.bind(req.query.callId, b.CallSid))
          registry.create({
            sid: b.CallSid,
            agentId: c.agent.id,
            direction: "outbound",
            from: c.from ?? b.From,
            to: c.to ?? b.To,
            status: "initiating",
          });
      }
      if (status) registry.update(b.CallSid, status);
      if (status === "failed")
        registry.patch(b.CallSid, { endedReason: b.CallStatus });
      traces
        .for(b.CallSid)
        .log("twilio.status", { status: b.CallStatus ?? "unknown" });
      if (status === "completed" || status === "failed") {
        const contextId = contexts.idForSid(b.CallSid);
        if (contextId) contexts.delete(contextId);
        void d.warmTransfers?.callerEnded(b.CallSid);
        traces.for(b.CallSid).finish();
        if (typeof req.query.callId === "string")
          contexts.delete(req.query.callId);
      }
      return res.status(204).end();
    }),
  );
  app.post(
    "/twilio/transfer-status",
    verified,
    handle((req, res) => {
      const b = z
        .object({ CallSid: z.string(), DialCallStatus: z.string() })
        .parse(req.body);
      registry.patch(b.CallSid, {
        transferStatus: b.DialCallStatus,
        endedReason: `transfer-${b.DialCallStatus}`,
      });
      traces
        .for(b.CallSid)
        .log("transfer.finished", { status: b.DialCallStatus });
      return res.type("text/xml").send("<Response><Hangup/></Response>");
    }),
  );
  if (d.warmTransfers)
    app.use(warmTransferRoutes(d.warmTransfers, contexts, verified));
  app.use(onError);
  return app;
};

import { randomUUID } from "node:crypto";
import express, { type Express, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { z, ZodError } from "zod";
import { env } from "../../lib/env";
import { signStreamToken } from "../../lib/token";
import type { CallStatus, PhoneNumberView, VoiceOption } from "../../lib/types";
import { HttpError, logError } from "../core/errors";
import type { Telephony } from "../core/ports";
import { agentInputSchema, assignRequestSchema, callRequestSchema } from "../core/schemas";
import type { SessionPool } from "../engine/pool";
import { buildBrief } from "../engine/prompt";
import { logEvent, type TraceStore } from "../observability/trace";
import type { AgentStore } from "../store/agents";
import type { CallRegistry } from "../store/calls";
import type { ContextStore } from "../store/contexts";

export interface HttpDeps {
  store: AgentStore;
  registry: CallRegistry;
  telephony: Telephony;
  pool: SessionPool;
  traces: TraceStore;
  contexts: ContextStore;
  listVoices: () => Promise<VoiceOption[]>;
}

const WS_URL = `${env.PUBLIC_BASE_URL.replace(/^https/, "wss")}/media`;
const INBOUND_URL = `${env.PUBLIC_BASE_URL}/twilio/voice/inbound`;
const STATUS_URL = `${env.PUBLIC_BASE_URL}/twilio/status`;

const STATUS_MAP: Record<string, CallStatus> = {
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

const streamParams = (agentId: string): Record<string, string> => {
  const callId = randomUUID();
  return { agentId, callId, token: signStreamToken(agentId, callId) };
};

const handle =
  (action: (req: Request, res: Response) => Promise<unknown> | unknown): RequestHandler =>
  (req, res, next) => {
    Promise.resolve()
      .then(() => action(req, res))
      .catch(next);
  };

const requestLog =
  (scope: string): RequestHandler =>
  (req, _res, next) => {
    logEvent(`${scope}.request`, { method: req.method, path: req.path });
    next();
  };

const onError = (error: unknown, _req: Request, res: Response, _next: NextFunction): void => {
  if (error instanceof ZodError) {
    res.status(400).json({ error: error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ") });
    return;
  }
  if (error instanceof HttpError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  logError(error);
  res.status(502).json({ error: "A provider request failed. Check the server log." });
};

export const createAdminApp = ({ store, registry, telephony, pool, traces, contexts, listVoices }: HttpDeps): Express => {
  const app = express();
  app.use(express.json({ limit: "64kb" }), requestLog("admin"));

  app.get("/api/agents", (_req, res) => res.json(store.list()));
  app.post("/api/agents", handle((req, res) => res.status(201).json(store.create(agentInputSchema.parse(req.body)))));
  app.put(
    "/api/agents/:id",
    handle((req, res) => {
      const agent = store.update(req.params.id, agentInputSchema.parse(req.body));
      logEvent("agent.saved", { agent: agent.name, mode: agent.mode });
      res.json(agent);
    }),
  );
  app.get("/api/voices", handle(async (_req, res) => res.json(await listVoices())));

  app.get(
    "/api/numbers",
    handle(async (_req, res) => {
      const numbers = await telephony.listNumbers();
      const views: PhoneNumberView[] = numbers.map((number) => ({
        ...number,
        agentId: store.agentForNumber(number.phoneNumber)?.id ?? null,
      }));
      res.json(views);
    }),
  );

  app.post(
    "/api/numbers/:sid/assign",
    handle(async (req, res) => {
      const { agentId } = assignRequestSchema.parse(req.body);
      const agent = store.get(agentId);
      const number = (await telephony.listNumbers()).find((candidate) => candidate.sid === req.params.sid);
      if (!number) throw new HttpError(404, "Phone number not found in your Twilio account.");
      await telephony.routeInbound(number.sid, INBOUND_URL, STATUS_URL);
      store.assign(number.phoneNumber, agent.id);
      logEvent("number.assigned", { number: number.phoneNumber, agent: agent.name });
      const view: PhoneNumberView = { ...number, agentId: agent.id };
      res.json(view);
    }),
  );

  app.post(
    "/api/calls",
    handle(async (req, res) => {
      const { agentId, to, context, plannedMinutes } = callRequestSchema.parse(req.body);
      const agent = store.get(agentId);
      const from = store.numberForAgent(agent.id) ?? env.TWILIO_PHONE_NUMBER;
      if (!from) throw new HttpError(409, "Assign a Twilio number to this agent first.");
      if (pool.isFull) throw new HttpError(503, "Concurrent call limit reached.");
      const params = streamParams(agent.id);
      contexts.set(params.callId, buildBrief(context, plannedMinutes));
      const sid = await telephony.placeCall({ to, from, twiml: telephony.streamTwiml(WS_URL, params), statusUrl: STATUS_URL });
      traces.for(sid).log("call.placed", { to, from, agent: agent.name, mode: agent.mode, has_context: Boolean(context) });
      res.status(201).json(registry.create({ sid, agentId: agent.id, direction: "outbound", from, to, status: "initiating" }));
    }),
  );

  app.get(
    "/api/calls/:sid",
    handle((req, res) => {
      const record = registry.get(req.params.sid);
      if (!record) throw new HttpError(404, "Call not found.");
      res.json(record);
    }),
  );

  app.get(
    "/api/calls/:sid/trace",
    handle((req, res) => {
      const trace = traces.get(req.params.sid);
      if (!trace) throw new HttpError(404, "No trace for this call yet.");
      res.json(trace.view());
    }),
  );

  app.use(onError);
  return app;
};

export const createPublicApp = ({ store, registry, telephony, pool, traces }: HttpDeps): Express => {
  const app = express();
  app.use(express.urlencoded({ extended: false, limit: "64kb" }), requestLog("twilio"));

  const verified: RequestHandler = (req, res, next) => {
    const signature = req.header("x-twilio-signature") ?? "";
    const params = req.body as Record<string, string>;
    if (!telephony.validateWebhook(`${env.PUBLIC_BASE_URL}${req.originalUrl}`, params, signature)) {
      logEvent("twilio.webhook_rejected", { path: req.path });
      res.status(403).end();
      return;
    }
    next();
  };

  const callbackSchema = z.object({
    CallSid: z.string(),
    CallStatus: z.string().optional(),
    From: z.string().default(""),
    To: z.string().default(""),
  });

  app.post("/twilio/voice/inbound", verified, (req, res) => {
    const { CallSid, From, To } = callbackSchema.parse(req.body);
    const agent = store.agentForNumber(To);
    const trace = traces.for(CallSid);
    res.type("text/xml");
    if (!agent || pool.isFull) {
      trace.log("inbound.rejected", { to: To, reason: agent ? "capacity" : "no_agent_assigned" });
      res.send(telephony.rejectTwiml("Sorry, this number is not available right now."));
      return;
    }
    trace.log("inbound.accepted", { from: From, to: To, agent: agent.name, mode: agent.mode });
    registry.create({ sid: CallSid, agentId: agent.id, direction: "inbound", from: From, to: To, status: "connected" });
    res.send(telephony.streamTwiml(WS_URL, streamParams(agent.id)));
  });

  app.post("/twilio/status", verified, (req, res) => {
    const { CallSid, CallStatus } = callbackSchema.parse(req.body);
    const status = CallStatus ? STATUS_MAP[CallStatus] : undefined;
    traces.for(CallSid).log("twilio.status", { status: CallStatus ?? "unknown" });
    if (status) registry.update(CallSid, status);
    res.status(204).end();
  });

  app.use(onError);
  return app;
};

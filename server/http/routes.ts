import {
  numberSearchSchema,
  numberPurchaseSchema,
  numberAssignmentSchema,
  numberRenameSchema,
} from "../../lib/phone-numbers";
import type { MongoCallRepository } from "../storage/calls";
import type { ObjectStore } from "../storage/objects";
import type { RedisCallState } from "../storage/redis";
import { warmTransferRoutes } from "../transfers/routes";
import { meetingRoutes } from "../meetings/routes";
import type { MeetingService } from "../meetings/service";
import type { WarmTransferCoordinator } from "../transfers/coordinator";
import type { CostTracker } from "../billing/tracker";
import { randomUUID } from "node:crypto";
import express, {
  type Express,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Router,
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
import { logEvent } from "../observability/trace";
import { diagnosticEvents, errorDetail } from "../observability/diagnostics";
import { effectiveAssistant } from "../engine/settings";
import type { AgentRepository } from "../store/agents";
import type { CallRegistry } from "../store/calls";
import type { ContextStore } from "../store/contexts";
import type { ToolRepository } from "../tools/registry";
import { voicemailAction } from "../calls/voicemail";
import {
  environmentTwilioCredentials,
  twilioConnectionStatus,
  type TwilioSettings,
} from "../providers/twilio-settings";
export interface HttpDeps {
  store: AgentRepository;
  registry: CallRegistry;
  telephony: Telephony;
  pool: SessionPool;
  traces: TraceStore;
  contexts: ContextStore;
  tools: ToolRepository;
  listVoices: () => Promise<VoiceOption[]>;
  pendingCalls: number;
  warmTransfers?: WarmTransferCoordinator;
  twilioSettings?: TwilioSettings;
  billingRouter?: Router;
  apiKeysRouter?: Router;
  phoneNumbers?: import("../phone-numbers/service").PhoneNumbers;
  meetings?: MeetingService;
  costs?: CostTracker;
  finalizeCall?: (sid: string) => Promise<void>;
  retryStorage?: (sid: string) => Promise<void>;
  serverEvents?: import("../webhooks/outbox").ServerEventOutbox;
  calls?: MongoCallRepository;
  objects?: ObjectStore;
  callState?: RedisCallState;
  recordingReady?: (sid: string, recordingSid: string) => Promise<void>;
  startRecording?: (sid: string) => Promise<void>;
}
const configPageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  after: z.string().uuid().optional(),
});
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
const requestLog =
  (traces: TraceStore, scope: string): RequestHandler =>
  (req, res, next) => {
    const began = Date.now(),
      requestId = randomUUID();
    const sid =
      typeof req.body?.CallSid === "string" &&
      /^[A-Za-z0-9_-]{1,80}$/.test(req.body.CallSid)
        ? req.body.CallSid
        : "";
    const log = sid ? traces.for(sid).log.bind(traces.for(sid)) : logEvent;
    const record = scope === "twilio" || req.method !== "GET";
    if (record)
      log(`${scope}.request`, {
        requestId,
        method: req.method,
        path: req.path,
      });
    res.on("finish", () => {
      if (record || res.statusCode >= 400)
        log(`${scope}.response`, {
          requestId,
          method: req.method,
          path: req.path,
          status: res.statusCode,
          ms: Date.now() - began,
        });
    });
    next();
  };
const onError = (
  error: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void => {
  logEvent("http.failed", {
    method: req.method,
    path: req.path,
    ...errorDetail(error),
  });
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
  (!d.callState &&
    d.pendingCalls + d.registry.activeCount >= env.MAX_CONCURRENT_CALLS);
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
export const createAdminApp = (
  d: HttpDeps,
  auth: { router: Router; requireUser: RequestHandler },
): Express => {
  const { store, registry, telephony, tools, contexts, traces } = d;
  const app = express();
  app.disable("x-powered-by");
  app.get("/health", (_req, res) => res.json({ status: "ok" }));
  app.use("/api/v1/auth", auth.router);
  app.use(auth.requireUser);
  app.use(express.json({ limit: "128kb" }));
  app.use(requestLog(traces, "admin"));
  app.use((req, res, next) => {
    void Promise.resolve(d.twilioSettings?.refresh()).then(() => next(), next);
  });
  app.use((req, res, next) => {
    const origin = req.get("origin");
    if (origin) {
      try {
        if (new URL(origin).host !== req.get("host")) throw new Error();
      } catch {
        res.status(403).json({ error: "Cross-origin request rejected." });
        return;
      }
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
  app.get(
    "/api/diagnostics",
    handle(async (req, res) =>
      res.set("Cache-Control", "no-store").json({
        configuration: {
          missing: missingConfiguration(d),
          publicBaseUrl: env.PUBLIC_BASE_URL,
          inboundUrl: `${env.PUBLIC_BASE_URL}/twilio/voice/inbound`,
          mediaUrl: `${env.PUBLIC_BASE_URL.replace(/^https/, "wss")}/media`,
          assistants: await Promise.all(
            (await store.list()).map(async (a) => ({
              id: a.id,
              name: a.name,
              voiceConfigured: !!effectiveAssistant(a).voiceId,
              voiceSource: a.voiceId
                ? "assistant"
                : env.ELEVENLABS_VOICE_ID
                  ? "server default"
                  : "missing",
              assignedNumber: (await store.numberForAgent(a.id)) ?? null,
              firstMessageMode: a.firstMessageMode,
            })),
          ),
        },
        events: diagnosticEvents(
          typeof req.query.callSid === "string" ? req.query.callSid : undefined,
          500,
        ),
      }),
    ),
  );
  app.put(
    "/api/integrations/twilio",
    handle(async (req, res) => {
      res.set("Cache-Control", "no-store");
      if (!d.twilioSettings)
        throw new HttpError(503, "Twilio connection settings are unavailable.");
      if (d.callState && (await d.callState.activeCount()) > 0)
        throw new HttpError(
          409,
          "Finish active calls before changing credentials.",
        );
      const connect = async () => {
        const numbers = await d.twilioSettings!.connect(
          req.body,
          () =>
            registry.activeCount > 0 ||
            d.pendingCalls > 0 ||
            d.pool.size > 0 ||
            !!d.warmTransfers?.hasActiveTransfers,
        );
        return d.phoneNumbers
          ? d.phoneNumbers.sync(numbers)
          : Promise.all(
              numbers.map(async (n) => ({
                ...n,
                agentId:
                  (await store.agentForNumber(n.phoneNumber))?.id ?? null,
              })),
            );
      };
      const numbers = await (d.phoneNumbers
        ? d.phoneNumbers.exclusive(connect)
        : connect());
      return res.json({
        connection: d.twilioSettings.status(),
        numbers,
        missing: missingConfiguration(d),
      });
    }),
  );
  if (d.apiKeysRouter) app.use("/api/api-keys", d.apiKeysRouter);
  if (d.billingRouter) app.use("/api/billing", d.billingRouter);
  app.get(
    "/api/agents",
    handle(async (req, res) => {
      const page = configPageSchema.parse(req.query);
      const items = await store.list(page);
      if (items.length === page.limit)
        res.set("X-Next-Cursor", items[items.length - 1].id);
      return res.json(items);
    }),
  );
  app.post(
    "/api/agents",
    handle(async (req, res) => {
      const input = agentInputSchema.parse(req.body);
      await tools.resolve(input.toolIds);
      return res.status(201).json(await store.create(input));
    }),
  );
  app.put(
    "/api/agents/:id",
    handle(async (req, res) => {
      const input = agentInputSchema.parse(req.body);
      await tools.resolve(input.toolIds);
      return res.json(await store.update(req.params.id, input));
    }),
  );
  app.get(
    "/api/tools",
    handle(async (req, res) => {
      const page = configPageSchema.parse(req.query);
      const items = await tools.list(page);
      if (items.length === page.limit)
        res.set("X-Next-Cursor", items[items.length - 1].id);
      return res.json(items);
    }),
  );
  app.post(
    "/api/tools",
    handle(async (req, res) =>
      res.status(201).json(await tools.save(toolSchema.parse(req.body))),
    ),
  );
  app.put(
    "/api/tools/:id",
    handle(async (req, res) => {
      await tools.get(req.params.id);
      return res.json(
        await tools.save(toolSchema.parse(req.body), req.params.id),
      );
    }),
  );
  app.delete(
    "/api/tools/:id",
    handle(async (req, res) => {
      if (await store.usesTool(req.params.id))
        throw new HttpError(
          409,
          "Detach this tool from assistants before deleting it.",
        );
      await tools.delete(req.params.id);
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
    "/api/numbers/available",
    handle(async (req, res) => {
      if (!d.phoneNumbers)
        throw new HttpError(503, "Phone number management is unavailable.");
      res.set("Cache-Control", "no-store");
      res.json(
        await d.phoneNumbers.search(numberSearchSchema.parse(req.query)),
      );
    }),
  );
  app.post(
    "/api/numbers/purchase",
    handle(async (req, res) => {
      if (!d.phoneNumbers)
        throw new HttpError(503, "Phone number management is unavailable.");
      res
        .status(201)
        .json(
          await d.phoneNumbers.purchase(numberPurchaseSchema.parse(req.body)),
        );
    }),
  );
  app.patch(
    "/api/numbers/:sid",
    handle(async (req, res) => {
      if (!d.phoneNumbers)
        throw new HttpError(503, "Phone number management is unavailable.");
      const sid = z
        .string()
        .regex(/^PN[a-f0-9]{32}$/i)
        .parse(req.params.sid);
      res.json(
        await d.phoneNumbers.update(sid, numberRenameSchema.parse(req.body)),
      );
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
      res.set("Cache-Control", "no-store");
      if (d.phoneNumbers) return res.json(await d.phoneNumbers.list());
      const list: PhoneNumberView[] = await Promise.all(
        (await telephony.listNumbers()).map(async (n) => ({
          ...n,
          agentId: (await store.agentForNumber(n.phoneNumber))?.id ?? null,
        })),
      );
      return res.json(list);
    }),
  );
  app.post(
    "/api/numbers/:sid/assign",
    handle(async (req, res) => {
      if (d.phoneNumbers) {
        const sid = z
          .string()
          .regex(/^PN[a-f0-9]{32}$/i)
          .parse(req.params.sid);
        const { agentId } = numberAssignmentSchema.parse(req.body);
        return res.json(
          await d.phoneNumbers.update(sid, { assistantId: agentId }),
        );
      }
      const agent = effectiveAssistant(
        await store.get(assignRequestSchema.parse(req.body).agentId),
      );
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
        await store.assign(n.phoneNumber, agent.id);
        logEvent("inbound.number_routed", {
          numberSid: n.sid,
          agentId: agent.id,
          voiceUrl: `${env.PUBLIC_BASE_URL}/twilio/voice/inbound`,
        });
        return res.json({ ...n, agentId: agent.id });
      } finally {
        d.pendingCalls--;
      }
    }),
  );
  app.get(
    "/api/calls",
    handle(async (req, res) => {
      if (!d.calls) return res.json(registry.list());
      const query = z
        .object({
          limit: z.coerce.number().int().min(1).max(100).default(50),
          cursor: z.string().optional(),
          assistantId: z.string().optional(),
        })
        .parse(req.query);
      const page = await d.calls.list(query);
      if (page.nextCursor) res.set("X-Next-Cursor", page.nextCursor);
      return res.json(page.items);
    }),
  );
  app.post(
    "/api/calls",
    handle(async (req, res) => {
      const input = callRequestSchema.parse(req.body),
        agent = effectiveAssistant(await store.get(input.agentId));
      requireReady(d, agent.voiceId);
      if (capacity(d))
        throw new HttpError(503, "Concurrent call limit reached.");
      if (d.callState) {
        const limit = await d.callState.rateLimit(
          "outbound",
          env.CALLS_PER_MINUTE,
          60000,
        );
        if (!limit.allowed) {
          res.set("Retry-After", String(Math.ceil(limit.retryAfterMs / 1000)));
          throw new HttpError(429, "Call rate limit reached.");
        }
      }
      d.pendingCalls++;
      const callId = randomUUID();
      try {
        if (
          d.callState &&
          !(await d.callState.reserve(callId, env.MAX_CONCURRENT_CALLS, 600000))
        )
          throw new HttpError(503, "Concurrent call limit reached.");
        const from =
          input.from ??
          (await store.numberForAgent(agent.id)) ??
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
        const attachedTools = await tools.resolve(agent.toolIds);
        await contexts.setAsync(callId, {
          agent,
          tools: attachedTools,
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
        logEvent("outbound.dial_requested", {
          callId,
          agentId: agent.id,
          voiceId: agent.voiceId,
          publicBaseUrl: env.PUBLIC_BASE_URL,
          firstMessageMode: agent.firstMessageMode,
        });
        const sid = await telephony.placeCall({
          to: input.to,
          from,
          url: `${env.PUBLIC_BASE_URL}/twilio/voice/outbound?${query}`,
          statusUrl: `${env.PUBLIC_BASE_URL}/twilio/status?callId=${callId}`,
          voicemail: agent.voicemailDetection,
        });
        await contexts.bindAsync(callId, sid);
        const record =
          registry.get(sid) ??
          registry.create({
            sid,
            agentId: agent.id,
            assistant: structuredClone(agent),
            tools: structuredClone(attachedTools),
            direction: "outbound",
            from,
            to: input.to,
            status: "initiating",
          });
        traces.for(sid).log("call.placed", { agent: agent.name, callId });
        await registry.flush();
        await traces.flush();
        return res.status(201).json(record);
      } catch (e) {
        await d.callState?.release(callId);
        await contexts.deleteAsync(callId);
        throw e;
      } finally {
        d.pendingCalls--;
      }
    }),
  );
  app.use("/api/calls/:sid", (req, _res, next) => {
    void registry.load(req.params.sid).then(record => {
      if (!record) throw new HttpError(404, "Call not found.");
      next();
    }).catch(next);
  });
  app.get(
    "/api/calls/:sid/transfer",
    handle(async (req, res) =>
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
      await registry.flush();
      await traces.flush();
      return res.json(d.warmTransfers.view(req.params.sid));
    }),
  );
  app.get(
    "/api/calls/:sid",
    handle(async (req, res) => {
      const r = await registry.load(req.params.sid);
      if (!r) throw new HttpError(404, "Call not found.");
      await registry.flush();
      await traces.flush();
      return res.json(r);
    }),
  );
  app.post(
    "/api/calls/:sid/end",
    handle(async (req, res) => {
      const r = await registry.load(req.params.sid);
      if (!r) throw new HttpError(404, "Call not found.");
      if (!["completed", "failed"].includes(r.status)) {
        await telephony.endCall(r.sid);
        await d.warmTransfers?.callerEnded(r.sid);
        registry.patch(r.sid, { endedReason: "user-ended" });
        registry.update(r.sid, "completed");
        await d.finalizeCall?.(r.sid);
      }
      await registry.flush();
      await traces.flush();
      return res.json(registry.get(r.sid));
    }),
  );
  app.get(
    "/api/calls/:sid/trace",
    handle(async (req, res) => {
      if (d.calls) {
        const record = await d.calls.get(req.params.sid);
        if (!record) throw new HttpError(404, "Call not found.");
        await registry.flush();
        await traces.flush();
        return res.json(
          await d.calls.trace(
            req.params.sid,
            z
              .object({
                limit: z.coerce.number().int().min(1).max(1000).optional(),
                eventsCursor: z.string().optional(),
                transcriptCursor: z.string().optional(),
              })
              .parse(req.query),
          ),
        );
      }
      const trace = traces.get(req.params.sid);
      if (!trace) throw new HttpError(404, "No trace available for this call.");
      await registry.flush();
      await traces.flush();
      return res.json(trace.view());
    }),
  );
  app.get("/api/calls/:sid/server-events", handle(async (req, res) => {
    if (!d.calls || !d.serverEvents) throw new HttpError(503, "Server events unavailable.");
    const call = await d.calls.get(z.string().regex(/^[A-Za-z0-9_-]{1,80}$/).parse(req.params.sid));
    if (!call) throw new HttpError(404, "Call not found.");
    return res.json(await d.serverEvents.list(call.sid));
  }));
  app.post("/api/calls/:sid/server-events/retry", handle(async (req, res) => {
    if (!d.calls || !d.serverEvents) throw new HttpError(503, "Server events unavailable.");
    const call = await d.calls.get(z.string().regex(/^[A-Za-z0-9_-]{1,80}$/).parse(req.params.sid));
    if (!call) throw new HttpError(404, "Call not found.");
    await d.serverEvents.retryFailed(call.sid);
    return res.status(202).json({ accepted: true });
  }));
  app.post(
    "/api/calls/:sid/storage/retry",
    handle(async (req, res) => {
      if (!d.calls || !d.retryStorage)
        throw new HttpError(503, "Storage queue is unavailable.");
      const record = await d.calls.get(req.params.sid);
      if (!record) throw new HttpError(404, "Call not found.");
      if (!["completed", "failed"].includes(record.status))
        throw new HttpError(409, "Wait for the call to end.");
      await d.retryStorage(record.sid);
      return res.status(202).json({ status: "queued" });
    }),
  );
  app.get(
    "/api/calls/:sid/usage",
    handle(async (req, res) => {
      if (!d.calls) throw new HttpError(503, "Usage storage is unavailable.");
      if (!(await d.calls.get(req.params.sid)))
        throw new HttpError(404, "Call not found.");
      await traces.flush();
      return res.json({
        callId: req.params.sid,
        usage:
          (await d.calls.getBillingUsage(req.params.sid)) ??
          (await d.calls.getUsage(req.params.sid)) ??
          null,
      });
    }),
  );
  app.get(
    "/api/calls/:sid/artifacts/:kind",
    handle(async (req, res) => {
      if (!d.calls || !d.objects)
        throw new HttpError(503, "Artifact storage is unavailable.");
      const record = await d.calls.get(req.params.sid);
      if (!record) throw new HttpError(404, "Call not found.");
      const kind = z
        .enum(["transcript", "messages", "logs", "recording"])
        .parse(req.params.kind);
      const artifact = record.artifact?.[kind];
      if (!artifact) throw new HttpError(404, "Artifact is not available yet.");
      return res.json({
        url: await d.objects.signedUrl(artifact.key),
        expiresIn: 300,
      });
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
    void Promise.resolve(d.twilioSettings?.refresh()).then(
      () => verifyRequest(req, res, next),
      next,
    );
  };
  const verifyRequest: RequestHandler = (req, res, next) => {
    const accountSid = d.twilioSettings?.current().accountSid;
    if (
      accountSid &&
      req.body?.AccountSid &&
      req.body.AccountSid !== accountSid
    ) {
      res.status(403).end();
      return;
    }
    if (
      !telephony.validateWebhook(
        `${env.PUBLIC_BASE_URL}${req.originalUrl}`,
        req.body as Record<string, string>,
        req.get("x-twilio-signature") ?? "",
      )
    ) {
      const detail = {
        path: req.path,
        publicBaseUrl: env.PUBLIC_BASE_URL,
        signed: !!req.get("x-twilio-signature"),
        hint: "Match PUBLIC_BASE_URL to the current HTTPS ngrok origin, restart the backend, and reassign the number if the URL changed.",
      };
      logEvent("twilio.webhook_rejected", detail);
      res.status(403).end();
      return;
    }
    const sid = req.body?.CallSid;
    if (
      sid !== undefined &&
      sid !== "" &&
      (typeof sid !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(sid))
    ) {
      res.status(400).json({ error: "Invalid call identifier." });
      return;
    }
    if (typeof sid === "string" && sid)
      traces.for(sid).log("twilio.webhook_verified", { path: req.path });
    requestLog(traces, "twilio")(req, res, next);
  };
  const bodySchema = z.object({
    CallSid: z.string().min(1),
    From: z.string().default(""),
    To: z.string().default(""),
    AnsweredBy: z.string().default(""),
    CallStatus: z.string().optional(),
    CallDuration: z.string().optional(),
  });
  const stream = async (agentId: string, callId: string) => {
    const sid = (await contexts.getAsync(callId))?.sid;
    if (sid) {
      traces.for(sid).log("media.awaiting_connection", {
        callId,
        mediaUrl: `${env.PUBLIC_BASE_URL.replace(/^https/, "wss")}/media`,
      });
      setTimeout(() => {
        void contexts
          .getAsync(callId)
          .then((context) => {
            if (context)
              traces.for(sid).log("media.start_timeout", {
                hint: "Twilio has not started /media. Check HTTPS/WSS reachability and Twilio stream errors.",
              });
          })
          .catch((error) =>
            traces
              .for(sid)
              .log("media.context_check_failed", errorDetail(error)),
          );
      }, 15000).unref();
    }
    return telephony.streamTwiml(
      `${env.PUBLIC_BASE_URL.replace(/^https/, "wss")}/media`,
      { agentId, callId, token: signStreamToken(agentId, callId) },
      `${env.PUBLIC_BASE_URL}/twilio/stream-status`,
    );
  };
  app.post(
    "/twilio/voice/inbound",
    verified,
    handle(async (req, res) => {
      const b = bodySchema.parse(req.body),
        assigned = d.phoneNumbers
          ? await d.phoneNumbers.inboundAssistant(b.To)
          : await store.agentForNumber(b.To),
        agent = assigned ? effectiveAssistant(assigned) : undefined;
      res.type("text/xml");
      const existingId = await contexts.idForSidAsync(b.CallSid);
      if (agent && existingId)
        return res.send(await stream(agent.id, existingId));
      const missing = missingConfiguration(d);
      const reason = !agent
        ? "no-agent-assigned"
        : capacity(d)
          ? "capacity-or-credentials-update"
          : missing.length
            ? "configuration-missing"
            : !agent.voiceId
              ? "voice-id-missing"
              : "";
      if (reason) {
        traces.for(b.CallSid).log("inbound.rejected", {
          reason,
          missing: missing.join(", "),
          agentId: agent?.id ?? "",
          hint:
            reason === "no-agent-assigned"
              ? "Assign this number to an assistant in Phone numbers."
              : reason === "voice-id-missing"
                ? "Set an assistant voice ID or ELEVENLABS_VOICE_ID."
                : "Check Diagnostics configuration and the backend log.",
        });
        registry.create({
          sid: b.CallSid,
          agentId: agent?.id ?? "",
          assistant: agent ? structuredClone(agent) : undefined,
          direction: "inbound",
          from: b.From,
          to: b.To,
          status: "failed",
          endedReason: reason,
        });
        await registry.flush();
        await traces.flush();
        return res.send(
          telephony.rejectTwiml(
            "Sorry, this number is not available right now.",
          ),
        );
      }
      if (!agent) throw new HttpError(404, "Assigned assistant not found.");
      traces.for(b.CallSid).log("inbound.accepted", {
        agentId: agent.id,
        voiceId: agent.voiceId,
        firstMessageMode: agent.firstMessageMode,
      });
      const callId = randomUUID();
      if (
        d.callState &&
        !(await d.callState.reserve(callId, env.MAX_CONCURRENT_CALLS, 600000))
      )
        throw new HttpError(503, "Concurrent call limit reached.");
      const attachedTools = await tools.resolve(agent.toolIds);
      await contexts.setAsync(callId, {
        agent,
        tools: attachedTools,
        brief: "",
        direction: "inbound",
        purpose: "conversation",
        sid: b.CallSid,
      });
      registry.create({
        sid: b.CallSid,
        agentId: agent.id,
        assistant: structuredClone(agent),
        tools: structuredClone(attachedTools),
        direction: "inbound",
        from: b.From,
        to: b.To,
        status: "connected",
      });
      await registry.flush();
      await traces.flush();
      return res.send(await stream(agent.id, callId));
    }),
  );
  app.post(
    "/twilio/voice/outbound",
    verified,
    handle(async (req, res) => {
      const b = bodySchema.parse(req.body),
        q = z
          .object({
            agentId: z.string(),
            callId: z.string(),
            token: z.string(),
          })
          .parse(req.query);
      const context = await contexts.getAsync(q.callId);
      if (
        !context ||
        context.agent.id !== q.agentId ||
        !verifyStreamToken(q.agentId, q.callId, q.token) ||
        !(await contexts.bindAsync(q.callId, b.CallSid))
      ) {
        traces.for(b.CallSid).log("outbound.context_rejected", {
          contextPresent: !!context,
          agentMatches: context?.agent.id === q.agentId,
          hint: "Keep one backend process and do not restart between call creation and media connection.",
        });
        throw new HttpError(403, "Invalid call context.");
      }
      if (!registry.get(b.CallSid))
        registry.create({
          sid: b.CallSid,
          agentId: q.agentId,
          assistant: structuredClone(context.agent),
          tools: structuredClone(context.tools),
          direction: "outbound",
          from: b.From,
          to: b.To,
          status: "connected",
          requestId: context.requestId,
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
        await contexts.deleteAsync(q.callId);
        registry.patch(b.CallSid, {
          endedReason: b.AnsweredBy.startsWith("machine")
            ? "voicemail"
            : "answer-detection-ended",
        });
        await registry.flush();
        await traces.flush();
        return res.send("<Response><Hangup/></Response>");
      }
      await contexts.updatePurposeAsync(q.callId, action);
      await registry.flush();
      await traces.flush();
      return res.send(await stream(q.agentId, q.callId));
    }),
  );
  app.post(
    "/twilio/stream-status",
    verified,
    handle(async (req, res) => {
      const b = z
        .object({
          CallSid: z.string(),
          StreamSid: z.string().optional(),
          StreamEvent: z.string(),
          StreamError: z.string().optional(),
        })
        .parse(req.body);
      await registry.load(b.CallSid);
      traces.for(b.CallSid).log("twilio.stream_status", {
        streamSid: b.StreamSid ?? "",
        event: b.StreamEvent,
        message: b.StreamError ?? "",
      });
      if (b.StreamEvent === "stream-error")
        registry.patch(b.CallSid, {
          endedReason: `media-stream-error: ${b.StreamError ?? "Check Twilio stream diagnostics."}`,
        });
      await registry.flush();
      await traces.flush();
      return res.status(204).end();
    }),
  );
  app.post(
    "/twilio/status",
    verified,
    handle(async (req, res) => {
      const b = bodySchema.parse(req.body),
        status = b.CallStatus ? statusMap[b.CallStatus] : undefined;
      if (!registry.get(b.CallSid) && typeof req.query.callId === "string") {
        const c = await contexts.getAsync(req.query.callId);
        if (c && (await contexts.bindAsync(req.query.callId, b.CallSid)))
          registry.create({
            sid: b.CallSid,
            agentId: c.agent.id,
            assistant: structuredClone(c.agent),
            tools: structuredClone(c.tools),
            direction: "outbound",
            from: c.from ?? b.From,
            to: c.to ?? b.To,
            status: "initiating",
            requestId: c.requestId,
          });
      }
      await registry.load(b.CallSid);
      if (status) registry.update(b.CallSid, status);
      if (status === "failed")
        registry.patch(b.CallSid, { endedReason: b.CallStatus });
      traces.for(b.CallSid).log("twilio.status", {
        status: b.CallStatus ?? "unknown",
        errorCode:
          typeof req.body.ErrorCode === "string" ? req.body.ErrorCode : "",
        errorMessage:
          typeof req.body.ErrorMessage === "string"
            ? req.body.ErrorMessage
            : "",
      });
      if (status === "completed" || status === "failed") {
        if (typeof req.query.callId === "string")
          await d.callState?.release(req.query.callId);
        if (status === "completed") {
          try {
            const usage = await d.telephony.getCallUsage(b.CallSid);

            d.costs?.addTelephonyUsage(b.CallSid, usage);
            traces.for(b.CallSid).log("twilio.usage", {
              duration_seconds: Number(usage.duration ?? b.CallDuration ?? 0),
              price: usage.price ?? "pending",
              price_unit: usage.priceUnit ?? "unknown",
            });
          } catch (error) {
            traces.for(b.CallSid).log("twilio.usage_error", {
              message: error instanceof Error ? error.message : "Unknown error",
            });
          }
        }
        const contextId = await contexts.idForSidAsync(b.CallSid);
        if (contextId) {
          await d.callState?.release(contextId);
          await contexts.deleteAsync(contextId);
        }
        await d.warmTransfers?.callerEnded(b.CallSid);
        traces.for(b.CallSid).finish();
        const secs =
          req.body.CallDuration !== undefined
            ? Number(req.body.CallDuration)
            : status === "failed"
              ? 0
              : undefined;
        d.costs?.finalize(b.CallSid, secs);
        await d.finalizeCall?.(b.CallSid);
        await d.callState?.removeLiveCall(b.CallSid);
        if (typeof req.query.callId === "string")
          await contexts.deleteAsync(req.query.callId);
      }
      await registry.flush();
      await traces.flush();
      return res.status(204).end();
    }),
  );
  app.post(
    "/twilio/transfer-status",
    verified,
    handle(async (req, res) => {
      const b = z
        .object({ CallSid: z.string(), DialCallStatus: z.string() })
        .parse(req.body);
      await registry.load(b.CallSid);
      registry.patch(b.CallSid, {
        transferStatus: b.DialCallStatus,
        endedReason: `transfer-${b.DialCallStatus}`,
      });
      traces
        .for(b.CallSid)
        .log("transfer.finished", { status: b.DialCallStatus });
      await registry.flush();
      await traces.flush();
      return res.type("text/xml").send("<Response><Hangup/></Response>");
    }),
  );
  app.post(
    "/twilio/recording-status",
    verified,
    handle(async (req, res) => {
      const body = z
        .object({
          CallSid: z.string().regex(/^CA[a-f0-9]{32}$/i),
          RecordingSid: z.string().regex(/^RE[a-f0-9]{32}$/i),
          RecordingStatus: z.string(),
        })
        .parse(req.body);
      if (body.RecordingStatus === "completed")
        await d.recordingReady?.(body.CallSid, body.RecordingSid);
      return res.status(204).end();
    }),
  );
  if (d.warmTransfers)
    app.use(warmTransferRoutes(d.warmTransfers, contexts, verified));
  app.use(onError);
  return app;
};

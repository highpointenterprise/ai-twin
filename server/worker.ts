import "dotenv/config";
import { PhoneNumbers } from "./phone-numbers/service";
import { NumberRepository } from "./phone-numbers/repository";
import { createTwilioNumberProvider } from "./providers/twilio-numbers";
import { AssistantServerEvents } from "./webhooks/service";
import { errorDetail } from "./observability/diagnostics";
import { createServer } from "node:http";
import { join } from "node:path";
import { env, missingCallConfiguration } from "../lib/env";
import { assistantSchema } from "../lib/config";
import type { EngineDeps } from "./core/ports";
import { SessionPool } from "./engine/pool";
import { StandardSession } from "./engine/standard-session";
import { attachMediaServer } from "./http/media";
import { createAdminApp, createPublicApp, type HttpDeps } from "./http/routes";
import { logEvent, TraceStore } from "./observability/trace";
import { createDeepgramTranscriber } from "./providers/deepgram";
import { MongoClient } from "mongodb";
import Redis from "ioredis";
import { Readable } from "node:stream";
import type { CallUsage } from "../lib/types";
import { MongoAgentStore, MongoToolRegistry } from "./storage/config";
import { MongoCallRepository } from "./storage/calls";
import { MongoTwilioCredentialStore } from "./storage/credentials";
import { ObjectStore } from "./storage/objects";
import {
  ArtifactQueue,
  RedisContextBackend,
  RedisCallState,
} from "./storage/redis";
import { reconcileCallCost } from "./billing/reconcile";
import { twilioClient } from "./providers/twilio";
import { loadDatabaseRates } from "./billing/pricing";
import {
  createElevenLabsSynthesizer,
  listElevenLabsVoices,
} from "./providers/elevenlabs";
import { createOpenAiModel } from "./providers/openai";
import { WarmTransferCoordinator } from "./transfers/coordinator";
import { createConsultationSession } from "./transfers/consultation";
import {
  createTwilioWarmTelephony,
  createTwilioTelephony,
} from "./providers/twilio";
import { CallRegistry } from "./store/calls";
import { ContextStore } from "./store/contexts";
import { ToolExecutor } from "./tools/executor";
import { TwilioSettings } from "./providers/twilio-settings";
import { MongoTransferStore } from "./storage/transfers";
import { createApiV1, createRootApp } from "./api/v1";
import { deriveRecordings } from "./storage/recording-derivatives";
import { metrics } from "./observability/metrics";
import { MeetingService } from "./meetings/service";
import { MeetingStore } from "./meetings/store";
import { GoogleMeetBrowserDriver } from "./meetings/browser-driver";
import { createLiveAvatar } from "./meetings/liveavatar";
import { AuthStore } from "./auth/store";
import { createAuthRouter, requireUser } from "./auth/routes";
let startupStage = "configuration";
async function main(): Promise<void> {
  if (!env.WORKSPACE_USER_ID || !process.send) throw new Error("Workspace workers must be started by the gateway.");
  if (env.AUTH_API_SECRET.length < 32) throw new Error("AUTH_API_SECRET must contain at least 32 characters.");
  const background = new Set<Promise<unknown>>();
  const track = <T>(task: Promise<T>): Promise<T> => {
    background.add(task);
    void task.finally(() => background.delete(task)).catch(() => {});
    return task;
  };
  startupStage = "MongoDB connection";
  const mongo = new MongoClient(env.MONGODB_URI, {
    maxPoolSize: 50,
    minPoolSize: 2,
    serverSelectionTimeoutMS: 10000,
    writeConcern: { w: "majority" },
  });
  await mongo.connect();
  const db = mongo.db(env.MONGODB_DATABASE);
  const authStore = new AuthStore(mongo.db(env.AUTH_DATABASE));
  await authStore.initialize();
  startupStage = "Redis connection";
  const redis = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    lazyConnect: true,
  });
  await redis.connect();
  await redis.ping();
  startupStage = "R2/MinIO bucket access";
  const objects = new ObjectStore({
    prefix: env.OBJECT_PREFIX,
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    bucket: env.S3_BUCKET,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
  });
  await objects.check();
  startupStage = "MongoDB indexes and configuration";
  const calls = new MongoCallRepository(db);
  const store = new MongoAgentStore(db, env.WORKSPACE_USER_ID);
  const tools = new MongoToolRegistry(db, env.WORKSPACE_USER_ID);
  await Promise.all([
    calls.initialize(),
    tools.initialize(),
    store.initialize(),
  ]);
  const registry = new CallRegistry(undefined, calls);
  const pool = new SessionPool(env.MAX_CONCURRENT_CALLS),
    traces = new TraceStore(calls),
    contexts = new ContextStore(
      new RedisContextBackend(redis, `${env.REDIS_PREFIX}:{contexts}`),
    );
  const callState = new RedisCallState(redis, `${env.REDIS_PREFIX}:{calls}`);
  startupStage = "credential encryption key";
  const credentials = new MongoTwilioCredentialStore(
    db,
    env.CREDENTIAL_ENCRYPTION_KEY,
  );
  await credentials.initialize();
  const twilioSettings = new TwilioSettings(credentials, (credentials) =>
    createTwilioTelephony(() => credentials).listNumbers(),
  );
  const telephony = createTwilioTelephony(twilioSettings.current);
  const phoneNumbers = new PhoneNumbers({
    repository: new NumberRepository(db, env.WORKSPACE_USER_ID),
    settings: twilioSettings,
    telephony,
    provider: createTwilioNumberProvider(twilioSettings.current),
    assistants: store,
    publicBaseUrl: env.PUBLIC_BASE_URL,
  });
  const transferStore = new MongoTransferStore(db);
  await transferStore.initialize();
  const transferRecords = await transferStore.loadActive();
  for (const transfer of transferRecords) {
    await registry.load(transfer.callerSid);
    if (transfer.operatorSid) await registry.load(transfer.operatorSid);
  }
  const warmTransfers = new WarmTransferCoordinator({
    telephony: createTwilioWarmTelephony(twilioSettings.current),
    contexts,
    registry,
    traces,
    records: transferRecords,
    persistence: transferStore,
    onCallEnded: (sid) => finalizeCall(sid),
  });
  const executor = new ToolExecutor(telephony, fetch, warmTransfers);
  const engine: EngineDeps = {
    transcribe: createDeepgramTranscriber,
    synthesize: createElevenLabsSynthesizer,
    model: createOpenAiModel(),
    executeTool: async (tool, call, ctx) => {
      const result = await executor.execute(tool, call, ctx);
      if (
        result.terminal &&
        (tool.type !== "transferCall" || tool.transferMode !== "warm")
      )
        registry.patch(ctx.callSid, { transferStatus: "initiated" });
      return result;
    },
    endCall: async (sid, reason) => {
      await telephony.endCall(sid);
      registry.patch(sid, { endedReason: reason });
      registry.update(sid, "completed");
      await finalizeCall(sid);
    },
    onScreening: (sid) => registry.patch(sid, { screeningEncountered: true }),
  };
  const hosting = {
    monthlyUsd: env.HOSTING_MONTHLY_USD,
    expectedMinutesPerMonth: env.HOSTING_EXPECTED_MINUTES_PER_MONTH,
    egressUsdPerGb: env.HOSTING_EGRESS_USD_PER_GB,
  };
  const serverEvents = new AssistantServerEvents({ db, userId: env.WORKSPACE_USER_ID, calls, objects, baseUrl: env.PUBLIC_BASE_URL });
  await serverEvents.initialize();
  serverEvents.start();
  startupStage = "Redis job queue";
  const artifacts = new ArtifactQueue(
    env.REDIS_URL,
    async ({ sid, revision }) => {
      const record = await calls.get(sid);
      if (!record) throw new Error("Call is not persisted yet.");
      if (/^recording-RE[a-f0-9]{32}$/i.test(revision)) {
        const recordingSid = revision.slice("recording-".length);
        if (
          !/^RE[a-f0-9]{32}$/i.test(recordingSid) ||
          !/^CA[a-f0-9]{32}$/i.test(sid)
        )
          throw new Error("Invalid recording identity.");
        const auth = twilioSettings.current();
        // Resolve the recording through the provider API and verify it belongs to this call.
        const metadata = await twilioClient(auth)
          .recordings(recordingSid)
          .fetch();
        if (metadata.callSid !== sid)
          throw new Error("Recording does not belong to call.");
        const url = `https://api.twilio.com/2010-04-01/Accounts/${auth.accountSid}/Recordings/${recordingSid}.wav`;
        const response = await fetch(url, {
          headers: {
            Authorization: `Basic ${Buffer.from(`${auth.accountSid}:${auth.authToken}`).toString("base64")}`,
          },
          redirect: "error",
          signal: AbortSignal.timeout(120000),
        });
        if (!response.ok || !response.body)
          throw new Error(`Recording download failed (${response.status}).`);
        const artifact = await objects.putStream(
          `calls/${sid}/recordings/${recordingSid}.wav`,
          Readable.fromWeb(
            response.body as import("node:stream/web").ReadableStream,
          ),
          "audio/wav",
        );
        await calls.setArtifact(sid, "recording", artifact);
        await deriveRecordings(sid, artifact, objects, calls).catch((error) =>
          logEvent("recording.derivation_failed", { sid, ...errorDetail(error) }),
        );
        await calls.setRecordingUsage(
          sid,
          recordingSid,
          Number(metadata.duration),
        );
        await db.collection("recording_requests").updateOne({ _id: sid as never }, { $set: { state: "completed" } });
        await artifacts.enqueue(sid, `recording-cost-${recordingSid}`, 1000);
        return;
      }
      const assistant = record.assistant ?? (await store.find(record.agentId));
      const result = await reconcileCallCost({
        record,
        usage: (await calls.getUsage(sid)) as CallUsage | undefined,
        getProviderUsage: telephony.getCallUsage,
        children: await calls.children(sid),
        rates: await loadDatabaseRates(db),
        hosting,
        amd: assistant?.voicemailDetection.enabled ?? false,
      });
      await calls.saveCost(
        sid,
        result.cost,
        undefined,
        record.storageRevision ?? 0,
      );
      await db
        .collection<{ _id: string; usage: CallUsage }>("call_billing_usage")
        .updateOne(
          { _id: sid },
          { $set: { usage: result.usage } },
          { upsert: true },
        );
      await calls.exportArtifacts(sid, objects);
      if (result.retryReasons.length)
        throw new Error(result.retryReasons.join(" "));
      await serverEvents.enqueueEndOfCall(sid);
      await calls.markArchived(sid, record.storageRevision ?? 0);
      if (record.parentCallSid)
        await artifacts.enqueue(
          record.parentCallSid,
          `related-${sid}-${revision}`,
          1000,
        );
    },
    { prefix: env.REDIS_PREFIX },
  );
  await artifacts.ready();
  let dispatching = false;
  const dispatchPending = async () => {
    if (dispatching) return;
    dispatching = true;
    try {
      for (const sid of await calls.pendingArchives()) {
        const call = await calls.get(sid);
        if (call)
          await artifacts.enqueue(
            sid,
            `final-v${call.storageRevision ?? 0}`,
            5000,
          );
        await calls.markDispatched(sid);
      }
    } finally {
      dispatching = false;
    }
  };
  await dispatchPending();
  const dispatchTimer = setInterval(() => {
    void track(dispatchPending()).catch((error) =>
      logEvent("storage.dispatch_failed", {
        message: error instanceof Error ? error.message : "Unknown error",
      }),
    );
  }, 30000);
  dispatchTimer.unref();
  const finalizeCall = async (sid: string) => {
    await registry.flush();
    await traces.flush();
    const call = await calls.get(sid);
    if (call)
      await artifacts.enqueue(sid, `final-v${call.storageRevision ?? 0}`, 5000);
  };
  const startRecording = async (sid: string) => {
    if (!env.RECORDING_ENABLED) return;
    const requests = db.collection<{ _id: string; state: string }>(
      "recording_requests",
    );
    const claim = await requests.updateOne(
      { _id: sid },
      { $setOnInsert: { state: "starting" } },
      { upsert: true },
    );
    if (!claim.upsertedCount) return;
    try {
      await twilioClient(twilioSettings.current())
        .calls(sid)
        .recordings.create({
          recordingChannels: "dual",
          recordingStatusCallback: `${env.PUBLIC_BASE_URL}/twilio/recording-status`,
          recordingStatusCallbackEvent: ["completed"],
        });
      await requests.updateOne({ _id: sid }, { $set: { state: "started" } });
    } catch (error) {
      await requests.updateOne({ _id: sid }, { $set: { state: "failed" } });
      throw error;
    }
  };

  const meetings = new MeetingService({
    store: new MeetingStore(join(env.DATA_DIR, "meetings.json")),
    agents: store,
    tools,
    engine,
    drivers: () => new GoogleMeetBrowserDriver(),
    avatars: createLiveAvatar,
    traces: new TraceStore(),
  });
  const deps: HttpDeps = {
    store,
    registry,
    tools,
    pool,
    traces,
    contexts,
    telephony,
    listVoices: listElevenLabsVoices,
    pendingCalls: 0,
    warmTransfers,
    twilioSettings,
    phoneNumbers,
    calls,
    objects,
    callState,
    finalizeCall,
    serverEvents: serverEvents.outbox,
    meetings,
    retryStorage: async (sid) => {
      const call = await calls.get(sid);
      if (
        !(await artifacts.retryFailed(
          sid,
          `final-v${call?.storageRevision ?? 0}`,
        ))
      )
        await artifacts.enqueue(sid, `manual-${Date.now()}`);
    },
    recordingReady: (sid, recordingSid) =>
      artifacts.enqueue(sid, `recording-${recordingSid}`),
  };
  startupStage = "HTTP listeners";
  const api = await createApiV1({
    orgId: env.WORKSPACE_USER_ID,
    db,
    redis,
    callState,
    calls,
    tools,
    objects,
    telephony,
    twilioSettings,
    phoneNumbers,
    registry,
    traces,
    contexts,
  });
  const publicServer = createServer(createRootApp(api, createPublicApp(deps)));
  const media = attachMediaServer(publicServer, {
    factory: (init) =>
      init.purpose === "warm-consultation"
        ? createConsultationSession(init, engine, warmTransfers)
        : new StandardSession(init, engine),
    onResumed: (id, sid) => warmTransfers.resumed(id, sid),
    pool,
    registry,
    traces,
    contexts,
    callState,
    maxConcurrentCalls: env.MAX_CONCURRENT_CALLS,
    onStarted: (sid) => track(startRecording(sid)),
  });
  publicServer.listen(env.PORT, "127.0.0.1", () =>
    logEvent("server.public_listening", { port: env.PORT }),
  );
  void api.dispatcher.start().catch((error) => logEvent("callqueue.start_failed", errorDetail(error)));
  const adminApp = createAdminApp(deps, {
    router: createAuthRouter(authStore, env.AUTH_API_SECRET),
    requireUser: requireUser(authStore, env.WORKSPACE_USER_ID),
  });
  adminApp.get("/metrics", (_req, res) => {
    void metrics.render().then((body) => res.type("text/plain; version=0.0.4").send(body));
  });
  const admin = adminApp.listen(env.ADMIN_PORT, env.ADMIN_HOST, () =>
    logEvent("server.admin_listening", { port: env.ADMIN_PORT }),
  );
  await Promise.all([publicServer, admin].map(server => server.listening ? Promise.resolve() : new Promise<void>(resolve => server.once("listening", resolve))));
  process.send?.({ type: "ready", public: (publicServer.address() as { port: number }).port, admin: (admin.address() as { port: number }).port });
  logEvent("configuration", {
    calling_ready: !missingCallConfiguration(twilioSettings.current()).length,
    missing: missingCallConfiguration(twilioSettings.current()).join(", "),
  });
  logEvent("server.endpoints", {
    publicBaseUrl: env.PUBLIC_BASE_URL || "(not set)",
    inbound: `${env.PUBLIC_BASE_URL}/twilio/voice/inbound`,
    media: `${env.PUBLIC_BASE_URL.replace(/^https/, "wss")}/media`,
    storage: "mongodb/redis/s3",
  });
  void track(warmTransfers.recoverAfterRestart()).catch((error) =>
    logEvent("transfer.recovery_failed", {
      message: error instanceof Error ? error.message : "Unknown error",
    }),
  );
  const workspaceBusy = async () => {
    const [webhooksPending, queued, pending] = await Promise.all([
      serverEvents.outbox.pending(),
      db.collection("call_requests").findOne({ phase: { $in: ["queued", "scheduled", "dialing"] } }),
      db.collection("calls").findOne({ $or: [{ storagePending: true }, { status: { $nin: ["completed", "failed"] } }] }),
    ]);
    return webhooksPending || !!queued || !!pending || background.size > 0 || registry.activeCount > 0 || deps.pendingCalls > 0 || pool.size > 0 || meetings.list().some(m => !["ended", "failed", "needs-login"].includes(m.phase));
  };
  const activityTimer = setInterval(() => {
    void workspaceBusy().then(busy => process.send?.({ type: "activity", busy })).catch(() => {});
  }, 10_000);
  activityTimer.unref();
  let shutdownTask: Promise<void> | undefined;
  const shutdown = (): Promise<void> =>
    (shutdownTask ??= (async () => {
      clearInterval(dispatchTimer);
      clearInterval(activityTimer);
      await api.dispatcher.stop();
      // Stop admitting requests first, then allow accepted callbacks and socket close
      // handlers to finish before draining their writes and closing storage clients.
      const closeHttp = (server: typeof publicServer) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeIdleConnections();
        });
      const publicClosed = closeHttp(publicServer);
      const adminClosed = closeHttp(admin);
      await meetings.shutdown();
      warmTransfers.shutdown();
      pool.closeAll();
      for (const client of media.clients) client.terminate();
      const mediaClosed = new Promise<void>((resolve, reject) => {
        media.close((error) => (error ? reject(error) : resolve()));
      });
      await Promise.all([publicClosed, adminClosed, mediaClosed]);
      await Promise.allSettled([...background]);
      // Aborted model streams record their partial usage in promise finalizers.
      await new Promise<void>((resolve) => setImmediate(resolve));
      await warmTransfers.flush();
      await registry.flush();
      await traces.flush();
      await artifacts.close();
      await serverEvents.close();
      // Worker completion can race the first drain and emit additional trace data.
      await registry.flush();
      await traces.flush();
      await redis.quit();
      await mongo.close();
      objects.close();
    })());
  process.on("message", (message: { type?: string }) => {
    if (message.type === "stop-if-idle") void workspaceBusy().then(async busy => {
      if (!busy) { await shutdown(); process.exit(0); }
    }).catch(() => {});
  });
  process.once("disconnect", () => void shutdown().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void shutdown().then(() => process.exit(0), () => process.exit(1)));
  process.once("SIGINT", () => void shutdown().then(() => process.exit(0), () => process.exit(1)));
}
void main().catch((error) => {
  console.error(
    "storage.startup_failed",
    { stage: startupStage, ...errorDetail(error), httpStatus: error?.$metadata?.httpStatusCode ?? null },
  );
  process.exit(1);
});

import type Redis from "ioredis";
import type { Db } from "mongodb";
import express, { type Express, type Router } from "express";
import { env, missingCallConfiguration } from "../../../lib/env";
import { CallDispatcher, type Readiness } from "../../calls/dispatcher";
import { CallLauncher } from "../../calls/launcher";
import type { Telephony } from "../../core/ports";
import type { TraceStore } from "../../observability/trace";
import type { TwilioSettings } from "../../providers/twilio-settings";
import type { MongoCallRepository } from "../../storage/calls";
import { CallQueue } from "../../storage/call-queue";
import type { MongoToolRegistry } from "../../storage/config";
import type { ObjectStore } from "../../storage/objects";
import type { RedisCallState } from "../../storage/redis";
import type { CallRegistry } from "../../store/calls";
import type { ContextStore } from "../../store/contexts";
import { ApiKeyDirectory } from "./auth/key-directory";
import { ApiKeyStore } from "./auth/api-keys";
import { CallRequestRepository } from "./repositories/call-requests";
import { AssistantApiRepository, PhoneNumberApiRepository, ToolApiRepository } from "./repositories/resources";
import { createApiRouter } from "./routes";
import { CallService } from "./services/calls";
import { PhoneNumberService } from "./services/phone-numbers";

export interface ApiV1Dependencies {
  db: Db;
  authDb?: Db;
  redis: Redis;
  callState: RedisCallState;
  calls: MongoCallRepository;
  tools: MongoToolRegistry;
  objects: ObjectStore;
  telephony: Telephony;
  twilioSettings: TwilioSettings;
  phoneNumbers?: import("../../phone-numbers/service").PhoneNumbers;
  registry: CallRegistry;
  traces: TraceStore;
  contexts: ContextStore;
  orgId?: string;
}

export interface ApiV1 {
  router: Router;
  dispatcher: CallDispatcher;
  keys: ApiKeyStore;
  mount(app: Express): void;
}

const LEASE_TTL_MS = 600_000;

export const createApiV1 = async (deps: ApiV1Dependencies): Promise<ApiV1> => {
  const orgId = deps.orgId ?? "default";
  const keys = new ApiKeyStore(deps.db, orgId, deps.authDb ? new ApiKeyDirectory(deps.authDb) : undefined);
  const requests = new CallRequestRepository(deps.db, orgId);
  const assistants = new AssistantApiRepository(deps.db, orgId);
  const toolListing = new ToolApiRepository(deps.db, orgId);
  const phoneNumbers = new PhoneNumberApiRepository(deps.db, orgId);
  await Promise.all([
    keys.initialize(),
    requests.initialize(),
    assistants.initialize(),
    toolListing.initialize(),
    phoneNumbers.initialize(),
  ]);

  const queue = new CallQueue(deps.redis, `${env.REDIS_PREFIX}:{calls}`);
  const readiness = (): Readiness => {
    if (deps.twilioSettings.isUpdating) return { state: "updating" };
    const missing = missingCallConfiguration(deps.twilioSettings.current());
    return missing.length ? { state: "misconfigured", message: missing.join(", ") } : { state: "ready" };
  };
  const launcher = new CallLauncher({
    telephony: deps.telephony,
    contexts: deps.contexts,
    registry: deps.registry,
    traces: deps.traces,
    calls: deps.calls,
  });
  const dispatcher = new CallDispatcher({
    queue,
    requests,
    launcher,
    callState: deps.callState,
    calls: deps.calls,
    subscriber: deps.redis.duplicate({ enableOfflineQueue: true, maxRetriesPerRequest: null }),
    readiness,
    options: {
      concurrencyLimit: env.MAX_CONCURRENT_CALLS,
      dispatchesPerMinute: env.CALLS_PER_MINUTE,
      pollMs: env.DISPATCH_POLL_MS,
      parallelism: env.DIAL_PARALLELISM,
      maxAttempts: env.CALL_START_MAX_ATTEMPTS,
      leaseTtlMs: LEASE_TTL_MS,
    },
  });
  const accountSid = (): string | undefined => deps.twilioSettings.current().accountSid || undefined;
  const calls = new CallService({
    orgId,
    baseUrl: env.PUBLIC_BASE_URL,
    requests,
    assistants,
    phoneNumbers,
    tools: deps.tools,
    calls: deps.calls,
    objects: deps.objects,
    queue,
    dispatcher: () => dispatcher,
    readiness,
    defaultFrom: env.TWILIO_PHONE_NUMBER,
    accountSid,
  });
  const router = createApiRouter({
    keys,
    callState: deps.callState,
    assistants,
    calls,
    tools: { registry: deps.tools, listing: toolListing, assistants, orgId },
    phoneNumbers: {
      numbers: phoneNumbers,
      accountSid,
      service: new PhoneNumberService({ numbers: phoneNumbers, assistants, telephony: deps.telephony, accountSid, management: deps.phoneNumbers }),
    },
  });
  return {
    router,
    dispatcher,
    keys,
    mount: (app) => {
      if (env.TRUST_PROXY_HOPS > 0) app.set("trust proxy", env.TRUST_PROXY_HOPS);
      app.disable("x-powered-by");
      app.use(router);
    },
  };
};

export const createRootApp = (api: ApiV1, publicApp: Express): Express => {
  const root = express();
  api.mount(root);
  root.use(publicApp);
  return root;
};

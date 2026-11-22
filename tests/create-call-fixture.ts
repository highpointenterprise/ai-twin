import { randomUUID } from "node:crypto";
import type { Db } from "mongodb";
import Redis from "ioredis";
import express from "express";
import { env } from "../lib/env";
import { phoneFixture, phoneCredentials } from "./phone-number-fixture";
import { createApiV1, createRootApp } from "../server/api/v1";
import { MongoCallRepository } from "../server/storage/calls";
import { RedisCallState } from "../server/storage/redis";
import { ObjectStore } from "../server/storage/objects";
import { CallRegistry } from "../server/store/calls";
import { keyManagementRoutes } from "../server/api/v1/routes/key-management";
import { createAdminApp } from "../server/http/routes";
import { createAuthRouter, requireUser } from "../server/auth/routes";
import type { AuthStore } from "../server/auth/store";
export async function createCallFixture(
  db: Db,
  authDb: Db,
  owner: string,
  auth: AuthStore,
  secret: string,
) {
  const phone = await phoneFixture(
    db,
    owner,
    `https://calls.example/workspaces/${owner}`,
  );
  await phone.settings.connect(phoneCredentials, () => false);
  const numbers = await phone.management.list();
  const redis = new Redis(process.env.TEST_REDIS_URL!);
  const connections: Redis[] = [redis];
  const duplicate = redis.duplicate.bind(redis);
  redis.duplicate = (...args) => {
    const result = duplicate(...args);
    connections.push(result);
    return result;
  };
  const prefix = `call-api-${randomUUID()}`;
  const savedPrefix = env.REDIS_PREFIX;
  env.REDIS_PREFIX = prefix;
  const calls = new MongoCallRepository(db);
  await calls.initialize();
  const objects = new ObjectStore({
    endpoint: "http://127.0.0.1:1",
    region: "us-east-1",
    bucket: "test",
    accessKeyId: "test",
    secretAccessKey: "test",
  });
  const placed: { to: string; from: string; url: string }[] = [];
  const telephony = {
    ...phone.telephony,
    placeCall: async (input: { to: string; from: string; url: string }) => {
      placed.push(input);
      return `CA${randomUUID().replaceAll("-", "")}`;
    },
  };
  const registry = new CallRegistry(undefined, calls);
  const api = await createApiV1({
    db,
    authDb,
    orgId: owner,
    redis,
    calls,
    objects,
    tools: phone.deps
      .tools as import("../server/storage/config").MongoToolRegistry,
    callState: new RedisCallState(redis, `${prefix}:{calls}`),
    registry,
    traces: phone.deps.traces,
    contexts: phone.deps.contexts,
    telephony,
    twilioSettings: phone.settings,
    phoneNumbers: phone.management,
  });
  env.REDIS_PREFIX = savedPrefix;
  const publicServer = createRootApp(api, express()).listen(0, "127.0.0.1");
  const adminServer = createAdminApp(
    {
      ...phone.deps,
      apiKeysRouter: keyManagementRoutes(
        api.keys,
        owner,
        "https://calls.example",
      ),
    },
    {
      router: createAuthRouter(auth, secret),
      requireUser: requireUser(auth, owner),
    },
  ).listen(0, "127.0.0.1");
  await Promise.all(
    [publicServer, adminServer].map(
      (s) => new Promise<void>((resolve) => s.once("listening", resolve)),
    ),
  );
  return {
    api,
    phone,
    numbers,
    placed,
    calls,
    ports: {
      public: (publicServer.address() as { port: number }).port,
      admin: (adminServer.address() as { port: number }).port,
    },
    close: async () => {
      await api.dispatcher.stop();
      publicServer.closeAllConnections();
      adminServer.closeAllConnections();
      await Promise.all(
        [publicServer, adminServer].map(
          (s) => new Promise<void>((resolve) => s.close(() => resolve())),
        ),
      );
      await phone.deps.traces.flush();
      await registry.flush();
      const keys = await redis.keys(`${prefix}:*`);
      if (keys.length) await redis.del(...keys);
      await Promise.all(connections.map((r) => r.quit()));
      objects.close();
    },
  };
}

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { MongoClient } from "mongodb";
import { env } from "../lib/env";
import { AuthStore } from "../server/auth/store";
import { ApiKeyDirectory } from "../server/api/v1/auth/key-directory";
import { ApiKeyStore } from "../server/api/v1/auth/api-keys";
import { createWorkspaceGateway } from "../server/workspaces/gateway";
import { createCallFixture } from "./create-call-fixture";
import { until } from "./helpers";

test(
  "root call API and key management enforce per-user authentication, lifecycle and request contracts",
  {
    skip: !process.env.TEST_MONGODB_URI || !process.env.TEST_REDIS_URL,
    timeout: 60_000,
  },
  async (t) => {
    const saved = { ...env };
    Object.assign(env, {
      PUBLIC_BASE_URL: "https://calls.example",
      OPENAI_API_KEY: "test",
      ELEVENLABS_API_KEY: "test",
      DEEPGRAM_API_KEY: "test",
      STREAM_SECRET: "test-signing-secret-with-at-least-32-characters",
    });
    const client = await new MongoClient(
      process.env.TEST_MONGODB_URI!,
    ).connect();
    const name = `create_api_${randomUUID().replaceAll("-", "")}`,
      db = client.db(name),
      dbA = client.db(`${name}_a`),
      dbB = client.db(`${name}_b`);
    const auth = new AuthStore(db);
    await auth.initialize();
    const owners = await Promise.all(
      ["a", "b"].map((n) =>
        auth.signup({
          name: n,
          email: `${n}@example.com`,
          password: "test password long",
        }),
      ),
    );
    const sessions = await Promise.all(
      owners.map((u) => auth.login(u.email, "test password long")),
    );
    const secret = randomBytes(32).toString("hex");
    const a = await createCallFixture(dbA, db, owners[0].id, auth, secret),
      b = await createCallFixture(dbB, db, owners[1].id, auth, secret);
    const directory = new ApiKeyDirectory(db);
    const gateway = createWorkspaceGateway(
      auth,
      secret,
      {
        get: async (id) => {
          const entry =
            id === owners[0].id ? a : id === owners[1].id ? b : undefined;
          if (!entry) throw new Error("Unknown workspace");
          return entry.ports;
        },
      },
      directory,
    );
    const publicServer = gateway.publicApp.listen(0, "127.0.0.1"),
      admin = gateway.admin.listen(0, "127.0.0.1");
    await Promise.all(
      [publicServer, admin].map(
        (s) => new Promise<void>((resolve) => s.once("listening", resolve)),
      ),
    );
    const url = `http://127.0.0.1:${(publicServer.address() as { port: number }).port}`,
      adminUrl = `http://127.0.0.1:${(admin.address() as { port: number }).port}`;
    t.after(async () => {
      publicServer.closeAllConnections();
      admin.closeAllConnections();
      publicServer.close();
      admin.close();
      await a.close();
      await b.close();
      await Promise.all([db, dbA, dbB].map((d) => d.dropDatabase()));
      await client.close();
      Object.assign(env, saved);
    });
    const manage = (who: number, path = "", method = "GET", body?: unknown) =>
      fetch(`${adminUrl}/api/api-keys${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${sessions[who]!.token}`,
          "Content-Type": "application/json",
          "x-user-id": owners[1 - who].id,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    assert.equal((await fetch(`${adminUrl}/api/api-keys`)).status, 401);
    assert.equal((await manage(0, "", "POST", { name: "  " })).status, 400);
    const created = await manage(0, "", "POST", { name: "Production" });
    assert.equal(created.status, 201);
    const keyA = await created.json(),
      keyB = await (await manage(1, "", "POST", { name: "B" })).json();
    assert.match(keyA.key, /^twk_/);
    const listing = await (await manage(0)).json();
    assert.equal(listing.userId, owners[0].id);
    assert.equal(listing.apiBaseUrl, "https://calls.example");
    assert.equal(listing.keys.length, 1);
    assert.equal(listing.keys[0].hash, undefined);
    assert.equal(listing.keys[0].key, undefined);
    assert.equal((await manage(1, `/${keyA.id}`, "DELETE")).status, 404);
    assert.equal(
      (await manage(1, `/${keyA.id}`, "PATCH", { name: "Stolen" })).status,
      404,
    );
    assert.equal(
      (await manage(0, `/${keyA.id}`, "PATCH", { name: "Renamed" })).status,
      200,
    );
    assert.equal(
      await new ApiKeyStore(dbA, owners[1].id).verify(keyA.key),
      undefined,
    );
    const request = (
      key: string | undefined,
      path: string,
      method = "GET",
      body?: unknown,
      extra: Record<string, string> = {},
    ) =>
      fetch(url + path, {
        method,
        headers: {
          ...(key ? { Authorization: `Bearer ${key}` } : {}),
          "Content-Type": "application/json",
          "x-user-id": owners[1].id,
          ...extra,
        },
        ...(body === undefined
          ? {}
          : { body: typeof body === "string" ? body : JSON.stringify(body) }),
      });
    const payload = {
      assistantId: a.phone.assistant.id,
      phoneNumberId: a.numbers[0].id,
      customer: {
        number: "+14155550199",
        name: "Customer",
        email: "caller@example.com",
        externalId: "crm-1",
      },
    };
    assert.ok(payload.phoneNumberId);
    for (const key of [undefined, "invalid", sessions[0]!.token]) {
      const response = await request(key, "/call", "POST", payload);
      assert.equal(response.status, 401);
      assert.equal((await response.json()).statusCode, 401);
    }
    for (const invalid of [
      { ...payload, assistantId: b.phone.assistant.id },
      { ...payload, phoneNumberId: b.numbers[0].id },
      { ...payload, assistant: {} },
      { ...payload, customers: [payload.customer] },
      { ...payload, customer: { number: "123" } },
      {
        ...payload,
        customer: { number: "+14155550199", numberE164CheckEnabled: false },
      },
      { ...payload, squadId: randomUUID() },
      {
        ...payload,
        schedulePlan: {
          earliestAt: "2030-02-01T00:00:00Z",
          latestAt: "2030-01-01T00:00:00Z",
        },
      },
    ]) {
      const response = await request(keyA.key, "/call", "POST", invalid);
      assert.equal(response.status, 400, JSON.stringify(invalid));
      const error = await response.json();
      assert.equal(error.statusCode, 400);
      assert.ok(error.message);
    }
    assert.equal(
      (await request(keyA.key, "/call", "POST", "{bad")).status,
      400,
    );
    assert.equal(
      (
        await request(keyA.key, "/call", "POST", "{}", {
          "Content-Type": "text/plain",
        })
      ).status,
      415,
    );
    const result = await request(keyA.key, "/call", "POST", payload, {
      "Idempotency-Key": "one-call-only",
    });
    assert.equal(result.status, 201);
    const call = await result.json();
    assert.equal(call.orgId, owners[0].id);
    assert.equal(call.status, "queued");
    assert.equal(call.type, "outboundPhoneCall");
    assert.equal(call.assistantId, payload.assistantId);
    assert.equal(call.phoneNumberId, payload.phoneNumberId);
    assert.deepEqual(call.customer, payload.customer);
    assert.ok(call.createdAt);
    assert.ok(call.updatedAt);
    const replay = await (
      await request(keyA.key, "/call", "POST", payload, {
        "Idempotency-Key": "one-call-only",
      })
    ).json();
    assert.equal(replay.id, call.id);
    assert.equal(await dbA.collection("call_requests").countDocuments(), 1);
    assert.equal(
      (
        await request(
          keyA.key,
          "/call",
          "POST",
          { ...payload, customer: { number: "+14155550200" } },
          { "Idempotency-Key": "one-call-only" },
        )
      ).status,
      409,
    );
    assert.equal((await request(keyB.key, `/call/${call.id}`)).status, 404);
    assert.equal(
      (await request(keyA.key, `/workspaces/${owners[1].id}/call`)).status,
      401,
    );
    await a.api.dispatcher.start();
    await until(() => a.placed.length === 1);
    assert.equal(a.placed[0].from, a.numbers[0].phoneNumber);
    assert.equal(a.placed[0].to, payload.customer.number);
    await a.api.dispatcher.stop();
    const scheduled = await (
      await request(keyA.key, "/call", "POST", {
        ...payload,
        schedulePlan: { earliestAt: "2030-01-01T00:00:00Z" },
        assistantOverrides: {
          firstMessage: "Hi {{contact}}",
          variableValues: { contact: "default" },
        },
        customer: {
          ...payload.customer,
          assistantOverrides: { variableValues: { contact: "Alice" } },
        },
      })
    ).json();
    assert.equal(scheduled.status, "scheduled");
    assert.equal(
      (await dbA.collection("call_requests").findOne({ id: scheduled.id }))
        ?.agent.firstMessage,
      "Hi Alice",
    );
    const batch = await (
      await request(keyA.key, "/call", "POST", {
        assistantId: payload.assistantId,
        phoneNumberId: payload.phoneNumberId,
        customers: [
          payload.customer,
          {
            number: "+14155550200",
            assistantOverrides: {
              model: {
                provider: "openai",
                model: "gpt-4.1",
                toolIds: [randomUUID()],
              },
            },
          },
        ],
      })
    ).json();
    assert.equal(batch.results.length, 1);
    assert.equal(batch.errors.length, 1);
    assert.deepEqual(Object.keys(batch.errors[0]).sort(), [
      "customer",
      "error",
    ]);
    assert.ok(batch.subscriptionLimits);
    const inline = await request(keyA.key, "/call", "POST", {
      phoneNumberId: payload.phoneNumberId,
      assistant: {
        name: "Inline",
        voice: { provider: "11labs", voiceId: "voice-id" },
        model: {
          provider: "openai",
          model: "gpt-4.1",
          messages: [{ role: "system", content: "Help the caller." }],
        },
      },
      customer: payload.customer,
      transport: { provider: "twilio", conversationType: "voice" },
    });
    assert.equal(inline.status, 201);
    assert.equal((await inline.json()).assistant.name, "Inline");
    const legacyStore = new ApiKeyStore(dbB, owners[1].id),
      legacy = await legacyStore.issue("Existing key");
    assert.equal(await directory.owner(legacy.key), undefined);
    await new ApiKeyStore(dbB, owners[1].id, directory).initialize();
    assert.equal(await directory.owner(legacy.key), owners[1].id);
    assert.equal((await request(legacy.key, "/call")).status, 200);
    await legacyStore.revoke(legacy.id);
    assert.equal(
      (await request(legacy.key, "/call")).status,
      401,
      "stale directory entries must not authorize revoked workspace keys",
    );
    const limited = await (
      await manage(1, "", "POST", { name: "Rate test" })
    ).json();
    const rateLimit = env.API_RATE_LIMIT_PER_MINUTE;
    env.API_RATE_LIMIT_PER_MINUTE = 1;
    try {
      assert.equal((await request(limited.key, "/call")).status, 200);
      const throttled = await request(limited.key, "/call");
      assert.equal(throttled.status, 429);
      assert.ok(throttled.headers.get("retry-after"));
    } finally {
      env.API_RATE_LIMIT_PER_MINUTE = rateLimit;
    }
    const independent = new ApiKeyStore(dbA, owners[0].id);
    assert.ok(await independent.verify(keyA.key));
    assert.equal((await manage(0, `/${keyA.id}`, "DELETE")).status, 204);
    assert.equal(
      await independent.verify(keyA.key),
      undefined,
      "another instance must reject a revoked key immediately",
    );
    assert.equal(await directory.owner(keyA.key), undefined);
    assert.equal(
      (await request(keyA.key, "/call", "POST", payload)).status,
      401,
    );
    assert.equal((await request(keyB.key, "/call")).status, 200);
  },
);

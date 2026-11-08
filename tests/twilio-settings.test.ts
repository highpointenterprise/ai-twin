import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import twilio from "twilio";
import { env } from "../lib/env";
import type { TwilioCredentials, TwilioConnectionResult } from "../lib/twilio";
import { TwilioCredentialStore } from "../server/store/twilio-credentials";
import { TwilioSettings } from "../server/providers/twilio-settings";
import {
  createTwilioTelephony,
  createTwilioWarmTelephony,
} from "../server/providers/twilio";
import {
  createAdminApp,
  createPublicApp,
  type HttpDeps,
} from "../server/http/routes";
import { AgentStore } from "../server/store/agents";
import { CallRegistry } from "../server/store/calls";
import { ContextStore } from "../server/store/contexts";
import { TraceStore } from "../server/observability/trace";
import { SessionPool } from "../server/engine/pool";
import { ToolRegistry } from "../server/tools/registry";
import { agent, telephony, until } from "./helpers";

const first: TwilioCredentials = {
  accountSid: "AC" + "1".repeat(32),
  authToken: "2".repeat(32),
};
const second: TwilioCredentials = {
  accountSid: "AC" + "3".repeat(32),
  authToken: "4".repeat(32),
};
const number = {
  sid: "PN-test",
  phoneNumber: "+14155550100",
  label: "Support",
};
function setup(
  t: TestContext,
  verify: ConstructorParameters<typeof TwilioSettings>[1] = async () => [
    number,
  ],
) {
  const previous = { ...env };
  Object.assign(env, {
    TWILIO_ACCOUNT_SID: "",
    TWILIO_AUTH_TOKEN: "",
    TWILIO_PHONE_NUMBER: undefined,
    OPENAI_API_KEY: "",
    DEEPGRAM_API_KEY: "",
    ELEVENLABS_API_KEY: "",
    PUBLIC_BASE_URL: "https://calls.example.com",
    STREAM_SECRET: "test-only-stream-token-at-least-32-characters",
  });
  const directory = mkdtempSync(join(tmpdir(), "twilio-settings-"));
  t.after(() => {
    Object.assign(env, previous);
    rmSync(directory, { recursive: true, force: true });
  });
  const store = new TwilioCredentialStore(directory),
    settings = new TwilioSettings(store, verify);
  const phone = telephony();
  phone.listNumbers = async () => [number];
  phone.validateWebhook = createTwilioTelephony(
    settings.current,
  ).validateWebhook;
  const d: HttpDeps = {
    store: new AgentStore(agent()),
    registry: new CallRegistry(),
    contexts: new ContextStore(),
    traces: new TraceStore(),
    pool: new SessionPool(10),
    tools: new ToolRegistry(),
    telephony: phone,
    listVoices: async () => [],
    pendingCalls: 0,
    twilioSettings: settings,
  };
  return { directory, store, settings, d };
}
async function serve(t: TestContext, d: HttpDeps, publicOnly = false) {
  const server = (publicOnly ? createPublicApp(d) : createAdminApp(d)).listen(
    0,
    "127.0.0.1",
  );
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    connect: (credentials: unknown, headers: Record<string, string> = {}) =>
      fetch(url + "/api/integrations/twilio", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(credentials),
      }),
  };
}
function enableCalling() {
  Object.assign(env, {
    OPENAI_API_KEY: "test-only",
    DEEPGRAM_API_KEY: "test-only",
    ELEVENLABS_API_KEY: "test-only",
  });
}

test("saved Twilio credentials are encrypted, private, and usable after process restart", async (t) => {
  const f = setup(t);
  await f.settings.connect(first, () => false);
  const ciphertext = readFileSync(
    join(f.directory, "twilio-credentials.enc.json"),
    "utf8",
  );
  assert.ok(!ciphertext.includes(first.authToken));
  assert.ok(!ciphertext.includes(first.accountSid));
  for (const file of readdirSync(f.directory))
    assert.equal(statSync(join(f.directory, file)).mode & 0o777, 0o600);
  const restarted = new TwilioSettings(
    new TwilioCredentialStore(f.directory),
    async () => [number],
  );
  assert.deepEqual(restarted.current(), first);
  assert.equal(restarted.status().source, "workspace");
  assert.ok(!JSON.stringify(restarted.status()).includes(first.authToken));
  const copy = restarted.current();
  copy.authToken = "changed";
  assert.deepEqual(restarted.current(), first);
  writeFileSync(join(f.directory, ".credentials.key"), Buffer.alloc(32, 9));
  assert.throws(
    () => new TwilioCredentialStore(f.directory).load(),
    /matching encryption key/,
  );
});

test("frontend connection verifies before saving, returns numbers, and updates readiness without AI credentials", async (t) => {
  let verified = 0;
  const f = setup(t, async (c) => {
    verified++;
    assert.deepEqual(c, first);
    return [number];
  });
  const http = await serve(t, f.d);
  assert.equal((await fetch(http.url + "/api/numbers")).status, 503);
  const response = await http.connect(first);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const text = await response.text();
  assert.ok(!text.includes(first.authToken));
  const result = JSON.parse(text) as TwilioConnectionResult;
  assert.equal(result.connection.configured, true);
  assert.equal(result.numbers[0].phoneNumber, number.phoneNumber);
  assert.equal(result.numbers[0].agentId, null);
  assert.ok(!result.missing.some((s) => s.startsWith("TWILIO")));
  assert.ok(result.missing.includes("OPENAI_API_KEY"));
  assert.equal((await fetch(http.url + "/api/numbers")).status, 200);
  assert.equal(verified, 1);
  const health = await (await fetch(http.url + "/api/health")).text();
  assert.ok(!health.includes(first.authToken));
  assert.equal(JSON.parse(health).twilio.source, "workspace");
  assert.equal(JSON.parse(health).callingReady, false);
});

test("bad credentials and malformed input preserve the previous connection and never echo provider errors", async (t) => {
  const f = setup(t, async (c) => {
    if (c.accountSid === second.accountSid)
      throw Object.assign(
        new Error(`Provider error containing ${c.authToken}`),
        { status: 401, code: 20003 },
      );
    return [number];
  });
  const http = await serve(t, f.d);
  await http.connect(first);
  const response = await http.connect(second);
  assert.equal(response.status, 401);
  const body = await response.text();
  assert.ok(!body.includes(second.authToken));
  assert.match(body, /rejected these credentials/);
  assert.deepEqual(f.settings.current(), first);
  assert.equal(
    (await http.connect({ ...second, authToken: "bad" })).status,
    400,
  );
  const restarted = new TwilioSettings(
    new TwilioCredentialStore(f.directory),
    async () => [],
  );
  assert.deepEqual(restarted.current(), first);
});

test("failed verification does not write secrets or replace environment configuration", async (t) => {
  const f = setup(t, async () => {
    throw new Error(`Network error ${first.authToken}`);
  });
  Object.assign(env, {
    TWILIO_ACCOUNT_SID: second.accountSid,
    TWILIO_AUTH_TOKEN: second.authToken,
  });
  await assert.rejects(
    () => f.settings.connect(first, () => false),
    /Could not connect to Twilio/,
  );
  assert.deepEqual(f.settings.current(), second);
  assert.equal(f.settings.status().source, "environment");
  assert.deepEqual(readdirSync(f.directory), []);
});

test("connection credentials use the admin API only and reject foreign origins", async (t) => {
  let verified = 0;
  const f = setup(t, async () => {
      verified++;
      return [number];
    }),
    admin = await serve(t, f.d),
    publicHttp = await serve(t, f.d, true);
  assert.equal(
    (await admin.connect(first, { Origin: "https://unrelated.example" }))
      .status,
    403,
  );
  assert.equal((await publicHttp.connect(first)).status, 404);
  assert.equal(verified, 0);
  assert.deepEqual(readdirSync(f.directory), []);
});

test("credential verification excludes simultaneous connections and new inbound/outbound calls", async (t) => {
  let release!: (n: (typeof number)[]) => void;
  const f = setup(
      t,
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    ),
    http = await serve(t, f.d),
    publicHttp = await serve(t, f.d, true);
  f.d.store.assign(number.phoneNumber, f.d.store.list()[0].id);
  f.d.telephony.validateWebhook = () => true;
  const pending = http.connect(first);
  await until(() => f.settings.isUpdating);
  assert.equal((await http.connect(second)).status, 409);
  const call = await fetch(http.url + "/api/calls", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      agentId: f.d.store.list()[0].id,
      to: "+14155550123",
      from: number.phoneNumber,
    }),
  });
  assert.equal(call.status, 409);
  const inbound = await fetch(publicHttp.url + "/twilio/voice/inbound", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      CallSid: "CA-blocked",
      From: "+14155550123",
      To: number.phoneNumber,
    }),
  });
  assert.doesNotMatch(await inbound.text(), /Stream/);
  assert.equal(f.d.registry.activeCount, 0);
  release([number]);
  assert.equal((await pending).status, 200);
  assert.equal(f.settings.isUpdating, false);
});

test("active calls and pending number assignments prevent credential replacement", async (t) => {
  const f = setup(t),
    http = await serve(t, f.d);
  await http.connect(first);
  f.d.registry.create({
    sid: "CA-active",
    agentId: f.d.store.list()[0].id,
    from: number.phoneNumber,
    to: "+14155550123",
    direction: "outbound",
    status: "in-progress",
  });
  assert.equal((await http.connect(second)).status, 409);
  assert.deepEqual(f.settings.current(), first);
  f.d.registry.update("CA-active", "completed");
  f.d.pendingCalls++;
  assert.equal((await http.connect(second)).status, 409);
  f.d.pendingCalls--;
  assert.equal((await http.connect(second)).status, 200);
});

test("saved token validates Twilio callbacks immediately and account changes retire the old token", async (t) => {
  const f = setup(t);
  await f.settings.connect(first, () => false);
  const body = { CallSid: "CA-test", CallStatus: "completed" },
    url = "https://calls.example.com/twilio/status";
  const old = twilio.getExpectedTwilioSignature(first.authToken, url, body);
  assert.equal(f.d.telephony.validateWebhook(url, body, old), true);
  await f.settings.connect(second, () => false);
  assert.equal(f.d.telephony.validateWebhook(url, body, old), false);
  assert.equal(
    f.d.telephony.validateWebhook(
      url,
      body,
      twilio.getExpectedTwilioSignature(second.authToken, url, body),
    ),
    true,
  );
});

test("inbound assignment and outbound calls use the connected account; stale caller IDs are rejected", async (t) => {
  const f = setup(t),
    http = await serve(t, f.d);
  await http.connect(first);
  enableCalling();
  const a = f.d.store.list()[0];
  let assigned = 0,
    placed = 0;
  f.d.telephony.routeInbound = async (sid, url) => {
    assert.equal(sid, number.sid);
    assert.match(url, /voice\/inbound$/);
    assigned++;
  };
  const assignment = await fetch(
    http.url + `/api/numbers/${number.sid}/assign`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: a.id }),
    },
  );
  assert.equal(assignment.status, 200);
  assert.equal(assigned, 1);
  f.d.telephony.placeCall = async (call) => {
    placed++;
    assert.equal(call.from, number.phoneNumber);
    return "CA-placed";
  };
  const request = () =>
    fetch(http.url + "/api/calls", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: a.id, to: "+14155550123" }),
    });
  assert.equal((await request()).status, 201);
  assert.equal(placed, 1);
  f.d.registry.update("CA-placed", "completed");
  await http.connect(second);
  f.d.telephony.listNumbers = async () => [
    { ...number, phoneNumber: "+14155550199" },
  ];
  assert.equal((await request()).status, 400);
  assert.equal(placed, 1);
});

test("both normal and warm Twilio adapters read current credentials for each operation", async (t) => {
  const f = setup(t);
  await f.settings.connect(first, () => false);
  const used: string[] = [];
  const calls = Object.assign(
    (_sid: string) => ({
      update: async () => ({}),
      fetch: async () => ({ status: "in-progress" }),
    }),
    { create: async () => ({ sid: "CA-created" }) },
  );
  const makeClient = (c: TwilioCredentials) => {
    used.push(c.accountSid);
    return {
      incomingPhoneNumbers: {
        list: async () => [
          {
            sid: number.sid,
            phoneNumber: number.phoneNumber,
            friendlyName: number.label,
          },
        ],
      },
      calls,
    } as unknown as twilio.Twilio;
  };
  const normal = createTwilioTelephony(f.settings.current, makeClient),
    warm = createTwilioWarmTelephony(f.settings.current, makeClient);
  await normal.listNumbers();
  await warm.dialOperator({
    to: "+14155550123",
    from: number.phoneNumber,
    url: "https://calls.example.com/operator",
    statusUrl: "https://calls.example.com/status",
    timeoutSeconds: 30,
  });
  await f.settings.connect(second, () => false);
  await normal.endCall("CA-call");
  await warm.callStatus("CA-call");
  assert.deepEqual(used, [
    first.accountSid,
    first.accountSid,
    second.accountSid,
    second.accountSid,
  ]);
});

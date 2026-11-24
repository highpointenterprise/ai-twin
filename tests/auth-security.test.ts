import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { authFixture } from "./auth-fixture";
import { digest, seal, totp, totpStep, unseal } from "../server/auth/crypto";
import { AuthMailQueue } from "../server/auth/mail";
import { ApiKeyStore } from "../server/api/v1/auth/api-keys";
import { ApiKeyDirectory } from "../server/api/v1/auth/key-directory";
import type { AuthSession } from "../lib/auth";
import { limitedBody } from "../lib/request-body";

test("TOTP matches RFC vectors and authenticated encryption rejects tampering", () => {
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  assert.equal(totp(secret, 1), "287082");
  assert.equal(totpStep(secret, totp(secret, Math.floor(Date.now() / 30000))), Math.floor(Date.now() / 30000));
  const key = randomBytes(32).toString("hex"), blob = seal("private", key, "user1");
  assert.equal(unseal(blob, key, "user1"), "private");
  assert.throws(() => unseal(blob, key, "user2"));
  const altered = Buffer.from(blob, "base64url"); altered[20] ^= 1;
  assert.throws(() => unseal(altered.toString("base64url"), key, "user1"));
});

test("request size limits apply to streamed bodies without a content-length", async () => {
  const body = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(4097)); c.close(); } });
  await assert.rejects(limitedBody(new Request("http://localhost", { method: "POST", body, duplex: "half" } as RequestInit)), /BodyTooLarge/);
});

test("account security, recovery, MFA, and tenant boundaries", { skip: !process.env.TEST_MONGODB_URI, timeout: 120000 }, async t => {
  const f = await authFixture(); t.after(f.close);
  const post = (action: string, data: unknown) => fetch(`${f.url}/api/v1/auth/${action}`, { method: "POST", headers: { "content-type": "application/json", "x-auth-client-secret": f.clientSecret }, body: JSON.stringify(data) });
  const account = (s: AuthSession, path = "", method = "GET", data?: unknown) => fetch(`${f.url}/api/v1/auth/account${path}`, { method, headers: { authorization: `Bearer ${s.token}`, "content-type": "application/json" }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const password = "A very strong test password";
  async function create(email: string) {
    assert.equal((await post("signup", { name: "User", email, password })).status, 202);
    const token = f.mail.at(-1)!.token;
    assert.equal((await post("verify-email", { token })).status, 200);
    const response = await post("login", { email, password }); assert.equal(response.status, 200); return await response.json() as AuthSession;
  }
  await t.test("sessions and profile mutations are scoped to the authenticated user", async () => {
    const a = await create("a@example.com"), b = await create("b@example.com");
    const second: AuthSession = await (await post("login", { email: a.user.email, password })).json();
    const aData = await (await account(a)).json(), bData = await (await account(b)).json();
    assert.equal(aData.sessions.length, 2);
    assert.equal(JSON.stringify(aData).includes(a.token), false);
    assert.equal((await account(a, `/sessions/${bData.sessions[0].id}`, "DELETE")).status, 404);
    const changed = await account(a, "/profile", "PATCH", { name: "Updated", userId: b.user.id });
    assert.equal((await changed.json()).user.id, a.user.id);
    assert.equal((await f.store.userForSession(b.token))?.name, "User");
    assert.equal((await account(a, "/sessions/revoke-others", "POST", {})).status, 204);
    assert.equal(await f.store.userForSession(second.token), null);
    assert.ok(await f.store.userForSession(a.token));
    await f.db.collection("user_sessions").updateMany({ userId: a.user.id }, { $set: { lastSeenAt: new Date(0) } });
    assert.equal((await account(a)).status, 401);
    await f.db.collection("users").updateOne({ email: b.user.email }, { $set: { disabledAt: new Date() } });
    assert.equal((await account(b)).status, 401);
  });
  await t.test("reset is purpose-bound, single use, and invalidates sessions and API keys", async () => {
    const a = await create("reset@example.com"), directory = new ApiKeyDirectory(f.db), keys = new ApiKeyStore(f.db, a.user.id, directory);
    await keys.initialize(); const key = await keys.issue("old"); assert.ok(await keys.verify(key.key));
    const known = await post("forgot-password", { email: a.user.email }), unknown = await post("forgot-password", { email: "absent@example.com" });
    assert.equal(known.status, 202); assert.deepEqual(await known.json(), await unknown.json());
    const token = f.mail.at(-1)!.token;
    const saved = await f.db.collection("users").findOne({ email: a.user.email });
    assert.equal(saved!.reset.hash, digest(token)); assert.equal(JSON.stringify(saved).includes(token), false);
    assert.equal((await post("verify-email", { token })).status, 400);
    const password2 = "A new strong test password";
    const results = await Promise.all([post("reset-password", { token, password: password2 }), post("reset-password", { token, password: password2 })]);
    assert.deepEqual(results.map(r => r.status).sort(), [200, 400]);
    assert.equal(await f.store.userForSession(a.token), null);
    assert.equal(await keys.verify(key.key), undefined); assert.equal(await directory.owner(key.key), undefined);
    await keys.initialize(); assert.equal(await keys.verify(key.key), undefined);
    assert.equal((await keys.list()).keys[0].invalidated, true);
    const fresh = await keys.issue("new"); assert.ok(await keys.verify(fresh.key));
    assert.equal((await post("login", { email: a.user.email, password })).status, 401);
    assert.equal((await post("login", { email: a.user.email, password: password2 })).status, 200);
  });
  await t.test("superseded and expired links fail closed", async () => {
    const a = await create("expired@example.com");
    await post("forgot-password", { email: a.user.email }); const old = f.mail.at(-1)!.token;
    await post("forgot-password", { email: a.user.email }); const latest = f.mail.at(-1)!.token;
    assert.equal((await post("reset-password", { token: old, password })).status, 400);
    await f.db.collection("users").updateOne({ email: a.user.email }, { $set: { "reset.expiresAt": new Date(0) } });
    assert.equal((await post("reset-password", { token: latest, password })).status, 400);
  });
  await t.test("email changes require current credentials and verification of the new address", async () => {
    const a = await create("change@example.com");
    assert.equal((await account(a, "/email", "POST", { email: "new@example.com", currentPassword: "wrong" })).status, 401);
    assert.equal((await account(a, "/email", "POST", { email: "new@example.com", currentPassword: password })).status, 202);
    assert.equal((await f.store.userForSession(a.token))?.email, a.user.email);
    const mail = f.mail.at(-1)!; assert.equal(mail.email, "new@example.com");
    assert.equal((await post("confirm-email", { token: mail.token })).status, 200);
    assert.equal((await post("confirm-email", { token: mail.token })).status, 400);
    assert.equal(await f.store.userForSession(a.token), null);
    assert.equal((await post("login", { email: "new@example.com", password })).status, 200);
  });
  await t.test("MFA secrets stay encrypted, OTP and recovery replay fail, resets preserve MFA", async () => {
    const a = await create("mfa@example.com");
    const setup = await account(a, "/mfa/setup", "POST", { currentPassword: password }); assert.equal(setup.status, 200);
    const { secret } = await setup.json();
    assert.equal(JSON.stringify(await f.db.collection("users").findOne({ email: a.user.email })).includes(secret), false);
    const code = totp(secret, Math.floor(Date.now() / 30000));
    const enabled = await account(a, "/mfa/enable", "POST", { code }); assert.equal(enabled.status, 200);
    const { recoveryCodes } = await enabled.json(); assert.equal(recoveryCodes.length, 10);
    assert.equal(await f.store.userForSession(a.token), null);
    assert.equal((await (await post("login", { email: a.user.email, password })).json()).code, "MfaRequired");
    assert.equal((await (await post("login", { email: a.user.email, password, code })).json()).code, "MfaInvalid");
    const races = await Promise.all([post("login", { email: a.user.email, password, code: recoveryCodes[0] }), post("login", { email: a.user.email, password, code: recoveryCodes[0] })]);
    assert.deepEqual(races.map(r => r.status).sort(), [200, 401]);
    await post("forgot-password", { email: a.user.email }); const token = f.mail.at(-1)!.token;
    assert.equal((await post("reset-password", { token, password })).status, 200);
    assert.equal((await (await post("login", { email: a.user.email, password })).json()).code, "MfaRequired");
    const next: AuthSession = await (await post("login", { email: a.user.email, password, code: recoveryCodes[1] })).json();
    assert.equal((await account(next, "/mfa/disable", "POST", { currentPassword: password, code: recoveryCodes[2] })).status, 200);
    assert.equal((await post("login", { email: a.user.email, password })).status, 200);
    const events = await f.store.activity(a.user.id);
    assert.ok(events.some(e => e.action === "mfa.enabled"));
    assert.equal(JSON.stringify(events).includes(secret), false);
    assert.equal(JSON.stringify(events).includes(recoveryCodes[0]), false);
  });
  await t.test("password changes enforce proof and revoke the old session", async () => {
    const a = await create("password@example.com");
    assert.equal((await account(a, "/password", "POST", { currentPassword: "wrong", password })).status, 401);
    assert.equal((await account(a, "/password", "POST", { currentPassword: password, password: "A different long password" })).status, 200);
    assert.equal((await account(a)).status, 401);
  });
});

test("encrypted email outbox retries, leases, and erases delivered tokens", { skip: !process.env.TEST_MONGODB_URI }, async t => {
  const f = await authFixture(); t.after(f.close);
  const options = { from: "accounts@example.com", appUrl: "https://app.example.com", region: "us-east-2", encryptionKey: randomBytes(32).toString("hex") };
  let attempts = 0, delivered = "";
  const queue = new AuthMailQueue(f.db, options, async (email, _subject, body) => { attempts++; if (attempts === 1) throw new Error("provider error"); delivered = `${email} ${body}`; });
  t.after(() => queue.close()); await queue.initialize();
  const token = randomBytes(32).toString("base64url");
  await queue.enqueue({ email: "user@example.com", token, action: "reset" });
  const raw = JSON.stringify(await f.db.collection("auth_mail_outbox").findOne({}));
  assert.equal(raw.includes(token), false); assert.equal(raw.includes("user@example.com"), false);
  await queue.drain(); assert.equal(attempts, 1);
  await f.db.collection("auth_mail_outbox").updateMany({}, { $set: { dueAt: new Date(0) } });
  await Promise.all([queue.drain(), queue.drain()]); assert.equal(attempts, 2);
  assert.ok(delivered.includes(`https://app.example.com/reset-password#token=${token}`));
  const job = await f.db.collection("auth_mail_outbox").findOne({}); assert.equal(job!.state, "sent"); assert.equal(job!.encrypted, undefined);
  assert.throws(() => new AuthMailQueue(f.db, { ...options, appUrl: "http://evil.example" }));
});

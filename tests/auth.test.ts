import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { hashPassword, verifyPassword } from "../server/auth/password";
import { AuthStore } from "../server/auth/store";
import type { AuthSession } from "../lib/auth";
import { authFixture } from "./auth-fixture";

test("passwords use independent salts and reject incorrect or missing hashes", async () => {
  const password = "a long test password";
  const first = await hashPassword(password);
  const second = await hashPassword(password);
  assert.notEqual(first, second);
  assert.equal(await verifyPassword(password, first), true);
  assert.equal(await verifyPassword("incorrect", first), false);
  assert.equal(await verifyPassword(password), false);
  assert.equal(await verifyPassword(password, "malformed"), false);
  assert.equal(first.includes(password), false);
});

test("authentication API with durable MongoDB sessions", { skip: !process.env.TEST_MONGODB_URI }, async (t) => {
  const fixture = await authFixture();
  t.after(fixture.close);
  const { url, db, clientSecret } = fixture;
  const post = (path: string, body: unknown, secret = clientSecret) => fetch(`${url}/api/v1/auth/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-auth-client-secret": secret },
    body: JSON.stringify(body),
  });
  const input = { name: "Test User", email: "USER@Example.com", password: "A secure test password" };
  let session: AuthSession;

  await t.test("dashboard endpoints reject missing and forged sessions before returning data", async () => {
    for (const path of ["/api/agents", "/api/health", "/api/settings/twilio", "/api/calls", "/api/v1/auth/session"]) {
      const response = await fetch(url + path);
      assert.equal(response.status, 401);
      assert.equal(response.headers.get("cache-control"), "no-store");
    }
    assert.equal((await fetch(url + "/api/agents", { headers: { Authorization: `Bearer ${"a".repeat(43)}` } })).status, 401);
    assert.equal((await post("signup", input, "wrong-client-secret")).status, 401);
    assert.equal((await fetch(url + "/health")).status, 200);
  });

  await t.test("signup validates input and stores only a normalized email and password hash", async () => {
    assert.equal((await post("signup", { ...input, password: "short" })).status, 400);
    assert.equal((await post("signup", { ...input, email: "invalid" })).status, 400);
    assert.equal((await post("signup", { ...input, name: " " })).status, 400);
    assert.equal((await post("signup", { ...input, email: { $ne: null } })).status, 400);
    const response = await post("signup", input);
    assert.equal(response.status, 201);
    const { user } = await response.json();
    assert.equal(user.email, "user@example.com");
    assert.deepEqual(Object.keys(user).sort(), ["email", "id", "name"]);
    const stored = await db.collection("users").findOne({ email: user.email });
    assert.match(stored!.passwordHash, /^scrypt\$/);
    assert.equal(JSON.stringify(stored).includes(input.password), false);
  });

  await t.test("duplicate emails including case variants are rejected atomically", async () => {
    assert.equal((await post("signup", { ...input, email: " user@example.com " })).status, 409);
    const attempts = await Promise.all([post("signup", { ...input, email: "race@example.com" }), post("signup", { ...input, email: "RACE@example.com" })]);
    assert.deepEqual(attempts.map((r) => r.status).sort(), [201, 409]);
  });

  await t.test("login returns generic errors and an opaque session for correct credentials", async () => {
    const badPassword = await post("login", { email: input.email, password: "wrong password" });
    const unknownUser = await post("login", { email: "unknown@example.com", password: input.password });
    assert.equal(badPassword.status, 401);
    assert.equal(unknownUser.status, 401);
    assert.deepEqual(await badPassword.json(), await unknownUser.json());
    const response = await post("login", input);
    assert.equal(response.status, 200);
    session = await response.json();
    assert.equal(session.user.email, "user@example.com");
    assert.match(session.token, /^[A-Za-z0-9_-]{43}$/);
    const saved = await db.collection("user_sessions").findOne({ userId: session.user.id });
    assert.equal(String(saved!._id), createHash("sha256").update(session.token).digest("hex"));
    assert.equal(JSON.stringify(saved).includes(session.token), false);
    const headers = { Authorization: `Bearer ${session.token}` };
    assert.equal((await fetch(url + "/api/agents", { headers })).status, 200);
    assert.deepEqual((await (await fetch(url + "/api/v1/auth/session", { headers })).json()).user, session.user);
    assert.deepEqual(await new AuthStore(db).userForSession(session.token), session.user);
  });

  await t.test("revocation and expiry block previously valid sessions", async () => {
    const headers = { Authorization: `Bearer ${session.token}` };
    assert.equal((await fetch(url + "/api/v1/auth/session", { method: "DELETE", headers })).status, 204);
    assert.equal((await fetch(url + "/api/agents", { headers })).status, 401);
    const next: AuthSession = await (await post("login", input)).json();
    await db.collection("user_sessions").updateOne({ userId: next.user.id }, { $set: { expiresAt: new Date(0) } });
    assert.equal((await fetch(url + "/api/agents", { headers: { Authorization: `Bearer ${next.token}` } })).status, 401);
  });

  await t.test("rate limits persist across service instances and return retry timing", async () => {
    for (let i = 0; i < 10; i++) assert.equal((await post("login", { email: "limited@example.com", password: "incorrect" })).status, 401);
    const denied = await post("login", { email: "limited@example.com", password: "incorrect" });
    assert.equal(denied.status, 429);
    assert.ok(Number(denied.headers.get("retry-after")) > 0);
    const anotherInstance = new AuthStore(db);
    assert.equal((await anotherInstance.allowAttempt("login:email:limited@example.com", 10, 15 * 60_000)).allowed, false);
  });

  await t.test("malformed and oversized requests do not expose backend internals", async () => {
    for (const [body, status] of [["{", 400], [JSON.stringify({ value: "x".repeat(5000) }), 413]] as const) {
      const response = await fetch(url + "/api/v1/auth/signup", { method: "POST", headers: { "Content-Type": "application/json", "x-auth-client-secret": clientSecret }, body });
      assert.equal(response.status, status);
      assert.deepEqual(Object.keys(await response.json()), ["error"]);
    }
  });
});

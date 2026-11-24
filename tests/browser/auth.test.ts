import { finishSignup } from "./auth-helpers";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { authFixture } from "../auth-fixture";

test("login and signup across a separate Next.js frontend and Mongo-backed API", {
  skip: !process.env.TEST_MONGODB_URI,
  timeout: 120_000,
}, async (t) => {
  const fixture = await authFixture();
  t.after(fixture.close);
  const reservation = createServer().listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => reservation.once("listening", resolve));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const base = `http://127.0.0.1:${port}`;
  let logs = "";
  const web = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    env: {
      ...process.env,
      NODE_ENV: "production",
      NEXTAUTH_URL: base,
      NEXTAUTH_SECRET: randomBytes(32).toString("hex"),
      AUTH_API_SECRET: fixture.clientSecret,
      BACKEND_API_URL: fixture.url,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  web.stdout.on("data", (chunk) => { logs += String(chunk); });
  web.stderr.on("data", (chunk) => { logs += String(chunk); });
  t.after(async () => {
    if (web.exitCode !== null) return;
    const exited = new Promise<void>((resolve) => web.once("exit", () => resolve()));
    web.kill("SIGTERM");
    await exited;
  });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (web.exitCode !== null) throw new Error(logs);
    try { if ((await fetch(`${base}/login`)).ok) { ready = true; break; } } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, logs);
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined),
    headless: true,
    args: ["--no-sandbox"],
  });
  t.after(() => browser.close());
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.setDefaultNavigationTimeout(10_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const email = "browser@example.com";
  const password = "Browser test password!";

  await t.test("dashboard, gateway, and legacy API paths cannot bypass authentication", async () => {
    await page.goto(`${base}/dashboard`);
    assert.equal(new URL(page.url()).pathname, "/login");
    assert.equal((await context.request.get(`${base}/api/backend/agents`)).status(), 401);
    assert.equal((await context.request.get(`${base}/api/agents`)).status(), 404);
    assert.equal((await context.request.post(`${base}/api/signup`, { data: { name: "Bad", email, password }, headers: { origin: "https://foreign.example" } })).status(), 403);
    await page.goto(base);
    assert.equal(new URL(page.url()).pathname, "/login");
  });

  await t.test("signup works on mobile and enters the protected dashboard", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("link", { name: "Create an account" }).click();
    await page.getByLabel("Full name").fill("Browser User");
    await page.getByLabel("Email address").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByLabel("Confirm password").fill("Does not match");
    await page.getByRole("button", { name: "Create account", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "Your passwords do not match." }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.getByLabel("Confirm password").fill(password);
    await page.getByRole("button", { name: "Create account", exact: true }).click();
    try {
      await finishSignup(page, base, fixture, password);
      await page.getByRole("button", { name: "Log out", exact: true }).waitFor();
    } catch (error) {
      throw new Error(`Signup did not reach the dashboard: ${page.url()}\n${await page.locator("body").innerText()}\nBrowser errors: ${errors.join("; ")}\n${logs}`, { cause: error });
    }
    assert.equal((await context.request.get(`${base}/api/backend/agents`)).status(), 200);
    const session = await (await context.request.get(`${base}/api/auth/session`)).json();
    assert.equal(session.user.email, email);
    assert.equal(JSON.stringify(session).includes("backendToken"), false);
    assert.equal(JSON.stringify(session).includes(password), false);
    const cookie = (await context.cookies()).find((cookie) => cookie.name === "next-auth.session-token");
    assert.ok(cookie?.httpOnly);
    assert.equal(cookie.sameSite, "Lax");
    const sessionsBeforeForgery = await fixture.db.collection("user_sessions").countDocuments();
    await context.request.post(`${base}/api/auth/callback/credentials`, {
      form: { email, password, callbackUrl: "/dashboard" },
      maxRedirects: 0,
    });
    assert.equal(await fixture.db.collection("user_sessions").countDocuments(), sessionsBeforeForgery);
    await page.reload();
    await page.getByRole("button", { name: "Log out", exact: true }).waitFor();
    await page.goto(`${base}/login`);
    assert.equal(new URL(page.url()).pathname, "/dashboard");
    assert.equal((await context.request.post(`${base}/api/backend/agents`, { data: {}, headers: { origin: "https://foreign.example" } })).status(), 403);
    assert.equal((await context.request.post(`${base}/api/backend/agents`, {
      data: { name: "Gateway test", systemPrompt: "Test assistant." },
      headers: { origin: base },
    })).status(), 201);
  });

  assert.equal(await page.getByRole("button", { name: "Log out", exact: true }).count(), 1, "Signup must complete before testing logout.");

  await t.test("logout revokes backend access even if the old encrypted cookie is replayed", async () => {
    const cookies = await context.cookies();
    await page.getByRole("button", { name: "Log out", exact: true }).click();
    await page.waitForURL(`${base}/login`);
    assert.equal((await context.request.get(`${base}/api/backend/agents`)).status(), 401);
    const replay = await browser.newContext();
    await replay.addCookies(cookies);
    assert.equal((await replay.request.get(`${base}/api/backend/agents`)).status(), 401);
    const response = await replay.request.get(`${base}/dashboard`, { maxRedirects: 0 });
    assert.equal(response.status(), 307);
    assert.equal(response.headers().location, "/login");
    await replay.close();
  });

  await t.test("duplicate signup and incorrect login show useful errors", async () => {
    await page.goto(`${base}/signup`);
    await page.getByLabel("Full name").fill("Duplicate User");
    await page.getByLabel("Email address").fill(email.toUpperCase());
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByLabel("Confirm password").fill(password);
    await page.getByRole("button", { name: "Create account", exact: true }).click();
    await page.waitForURL(`${base}/login?registered=1`);
    await page.getByRole("heading", { name: "Welcome back" }).waitFor();
    await page.getByLabel("Email address").fill(email);
    await page.getByLabel("Password", { exact: true }).fill("An incorrect password");
    await page.getByRole("button", { name: "Log in", exact: true }).click();
    try {
      await page.getByRole("alert").filter({ hasText: "Invalid email or password." }).waitFor();
    } catch (error) {
      throw new Error(`Login error state: ${await page.locator("body").innerText()}\n${logs}`, { cause: error });
    }
  });

  await t.test("login restores access and expired backend sessions return to login", async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByLabel("Email address").fill(email.toUpperCase());
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Log in", exact: true }).click();
    await page.waitForURL(`${base}/dashboard`);
    await page.getByRole("button", { name: "Log out", exact: true }).waitFor();
    await fixture.db.collection("user_sessions").updateMany({}, { $set: { expiresAt: new Date(0) } });
    assert.equal((await context.request.get(`${base}/api/backend/agents`)).status(), 401);
    const expired = await context.newPage();
    await expired.goto(`${base}/dashboard`);
    assert.equal(new URL(expired.url()).pathname, "/login");
    await expired.close();
    assert.equal(errors.length, 0, errors.join("\n"));
    assert.equal(logs.includes(password), false);
  });
});

import { finishSignup } from "./auth-helpers";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { authFixture } from "../auth-fixture";
import { phoneFixture, phoneCredentials } from "../phone-number-fixture";
import { ApiKeyStore } from "../../server/api/v1/auth/api-keys";
import { keyManagementRoutes } from "../../server/api/v1/routes/key-management";

test(
  "dashboard exposes copyable IDs, creates and revokes keys, and builds the root call example",
  { skip: !process.env.TEST_MONGODB_URI, timeout: 120_000 },
  async (t) => {
    let phone!: Awaited<ReturnType<typeof phoneFixture>>;
    const fixture = await authFixture(async (db) => {
      phone = await phoneFixture(
        db,
        "browser-key-owner",
        "https://calls.example/workspaces/browser-key-owner",
      );
      await phone.settings.connect(phoneCredentials, () => false);
      await phone.management.list();
      const keys = new ApiKeyStore(db, "browser-key-owner");
      await keys.initialize();
      return {
        ...phone.deps,
        apiKeysRouter: keyManagementRoutes(
          keys,
          "browser-key-owner",
          "https://calls.example",
        ),
      };
    });
    t.after(fixture.close);
    const reservation = createServer().listen(0, "127.0.0.1");
    await new Promise<void>((resolve) =>
      reservation.once("listening", resolve),
    );
    const port = (reservation.address() as { port: number }).port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    const base = `http://127.0.0.1:${port}`;
    let logs = "";
    const web = spawn(
      process.execPath,
      [
        "node_modules/next/dist/bin/next",
        "start",
        "--hostname",
        "127.0.0.1",
        "--port",
        String(port),
      ],
      {
        env: {
          ...process.env,
          NODE_ENV: "production",
          NEXTAUTH_URL: base,
          NEXTAUTH_SECRET: randomBytes(32).toString("hex"),
          AUTH_API_SECRET: fixture.clientSecret,
          BACKEND_API_URL: fixture.url,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    web.stdout.on("data", (chunk) => {
      logs += String(chunk);
    });
    web.stderr.on("data", (chunk) => {
      logs += String(chunk);
    });
    t.after(async () => {
      if (web.exitCode !== null) return;
      const exited = new Promise<void>((resolve) =>
        web.once("exit", () => resolve()),
      );
      web.kill("SIGTERM");
      await exited;
    });
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (web.exitCode !== null) throw new Error(logs);
      try {
        if ((await fetch(`${base}/login`)).ok) {
          ready = true;
          break;
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(ready, logs);
    const browser = await chromium.launch({
      executablePath:
        process.env.CHROMIUM_EXECUTABLE_PATH ||
        (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined),
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
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.goto(`${base}/signup`);
    await page.getByLabel("Full name").fill("Phone Owner");
    await page.getByLabel("Email address").fill("phones@example.com");
    await page
      .getByLabel("Password", { exact: true })
      .fill("Phone test password!");
    await page.getByLabel("Confirm password").fill("Phone test password!");
    await page
      .getByRole("button", { name: "Create account", exact: true })
      .click();
    await finishSignup(page, base, fixture, "Phone test password!");

    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page
      .getByRole("button", { name: "Copy Assistant ID", exact: true })
      .click();
    assert.equal(
      await page.evaluate(() => navigator.clipboard.readText()),
      phone.assistant.id,
    );
    await page
      .getByRole("button", { name: "Phone numbers", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Copy Phone Number ID", exact: true })
      .click();
    const phoneId = await page.evaluate(() => navigator.clipboard.readText());
    assert.match(phoneId, /^[a-f0-9-]{36}$/);
    await page.getByRole("button", { name: "API keys", exact: true }).click();
    await page.getByText("No API keys yet.", { exact: true }).waitFor();
    await page
      .getByRole("button", { name: "Copy Workspace / User ID", exact: true })
      .last()
      .click();
    assert.match(
      await page.evaluate(() => navigator.clipboard.readText()),
      /^[a-f0-9-]{36}$/,
    );
    await page.getByLabel("New key name").fill("Production");
    await page.getByRole("button", { name: "Generate API key" }).click();
    await page.getByRole("button", { name: "Copy New API key" }).click();
    const issued = await page.evaluate(() => navigator.clipboard.readText());
    assert.match(issued, /^twk_/);
    await page.getByRole("button", { name: "Copy Create Call cURL" }).click();
    const curl = await page.evaluate(() => navigator.clipboard.readText());
    assert.ok(curl.includes("https://calls.example/call"));
    assert.ok(curl.includes(phone.assistant.id));
    assert.ok(curl.includes(phoneId));
    assert.ok(!curl.includes(issued), "examples never embed private keys");
    await page.getByRole("button", { name: "Dismiss key" }).click();
    assert.equal(await page.getByText(issued, { exact: true }).count(), 0);
    await page.getByLabel("Key name", { exact: true }).fill("Renamed");
    await page.getByRole("button", { name: "Save name", exact: true }).click();
    await page.getByRole("article", { name: "API key Renamed" }).waitFor();
    await page.reload();
    await page.getByRole("button", { name: "API keys", exact: true }).click();
    await page.getByRole("article", { name: "API key Renamed" }).waitFor();
    assert.equal(await page.getByText(issued, { exact: true }).count(), 0);
    await page.getByRole("button", { name: "Revoke key", exact: true }).click();
    await page
      .getByRole("button", { name: "Confirm revoke", exact: true })
      .click();
    await page.getByText(/Ending in .*Revoked/).waitFor();
    assert.equal(
      await new ApiKeyStore(fixture.db, "browser-key-owner").verify(issued),
      undefined,
    );
    assert.deepEqual(errors, []);
  },
);

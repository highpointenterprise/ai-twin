import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { authFixture } from "../auth-fixture";
import {
  phoneFixture,
  phoneCredentials,
  existingPhone,
  buyPhone,
} from "../phone-number-fixture";

test(
  "phone numbers connect, purchase, rename, assign, and unassign through the authenticated frontend",
  {
    skip: !process.env.TEST_MONGODB_URI,
    timeout: 120_000,
  },
  async (t) => {
    let phone!: Awaited<ReturnType<typeof phoneFixture>>;
    const fixture = await authFixture(async (db) => {
      phone = await phoneFixture(
        db,
        "phone-browser-owner",
        "https://calls.example/workspaces/phone-browser-owner",
      );
      return phone.deps;
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
    await page.waitForURL(`${base}/dashboard`);
    await page
      .getByRole("button", { name: "Phone numbers", exact: true })
      .click();
    await page
      .getByLabel("Twilio Account SID")
      .fill(phoneCredentials.accountSid);
    await page.getByLabel("Twilio Auth Token").fill("9".repeat(32));
    await page.getByRole("button", { name: "Connect & load numbers" }).click();
    await page
      .getByRole("alert")
      .filter({ hasText: "Twilio rejected" })
      .waitFor();
    assert.equal(
      new URL(page.url()).pathname,
      "/dashboard",
      "bad provider credentials must not log the user out",
    );
    await page.getByLabel("Twilio Auth Token").fill(phoneCredentials.authToken);
    await page.getByRole("button", { name: "Connect & load numbers" }).click();
    await page
      .getByRole("heading", { name: "Your Twilio numbers (1)" })
      .waitFor();
    assert.equal(await page.getByLabel("Twilio Auth Token").inputValue(), "");
    const old = page
      .getByRole("article")
      .filter({
        has: page.getByRole("heading", {
          name: existingPhone.phone_number,
          exact: true,
        }),
      });
    await old.getByLabel("Number name").fill("Sales line");
    await old.getByRole("button", { name: "Save name" }).click();
    await page.waitForFunction(() =>
      [...document.querySelectorAll("input")].some(
        (el) => el.value === "Sales line",
      ),
    );
    await old.getByRole("combobox").selectOption(phone.assistant.id);
    await old.getByText("Inbound route ready", { exact: true }).waitFor();
    await page
      .getByRole("button", { name: "Search available numbers" })
      .click();
    await page
      .getByRole("button", { name: `Select ${buyPhone}`, exact: true })
      .click();
    await page
      .getByRole("heading", { name: `Confirm purchase: ${buyPhone}` })
      .waitFor();
    assert.equal(
      phone.fake.purchases,
      0,
      "selecting a number cannot charge the account",
    );
    await page
      .getByRole("button", { name: "Confirm purchase", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "Your Twilio numbers (2)" })
      .waitFor();
    const purchased = page
      .getByRole("article")
      .filter({
        has: page.getByRole("heading", { name: buyPhone, exact: true }),
      });
    await purchased.getByRole("combobox").selectOption(phone.assistant.id);
    await purchased.getByText("Inbound route ready", { exact: true }).waitFor();
    await page.reload();
    await page
      .getByRole("button", { name: "Phone numbers", exact: true })
      .click();
    await purchased.getByText("Inbound route ready", { exact: true }).waitFor();
    assert.equal(
      await purchased.getByRole("combobox").inputValue(),
      phone.assistant.id,
    );
    await purchased.getByRole("combobox").selectOption("");
    await purchased.getByText("Unassigned", { exact: true }).waitFor();
    assert.equal(await phone.management.inboundAssistant(buyPhone), undefined);
    assert.equal(phone.fake.purchases, 1);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
      true,
    );
    assert.deepEqual(errors, []);
  },
);

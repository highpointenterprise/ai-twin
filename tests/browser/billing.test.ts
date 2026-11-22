import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { authFixture } from "../auth-fixture";
import { billingRoutes } from "../../server/billing/routes";
import { PricingPolicies } from "../../server/billing/policy";

test(
  "authenticated billing dashboard loads isolated usage and saves credit pricing",
  { skip: !process.env.TEST_MONGODB_URI, timeout: 120_000 },
  async (t) => {
    const fixture = await authFixture(async (db) => {
      await db.collection("call_costs").insertMany([
        {
          callId: "mine",
          userId: "billing-owner",
          occurredAt: new Date(),
          cost: {
            durationSec: 120,
            totalUsd: 0.12,
            reportedUsd: 0.04,
            calculatedUsd: 0.05,
            estimatedUsd: 0.03,
            status: "incomplete",
            reconciliationStatus: "pending",
          },
        },
        {
          callId: "foreign",
          userId: "another-owner",
          occurredAt: new Date(),
          cost: { durationSec: 900, totalUsd: 999, reportedUsd: 999 },
        },
      ]);
      return {
        billingRouter: billingRoutes(
          db,
          "billing-owner",
          new PricingPolicies(db),
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
    await page.waitForURL(`${base}/dashboard`);

    await page
      .getByRole("button", { name: "Usage & costs", exact: true })
      .click();
    await page.getByRole("heading", { name: "Pricing & allocation" }).waitFor();
    await page.getByRole("button", { name: "Load usage report" }).click();
    const report = page.getByRole("table", { name: "Usage report" });
    await report.getByText("$0.120000", { exact: true }).waitFor();
    assert.equal(
      await report.getByText("$999.000000", { exact: true }).count(),
      0,
    );
    await page.getByLabel("ElevenLabs USD per credit").fill("0.0002");
    await page.getByLabel("Pricing note").fill("Plan credit conversion");
    await page
      .getByRole("button", { name: "Save pricing", exact: true })
      .click();
    await page
      .getByRole("status")
      .filter({ hasText: "Pricing saved for future calls." })
      .waitFor();
    await page.reload();
    await page
      .getByRole("button", { name: "Usage & costs", exact: true })
      .click();
    await page.getByRole("heading", { name: "Pricing & allocation" }).waitFor();
    assert.equal(
      await page.getByLabel("ElevenLabs USD per credit").inputValue(),
      "0.0002",
    );
    assert.deepEqual(errors, []);
  },
);

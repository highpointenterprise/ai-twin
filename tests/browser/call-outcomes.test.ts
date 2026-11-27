import { finishSignup } from "./auth-helpers";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { authFixture } from "../auth-fixture";
import { MongoCallRepository } from "../../server/storage/calls";
import { CallRegistry } from "../../server/store/calls";
import { AssistantServerEvents } from "../../server/webhooks/service";
import type { ObjectStore } from "../../server/storage/objects";
import { agent } from "../helpers";

test(
  "call history shows readable outcomes and retries failed assistant webhooks",
  { skip: !process.env.TEST_MONGODB_URI, timeout: 120_000 },
  async (t) => {
    const sid = "CA" + "1".repeat(32);
    let service!: AssistantServerEvents;
    const fixture = await authFixture(async (db) => {
      const calls = new MongoCallRepository(db);
      await calls.initialize();
      const assistant = agent({
        server: { url: "https://receiver.example/report", timeoutSeconds: 20 },
      });
      for (const [index, endedReason] of [
        "busy",
        "transfer-no-answer",
        "canceled",
      ].entries()) {
        await calls.create({
          sid: "CA" + String(index + 1).repeat(32),
          agentId: assistant.id,
          assistant,
          from: "+14155550100",
          to: "+14155550101",
          direction: "outbound",
          status: "failed",
          endedReason,
        });
      }
      await db.collection<{ _id: string }>("call_events").insertMany(Array.from({ length: 1205 }, (_, i) => ({
        _id: `${sid}:${String(i).padStart(6, "0")}`, callId: sid, at: 1000 + i,
        event: i === 0 ? "call.very_first_event" : "media.sent", detail: { index: i },
      })));
      service = new AssistantServerEvents({
        db,
        calls,
        userId: "browser-owner",
        baseUrl: "https://calls.example",
        objects: {} as ObjectStore,
        send: async () => 204,
      });
      await service.initialize();
      await service.enqueueEndOfCall(sid);
      await db
        .collection("server_event_deliveries")
        .updateOne(
          { callId: sid },
          {
            $set: {
              state: "failed",
              attempts: 10,
              lastError: "Webhook returned HTTP 503.",
              statusCode: 503,
            },
          },
        );
      return {
        calls,
        registry: new CallRegistry(undefined, calls),
        serverEvents: service.outbox,
      };
    });
    t.after(() => service.close());
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

    await page.getByRole("button", { name: "Calls", exact: true }).click();
    const history = page.getByRole("table");
    await history.getByText("Busy", { exact: true }).waitFor();
    await history.getByText("Transfer failed", { exact: true }).waitFor();
    await history.getByText("Canceled", { exact: true }).waitFor();
    await history
      .getByRole("row")
      .filter({ hasText: "Busy" })
      .getByRole("button", { name: "outbound" })
      .click();
    await page.getByText("customer-busy", { exact: true }).waitFor();
    await page.getByText("Events & tool activity (1205)", { exact: true }).click();
    await page.getByRole("button", { name: /Show 500 earlier events/ }).click();
    await page.getByRole("button", { name: /Show 500 earlier events/ }).click();
    assert.match(await page.getByLabel("Call events", { exact: true }).innerText(), /call.very_first_event/);
    const pendingDownload = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download all logs", exact: true }).click();
    const download = await pendingDownload;
    const stream = await download.createReadStream();
    let downloadedLogs = "";
    for await (const chunk of stream!) downloadedLogs += chunk.toString();
    assert.equal(downloadedLogs.trim().split("\n").length, 1205);
    assert.match(downloadedLogs, /call.very_first_event/);
    const delivery = page.getByRole("region", {
      name: "Server webhook delivery",
    });
    await delivery
      .getByText("Webhook returned HTTP 503.", { exact: true })
      .waitFor();
    await delivery.getByRole("button", { name: "Retry webhook" }).click();
    await delivery.getByRole("status").filter({ hasText: "pending" }).waitFor();
    await service.tick();
    await service.tick();
    await delivery
      .getByRole("status")
      .filter({ hasText: "delivered" })
      .waitFor();
    assert.equal(
      await delivery.getByRole("button", { name: "Retry webhook" }).count(),
      0,
    );
    assert.equal(
      (
        await page.request.post(
          `${base}/api/backend/calls/foreign/server-events/retry`,
          { data: {}, headers: { origin: base } },
        )
      ).status(),
      404,
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await delivery
      .getByRole("status")
      .filter({ hasText: "delivered" })
      .waitFor();
    assert.deepEqual(errors, []);
  },
);

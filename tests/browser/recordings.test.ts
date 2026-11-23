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
import { CallRecordings } from "../../server/recordings/service";
import { ServerEventOutbox } from "../../server/webhooks/outbox";
import { ObjectStore } from "../../server/storage/objects";
import { recordingWav } from "../recording-fixture";
import { twilioClient } from "../../server/providers/twilio";
import { agent } from "../helpers";

test(
  "all four S3 recordings play and seek in the authenticated dashboard",
  {
    skip: !process.env.TEST_MONGODB_URI || !process.env.S3_TEST_ENDPOINT,
    timeout: 120_000,
  },
  async (t) => {
    const sid = "CA" + "1".repeat(32),
      recordingSid = "RE" + "2".repeat(32),
      accountSid = "AC" + "3".repeat(32);
    let objects!: ObjectStore;
    const fixture = await authFixture(async (db) => {
      const calls = new MongoCallRepository(db);
      await calls.initialize();
      objects = new ObjectStore({
        endpoint: process.env.S3_TEST_ENDPOINT!,
        bucket: process.env.S3_TEST_BUCKET!,
        region: "us-east-1",
        forcePathStyle: true,
        accessKeyId: process.env.S3_TEST_ACCESS_KEY_ID!,
        secretAccessKey: process.env.S3_TEST_SECRET_ACCESS_KEY!,
        prefix: `workspaces/${db.databaseName}/`,
      });
      await objects.check();
      const assistant = agent();
      await calls.create({
        sid,
        agentId: assistant.id,
        assistant,
        from: "+14155550100",
        to: "+14155550101",
        direction: "outbound",
        status: "completed",
        endedReason: "customer-ended-call",
      });
      const recordings = new CallRecordings({
        db,
        calls,
        objects,
        enabled: true,
        credentials: async () => ({
          accountSid,
          authToken: "test-token",
          phoneNumber: "",
        }),
        enqueue: async () => {},
        client: (() => ({
          recordings: () => ({
            fetch: async () => ({
              callSid: sid,
              accountSid,
              status: "completed",
              duration: "2",
            }),
          }),
        })) as unknown as typeof twilioClient,
        request: (async () =>
          new Response(new Uint8Array(recordingWav()))) as typeof fetch,
      });
      await recordings.initialize();
      await recordings.process(sid, recordingSid);
      const outbox = new ServerEventOutbox(db, "browser-recording-owner");
      await outbox.initialize();
      return {
        calls,
        registry: new CallRegistry(undefined, calls),
        objects,
        recordings,
        serverEvents: outbox,
      };
    });
    t.after(async () => {
      await objects.deletePrefix(`calls/${sid}/`);
      objects.close();
      await fixture.close();
    });
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

    await page.getByRole("button", { name: "Calls", exact: true }).click();
    await page
      .getByRole("table")
      .getByRole("button", { name: "outbound" })
      .click();
    const recordings = page.getByRole("region", { name: "Call recordings" });
    await recordings
      .getByRole("status")
      .filter({ hasText: "completed" })
      .waitFor();
    for (const kind of [
      "monoRecording",
      "recording",
      "assistantRecording",
      "customerRecording",
    ]) {
      await recordings.getByLabel("Audio track").selectOption(kind);
      await page.waitForFunction(() => {
        const audio = document.querySelector(
          'section[aria-label="Call recordings"] audio',
        ) as HTMLAudioElement | null;
        return audio && audio.readyState >= 2;
      });
      const audio = recordings.locator("audio");
      const source = await audio.getAttribute("src");
      assert.ok(source?.startsWith(process.env.S3_TEST_ENDPOINT!));
      assert.equal(
        new URL(source!).searchParams.get("response-content-disposition"),
        "inline",
      );
      const response = await fetch(source!, {
        headers: { Range: "bytes=0-43" },
      });
      assert.equal(response.status, 206);
      assert.equal((await response.arrayBuffer()).byteLength, 44);
      await audio.evaluate(async (element) => {
        const audio = element as HTMLAudioElement;
        audio.currentTime = 0.5;
        await audio.play();
      });
      await page.waitForFunction(() => {
        const audio = document.querySelector(
          'section[aria-label="Call recordings"] audio',
        ) as HTMLAudioElement;
        return audio && !audio.paused && audio.currentTime > 0.5;
      });
      await audio.evaluate((element) => (element as HTMLAudioElement).pause());
    }
    await recordings.getByRole("button", { name: "Reload audio link" }).click();
    await recordings.locator("audio").waitFor();
    assert.equal(
      (
        await page.request.get(
          `${base}/api/backend/calls/foreign/artifacts/recording?play=true`,
        )
      ).status(),
      404,
    );
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await recordings.locator("audio").isVisible());
    assert.deepEqual(errors, []);
  },
);

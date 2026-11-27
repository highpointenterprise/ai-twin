import { finishSignup } from "./auth-helpers";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { authFixture } from "../auth-fixture";

test(
  "assistant workspace persists settings and protects unsaved changes",
  {
    skip: !process.env.TEST_MONGODB_URI,
    timeout: 120_000,
  },
  async (t) => {
    const fixture = await authFixture();
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
    await page.getByLabel("Full name").fill("Assistant Owner");
    await page.getByLabel("Email address").fill("assistants@example.com");
    await page
      .getByLabel("Password", { exact: true })
      .fill("Assistant test password!");
    await page.getByLabel("Confirm password").fill("Assistant test password!");
    await page
      .getByRole("button", { name: "Create account", exact: true })
      .click();
    await finishSignup(page, base, fixture, "Assistant test password!");
    const toolResponse = await context.request.post(
      `${base}/api/backend/tools`,
      {
        headers: { origin: base },
        data: {
          name: "dial_menu",
          description: "Navigate a phone menu",
          type: "dtmf",
        },
      },
    );
    assert.equal(toolResponse.status(), 201, await toolResponse.text());
    const tool = await toolResponse.json();
    await page.reload();
    await page
      .getByRole("button", { name: "+ Create assistant", exact: true })
      .click();
    const drawer = page.getByRole("dialog");

    await t.test(
      "creates an assistant with transcriber, model, voice, tools and advanced settings",
      async () => {
        await page
          .getByLabel("Assistant name", { exact: true })
          .fill("Support specialist");
        await page
          .getByLabel("System prompt", { exact: true })
          .fill(
            "Help customers with their account questions. Use the attached menu tool when needed.",
          );
        await page
          .getByLabel("First message", { exact: true })
          .fill("Hello, how can I help?");
        await page
          .getByRole("button", { name: "Edit transcriber", exact: true })
          .click();
        await drawer
          .getByLabel("Transcription model")
          .selectOption("flux-general-multi");
        await drawer
          .getByLabel("End-of-turn confidence", { exact: true })
          .fill("0.8");
        await drawer.getByLabel("End-of-turn timeout (ms)").fill("4000");
        await drawer.getByLabel("Enable eager turn detection").uncheck();
        await drawer.getByRole("button", { name: "Done", exact: true }).click();
        await page
          .getByRole("button", { name: "Edit model", exact: true })
          .click();
        await drawer
          .getByLabel("Model", { exact: true })
          .fill("openrouter:openai/gpt-4.1");
        await drawer.getByLabel("Temperature", { exact: true }).fill("0.5");
        await page.keyboard.press("Escape");
        assert.equal(
          await page
            .getByRole("button", { name: "Edit model", exact: true })
            .evaluate((el) => el === document.activeElement),
          true,
        );
        await page
          .getByRole("button", { name: "Edit voice", exact: true })
          .click();
        await drawer
          .getByLabel("Voice ID", { exact: true })
          .fill("custom-voice");
        await drawer
          .getByLabel("Voice model", { exact: true })
          .selectOption("eleven_multilingual_v2");
        await drawer.getByLabel("Speed", { exact: true }).fill("1.1");
        await drawer.getByLabel("Style exaggeration", { exact: true }).fill("0.15");
        await drawer.getByLabel("Speaker boost", { exact: true }).check();
        await drawer.getByLabel("Voice model", { exact: true }).selectOption("eleven_v4_turbo");
        await drawer.getByLabel("Voice delivery", { exact: true }).selectOption("warm");
        await drawer.getByLabel("Voice delivery instructions").fill("Calm and natural, with brief goodbyes.");
        assert.equal(await drawer.getByLabel("Speed", { exact: true }).count(), 0);
        await page.route("**/api/backend/voices/preview", route => {
          const body = route.request().postDataJSON();
          assert.equal(body.voiceId, "custom-voice");
          assert.equal(body.voice.model, "eleven_v4_turbo");
          assert.equal(body.voice.delivery, "warm");
          return route.fulfill({ contentType: "audio/wav", body: Buffer.from("RIFF") });
        });
        await drawer.getByRole("button", { name: "Preview voice", exact: true }).click();
        await drawer.getByLabel("Voice preview", { exact: true }).waitFor();
        await page.unroute("**/api/backend/voices/preview");
        await drawer.getByLabel("Voice model", { exact: true }).selectOption("eleven_multilingual_v2");
        if (process.env.DASHBOARD_SCREENSHOTS)
          await page.screenshot({ path: "work/assistants-drawer-desktop.png" });
        await drawer
          .getByRole("button", { name: "Load voice library" })
          .click();
        await drawer
          .getByRole("alert")
          .filter({ hasText: "You can still enter a voice ID above." })
          .waitFor();
        await page.route("**/api/backend/voices", (route) =>
          route.fulfill({
            json: [{ id: "library-voice", name: "Library voice" }],
          }),
        );
        await drawer
          .getByRole("button", { name: "Load voice library" })
          .click();
        await drawer
          .getByLabel("Voice library", { exact: true })
          .selectOption("library-voice");
        assert.equal(
          await drawer.getByLabel("Voice ID", { exact: true }).inputValue(),
          "library-voice",
        );
        await drawer
          .getByLabel("Voice ID", { exact: true })
          .fill("custom-voice");
        await page.unroute("**/api/backend/voices");
        await drawer.getByRole("button", { name: "Done", exact: true }).click();
        await page
          .getByRole("navigation", { name: "Assistant configuration" })
          .getByRole("button", { name: "Tools" })
          .click();
        await page.getByRole("checkbox", { name: /dial_menu/ }).check();
        await page
          .getByRole("button", { name: "Advanced", exact: true })
          .click();
        await page
          .getByLabel("Server URL", { exact: true })
          .fill("https://receiver.example/call-ended");
        await page.getByLabel("Webhook timeout (seconds)").fill("15");
        await page.getByLabel("Wait before speaking (seconds)").fill("0.4");
        await page
          .getByLabel("Words to interrupt (0 = voice activity)")
          .fill("3");
        await page
          .getByLabel("Interruption phrases (one per line)")
          .fill("stop\nplease wait");
        await page
          .getByLabel(
            "Enable built-in voicemail detection for outbound calls",
          )
          .check();
        await page
          .getByLabel("On voicemail", { exact: true })
          .selectOption("leave-message");
        await page
          .getByLabel("Voicemail message", { exact: true })
          .fill("Please call support back.");
        await page.getByLabel("Voicemail evidence threshold").fill("0.92");
        await page.getByLabel("Maximum beep wait (seconds)").fill("12");
        await page.getByLabel("Menu quiet period (ms)").fill("900");
        await page
          .getByLabel("Respond to automated name-and-purpose screening")
          .check();
        await page
          .getByLabel("Screening response", { exact: true })
          .fill("This is the support team following up.");
        await page
          .getByLabel("Silence timeout (seconds)", { exact: true })
          .fill("45");
        await page
          .getByRole("button", { name: "Save assistant", exact: true })
          .click();
        await page
          .getByRole("status")
          .filter({ hasText: "Assistant saved." })
          .waitFor();
        const agents = await (
          await context.request.get(`${base}/api/backend/agents`)
        ).json();
        const saved = agents.find(
          (a: { name: string }) => a.name === "Support specialist",
        );
        assert.ok(saved);
        assert.equal(saved.transcriber.model, "flux-general-multi");
        assert.equal(saved.transcriber.eotThreshold, 0.8);
        assert.equal(saved.transcriber.eotTimeoutMs, 4000);
        assert.equal(saved.transcriber.eagerEotThreshold, null);
        assert.equal(saved.model, "openrouter:openai/gpt-4.1");
        assert.equal(saved.temperature, 0.5);
        assert.equal(saved.voiceId, "custom-voice");
        assert.equal(saved.voice.model, "eleven_multilingual_v2");
        assert.equal(saved.voice.speed, 1.1);
        assert.equal(saved.voice.style, 0.15);
        assert.equal(saved.voice.useSpeakerBoost, true);
        assert.equal(saved.voice.delivery, "warm");
        assert.equal(saved.voice.deliveryInstructions, "Calm and natural, with brief goodbyes.");
        assert.deepEqual(saved.toolIds, [tool.id]);
        assert.deepEqual(saved.server, {
          url: "https://receiver.example/call-ended",
          timeoutSeconds: 15,
        });
        assert.equal(saved.startSpeakingPlan.waitSeconds, 0.4);
        assert.equal(saved.stopSpeakingPlan.numWords, 3);
        assert.deepEqual(saved.stopSpeakingPlan.interruptionPhrases, [
          "stop",
          "please wait",
        ]);
        assert.equal(
          saved.voicemailDetection.message,
          "Please call support back.",
        );
        assert.equal(
          saved.callScreening.response,
          "This is the support team following up.",
        );
        assert.equal(saved.voicemailDetection.provider, "builtin");
        assert.equal(saved.voicemailDetection.confidenceThreshold, 0.92);
        assert.equal(saved.voicemailDetection.beepWaitSeconds, 12);
        assert.equal(saved.callHandling.menuSilenceMs, 900);
        assert.equal(saved.silenceTimeoutSeconds, 45);
      },
    );

    assert.ok(
      (
        await (await context.request.get(`${base}/api/backend/agents`)).json()
      ).some((a: { name: string }) => a.name === "Support specialist"),
      "Creation must succeed before checking edits.",
    );
    await t.test(
      "reloads saved settings, searches assistants, and protects dirty drafts",
      async () => {
        await page.reload();
        await page
          .getByRole("button", { name: /Support specialist Flux/ })
          .click();
        await page
          .getByRole("button", { name: "Advanced", exact: true })
          .click();
        assert.equal(
          await page.getByLabel("Server URL", { exact: true }).inputValue(),
          "https://receiver.example/call-ended",
        );
        await page
          .getByRole("navigation", { name: "Assistant configuration" })
          .getByRole("button", { name: "Assistant", exact: true })
          .click();
        assert.equal(
          await page.getByLabel("Assistant name", { exact: true }).inputValue(),
          "Support specialist",
        );
        await page
          .getByRole("button", { name: "Edit transcriber", exact: true })
          .click();
        assert.equal(
          await drawer.getByLabel("Transcription model").inputValue(),
          "flux-general-multi",
        );
        assert.equal(
          await drawer.getByLabel("Enable eager turn detection").isChecked(),
          false,
        );
        await page.keyboard.press("Escape");
        await page.getByLabel("Search assistants").fill("no such assistant");
        await page.getByText("No matching assistants.").waitFor();
        await page.getByLabel("Search assistants").fill("");
        await page
          .getByLabel("Assistant name", { exact: true })
          .fill("Unsaved name");
        page.once("dialog", (dialog) => dialog.dismiss());
        await page
          .getByRole("navigation", { name: "Dashboard", exact: true })
          .getByRole("button", { name: "Meetings", exact: true })
          .click();
        assert.equal(
          await page.getByLabel("Assistant name", { exact: true }).inputValue(),
          "Unsaved name",
        );
        page.once("dialog", (dialog) => dialog.accept());
        await page
          .getByRole("button", { name: "Discard changes", exact: true })
          .click();
        assert.equal(
          await page.getByLabel("Assistant name", { exact: true }).inputValue(),
          "Support specialist",
        );
      },
    );

    await t.test(
      "failed saves keep edits and can be retried; hidden invalid settings are validated",
      async () => {
        await page
          .getByLabel("First message mode")
          .selectOption("assistant-waits-for-user");
        await page
          .getByRole("button", { name: "Edit model", exact: true })
          .click();
        await drawer.getByLabel("Model", { exact: true }).fill("");
        await page.keyboard.press("Escape");
        await page
          .getByRole("button", { name: "Save assistant", exact: true })
          .click();
        await page.getByRole("alert").filter({ hasText: "model" }).waitFor();
        await page
          .getByRole("button", { name: "Edit model", exact: true })
          .click();
        await drawer.getByLabel("Model", { exact: true }).fill("gpt-4.1-mini");
        await page.keyboard.press("Escape");
        await page.route("**/api/backend/agents/*", (route) =>
          route.request().method() === "PUT"
            ? route.fulfill({
                status: 503,
                json: { error: "Temporary save failure" },
              })
            : route.continue(),
        );
        await page
          .getByRole("button", { name: "Save assistant", exact: true })
          .click();
        await page
          .getByRole("alert")
          .filter({ hasText: "Temporary save failure" })
          .waitFor();
        assert.equal(
          await page.getByLabel("First message mode").inputValue(),
          "assistant-waits-for-user",
        );
        await page.unroute("**/api/backend/agents/*");
        await page
          .getByRole("button", { name: "Save assistant", exact: true })
          .click();
        await page
          .getByRole("status")
          .filter({ hasText: "Assistant saved." })
          .waitFor();
        const agents = await (
          await context.request.get(`${base}/api/backend/agents`)
        ).json();
        const saved = agents.find(
          (a: { name: string }) => a.name === "Support specialist",
        );
        assert.equal(saved.firstMessageMode, "assistant-waits-for-user");
        assert.equal(saved.model, "gpt-4.1-mini");
        assert.equal(saved.voiceId, "custom-voice");
        assert.deepEqual(saved.toolIds, [tool.id]);
      },
    );

    await t.test(
      "responsive workspace and settings drawer fit mobile screens",
      async () => {
        if (process.env.DASHBOARD_SCREENSHOTS)
          await page.screenshot({
            path: "work/assistants-desktop.png",
            fullPage: true,
          });
        await page.setViewportSize({ width: 390, height: 844 });
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
          true,
        );
        await page
          .getByRole("button", { name: "Edit voice", exact: true })
          .click();
        assert.equal(
          await drawer.evaluate((el) => el.scrollWidth <= window.innerWidth),
          true,
        );
        await drawer
          .getByLabel("Voice ID", { exact: true })
          .fill("mobile-voice");
        await drawer.getByRole("button", { name: "Done", exact: true }).click();
        await page
          .getByRole("button", { name: "Save assistant", exact: true })
          .click();
        await page
          .getByRole("status")
          .filter({ hasText: "Assistant saved." })
          .waitFor();
        if (process.env.DASHBOARD_SCREENSHOTS)
          await page.screenshot({
            path: "work/assistants-mobile.png",
            fullPage: true,
          });
        await page
          .getByRole("navigation", { name: "Dashboard", exact: true })
          .getByRole("button", { name: "Tools", exact: true })
          .click();
        await page
          .getByRole("heading", { name: "dial_menu", exact: true })
          .waitFor();
        assert.deepEqual(errors, []);
      },
    );
    await t.test(
      "empty workspaces, loading retries and paginated lists",
      async () => {
        await page.route("**/api/backend/agents?*", (route) =>
          route.fulfill({ json: [] }),
        );
        await page.reload();
        await page
          .getByRole("heading", { name: "Create your first assistant" })
          .waitFor();
        await page
          .getByRole("button", { name: "Create assistant", exact: true })
          .click();
        await page.getByLabel("Assistant name", { exact: true }).waitFor();
        page.once("dialog", (dialog) => dialog.accept());
        await page
          .getByRole("button", { name: "Discard changes", exact: true })
          .click();
        await page
          .getByRole("heading", { name: "Create your first assistant" })
          .waitFor();
        await page.unroute("**/api/backend/agents?*");
        const records = await (
          await context.request.get(`${base}/api/backend/agents`)
        ).json();
        let fail = true;
        let requestedNextPage = false;
        await page.route("**/api/backend/agents?*", (route) => {
          if (fail) {
            fail = false;
            return route.fulfill({
              status: 503,
              json: { error: "Temporary load failure" },
            });
          }
          if (new URL(route.request().url()).searchParams.has("after")) {
            requestedNextPage = true;
            return route.fulfill({ json: records.slice(1) });
          }
          return route.fulfill({
            json: records.slice(0, 1),
            headers: { "X-Next-Cursor": records[0].id },
          });
        });
        await page.reload();
        await page
          .getByRole("alert")
          .filter({ hasText: "Temporary load failure" })
          .waitFor();
        await page.getByRole("button", { name: "Retry loading" }).click();
        await page
          .getByRole("button", { name: /Support specialist Flux/ })
          .waitFor();
        assert.equal(requestedNextPage, true);
        assert.equal(
          await page.locator(".assistant-list-item").count(),
          records.length,
        );
        await page.unroute("**/api/backend/agents?*");
      },
    );
  },
);

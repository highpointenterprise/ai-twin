import { existsSync } from "node:fs";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type Frame,
  type LaunchOptions,
} from "playwright";
import { env } from "../../lib/env";
import type { MeetingRecord } from "../../lib/meetings";
import type { AudioOutputPort } from "../core/ports";
import type { AvatarRoom, MeetingDriver, MeetingDriverEvents } from "./ports";
import { browserAssets } from "./browser-assets";
import type {} from "./browser/media";
export class MeetingLoginRequired extends Error {}
export function chromiumExecutable(): string | undefined {
  return (
    env.CHROMIUM_EXECUTABLE_PATH ||
    (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined)
  );
}
export function chromiumAvailable(): boolean {
  return existsSync(chromiumExecutable() ?? chromium.executablePath());
}
export function chromiumOptions(headless = true): LaunchOptions {
  const proxyUrl =
    process.env.https_proxy ||
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY;
  const proxy = proxyUrl ? new URL(proxyUrl) : undefined;
  return {
    headless,
    executablePath: chromiumExecutable(),
    chromiumSandbox: !env.MEET_CHROMIUM_NO_SANDBOX,
    args: [
      "--autoplay-policy=no-user-gesture-required",
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
      ...(env.MEET_CHROMIUM_NO_SANDBOX ? ["--no-sandbox"] : []),
      ...(proxy
        ? ["--force-webrtc-ip-handling-policy=disable_non_proxied_udp"]
        : []),
    ],
    ...(proxy
      ? {
          proxy: {
            server: `${proxy.protocol}//${proxy.host}`,
            username: decodeURIComponent(proxy.username),
            password: decodeURIComponent(proxy.password),
            bypass: process.env.NO_PROXY || "localhost,127.0.0.1",
          },
        }
      : {}),
  };
}
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export class GoogleMeetBrowserDriver implements MeetingDriver {
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private avatarFrame?: Frame;
  private events?: MeetingDriverEvents;
  private closed = false;
  private watcher?: NodeJS.Timeout;
  private queue = Promise.resolve();
  private queuedBytes = 0;
  private watching = false;
  private missingCallChecks = 0;
  private closing?: Promise<void>;
  constructor(
    private readonly launch: (options: LaunchOptions) => Promise<Browser> = (
      options,
    ) => chromium.launch(options),
  ) {}
  output: AudioOutputPort = {
    audio: (audio) => this.enqueue("audio", audio),
    mark: (name) => this.enqueue("mark", name),
    clear: () => this.enqueue("clear", ""),
  };
  private enqueue(
    method: "audio" | "mark" | "clear" | "speaking",
    value: string | boolean,
  ): void {
    if (this.closed) return;
    const bytes = typeof value === "string" ? value.length : 0;
    this.queuedBytes += bytes;
    if (this.queuedBytes > 3 * 1024 * 1024) {
      this.events?.onError(new Error("Meeting audio output cannot keep up."));
      return;
    }
    this.queue = this.queue
      .then(async () => {
        if (this.closed || !this.page) return;
        await this.page.evaluate(
          ({ method, value }) => {
            const bridge = window.__aiTwinMedia;
            if (method === "audio") bridge.audio(value as string);
            else if (method === "mark") bridge.mark(value as string);
            else if (method === "speaking") bridge.speaking(value as boolean);
            else bridge.clear();
          },
          { method, value },
        );
      })
      .catch(() => {
        if (!this.closed)
          this.events?.onError(new Error("Meeting media transport failed."));
      })
      .finally(() => {
        this.queuedBytes -= bytes;
      });
  }
  async join(
    meeting: MeetingRecord,
    events: MeetingDriverEvents,
    signal: AbortSignal,
  ): Promise<void> {
    this.events = events;
    const assets = await browserAssets();
    signal.throwIfAborted();
    const browser = await this.launch(chromiumOptions());
    this.browser = browser;
    if (this.closed || signal.aborted) {
      await browser.close();
      throw new Error("Meeting join cancelled.");
    }
    this.context = await browser.newContext({
      locale: "en-US",
      viewport: { width: 1280, height: 800 },
      permissions: ["microphone", "camera"],
      bypassCSP: true,
      ...(env.MEET_GOOGLE_STORAGE_STATE_PATH
        ? { storageState: env.MEET_GOOGLE_STORAGE_STATE_PATH }
        : {}),
    });
    await this.context.addInitScript({ content: assets.media });
    const page = await this.context.newPage();
    this.page = page;
    await page.exposeBinding("__aiTwinAudio", ({ frame }, audio: unknown) => {
      if (frame !== page.mainFrame() || this.closed) return;
      if (
        typeof audio !== "string" ||
        audio.length > 8192 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(audio)
      )
        throw new Error("Invalid meeting audio packet.");
      events.onAudio(audio);
    });
    await page.exposeBinding("__aiTwinMark", ({ frame }, name: unknown) => {
      if (
        frame === page.mainFrame() &&
        !this.closed &&
        typeof name === "string" &&
        name.length <= 100
      )
        events.onMark(name);
    });
    await page.exposeBinding(
      "__aiTwinMediaError",
      (_source, reason: unknown) => {
        if (!this.closed)
          events.onError(
            new Error(
              typeof reason === "string"
                ? reason.slice(0, 160)
                : "Meeting media failed.",
            ),
          );
      },
    );
    page.on("close", () => {
      if (!this.closed) events.onEnded("The meeting browser closed.");
    });
    page.on("crash", () => {
      if (!this.closed)
        events.onError(new Error("The meeting browser crashed."));
    });
    const abort = () => {
      void this.close().catch(() => {});
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      await page.goto(meeting.meetingUrl + "?hl=en", {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      const deadline = Date.now() + meeting.joinTimeoutSeconds * 1000;
      let requested = false;
      while (Date.now() < deadline) {
        signal.throwIfAborted();
        if (this.closed) throw new Error("Meeting join cancelled.");
        if (await this.inCall()) {
          await page.evaluate(() => window.__aiTwinMedia.ready);
          this.watcher = setInterval(() => void this.watch(), 1500);
          return;
        }
        if (
          new URL(page.url()).hostname === "accounts.google.com" ||
          (await page
            .getByText(
              /You need to sign in to join|Sign in to join this meeting/i,
            )
            .first()
            .isVisible()
            .catch(() => false))
        )
          throw new MeetingLoginRequired(
            "This meeting requires a Google login. Configure an authorized browser session and try again.",
          );
        if (
          await page
            .getByText(
              /You can.t join this (video )?call|meeting code.*(invalid|not found)|You were denied|Your request.*denied/i,
            )
            .first()
            .isVisible()
            .catch(() => false)
        )
          throw new Error(
            "Google Meet denied entry or the meeting link is invalid.",
          );
        if (!requested) {
          const name = page
            .getByRole("textbox", { name: /your name/i })
            .first();
          if (await name.isVisible().catch(() => false))
            await name.fill(meeting.displayName);
          const mic = page
            .getByRole("button", { name: /^Turn on microphone/i })
            .first();
          if (await mic.isVisible().catch(() => false))
            await mic.click({ timeout: 3000 });
          const camera = page
            .getByRole("button", {
              name: meeting.avatarEnabled
                ? /^Turn on camera/i
                : /^Turn off camera/i,
            })
            .first();
          if (await camera.isVisible().catch(() => false))
            await camera.click({ timeout: 3000 });
          const join = page
            .getByRole("button", { name: /^(Ask to join|Join now)$/i })
            .first();
          if (
            (await join.isVisible().catch(() => false)) &&
            (await join.isEnabled())
          ) {
            await join.click({ timeout: 5000 });
            requested = true;
            events.onWaiting();
          }
        }
        await pause(350);
      }
      throw new Error(
        "The host did not admit the agent before the join timeout.",
      );
    } catch (error) {
      if (error instanceof MeetingLoginRequired) throw error;
      if (signal.aborted) throw new Error("Meeting join cancelled.");
      const message = error instanceof Error ? error.message : "";
      if (/host did not admit|Google Meet denied/.test(message)) throw error;
      throw new Error(
        "Could not join Google Meet. Check the link, browser login, network/WebRTC access and host admission.",
      );
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
  private async inCall(includeHidden = false): Promise<boolean> {
    if (!this.page) return false;
    const leave = this.page
      .getByRole("button", { name: /^Leave call/i, includeHidden })
      .first();
    // Meet may hide its controls while idle; that does not mean it disconnected.
    return includeHidden
      ? await leave
          .count()
          .then((n) => n > 0)
          .catch(() => false)
      : await leave.isVisible().catch(() => false);
  }
  private async watch(): Promise<void> {
    if (this.closed || this.watching || !this.page) return;
    this.watching = true;
    try {
      if (await this.inCall(true)) this.missingCallChecks = 0;
      else if (++this.missingCallChecks >= 2)
        this.events?.onEnded("The meeting ended or the agent was removed.");
    } finally {
      this.watching = false;
    }
  }
  async attachAvatar(room: AvatarRoom, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (!this.page) throw new Error("Meeting browser is not ready.");
    await this.page.evaluate(() => {
      const frame = document.createElement("iframe");
      frame.id = "ai-twin-avatar-receiver";
      frame.name = "ai-twin-avatar-receiver";
      frame.allow = "autoplay";
      frame.style.cssText =
        "position:fixed;width:1px;height:1px;left:0;top:0;opacity:0;pointer-events:none";
      document.body.append(frame);
    });
    const frame = this.page.frame({ name: "ai-twin-avatar-receiver" });
    if (!frame) throw new Error("Could not start the avatar media receiver.");
    this.avatarFrame = frame;
    await frame.evaluate((await browserAssets()).avatar);
    const abort = () => {
      void this.close().catch(() => {});
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      await frame.evaluate(
        ({ url, token }) => window.__aiTwinAvatar.connect(url, token),
        room,
      );
      signal.throwIfAborted();
    } catch {
      throw new Error(
        "Could not receive HeyGen audio/video. Check LiveAvatar access and the browser WebRTC/TURN network connection.",
      );
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
  avatarSpeaking(speaking: boolean): void {
    this.enqueue("speaking", speaking);
  }
  async drainAvatar(): Promise<void> {
    await this.queue;
    if (this.closed || !this.page)
      throw new Error("Meeting closed during playback.");
    await this.page.evaluate(() => window.__aiTwinMedia.drainAvatar());
  }
  close(): Promise<void> {
    this.closed = true;
    clearInterval(this.watcher);
    return (this.closing ??= this.browser?.close() ?? Promise.resolve());
  }
}

import "dotenv/config";
import { spawn, type ChildProcess } from "node:child_process";
import { access, chmod, constants, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import { env } from "../lib/env";

const DEBUGGER_READY_TIMEOUT_MS = 15_000;
const DEBUGGER_POLL_INTERVAL_MS = 250;
const CHROME_EXIT_TIMEOUT_MS = 5_000;
const GOOGLE_COOKIE_DOMAIN = /(^|\.)google\.com$/;

const CHROME_CANDIDATES: readonly string[] = [
  process.env.CHROME_PATH ?? "",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/opt/google/chrome/chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/snap/bin/chromium",
].filter(Boolean);

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveChromeExecutable(): Promise<string> {
  for (const candidate of CHROME_CANDIDATES) {
    if (await isExecutable(candidate)) return candidate;
  }
  const bundled = chromium.executablePath();
  if (await isExecutable(bundled)) return bundled;
  throw new Error("No Chrome or Chromium executable found. Set CHROME_PATH.");
}

function acquireFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a local debugging port."));
        return;
      }
      server.close(() => resolvePort(address.port));
    });
  });
}

async function waitForDebugger(port: number, chrome: ChildProcess): Promise<void> {
  const deadline = Date.now() + DEBUGGER_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (chrome.exitCode !== null) throw new Error("Chrome exited before it became ready.");
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return;
    } catch {
      await delay(DEBUGGER_POLL_INTERVAL_MS);
    }
  }
  throw new Error("Timed out waiting for Chrome to start.");
}

async function terminate(chrome: ChildProcess): Promise<void> {
  if (chrome.exitCode !== null) return;
  const exited = new Promise<void>((done) => chrome.once("exit", () => done()));
  chrome.kill("SIGTERM");
  await Promise.race([exited, delay(CHROME_EXIT_TIMEOUT_MS)]);
  if (chrome.exitCode === null) chrome.kill("SIGKILL");
}

async function writeFileAtomically(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temporaryPath, contents, { mode: 0o600 });
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function main(): Promise<void> {
  if (!stdin.isTTY) {
    throw new Error("Run meet:login interactively on a machine with a desktop display.");
  }

  const storageStatePath = resolve(
    env.MEET_GOOGLE_STORAGE_STATE_PATH || `${env.DATA_DIR}/google-meet-storage-state.json`,
  );
  const [executablePath, port, profileDirectory] = await Promise.all([
    resolveChromeExecutable(),
    acquireFreePort(),
    mkdtemp(join(tmpdir(), "meet-login-")),
  ]);

  const chrome = spawn(
    executablePath,
    [
      `--remote-debugging-port=${port}`,
      "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${profileDirectory}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--lang=en-US",
      "https://accounts.google.com/",
    ],
    { stdio: "ignore" },
  );
  const terminal = createInterface({ input: stdin, output: stdout });

  try {
    await waitForDebugger(port, chrome);
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const context = browser.contexts()[0];
    if (!context) throw new Error("Chrome did not expose a default browser context.");

    await terminal.question(
      "Sign in manually in the opened Chrome window, including any verification. Press Enter here when finished. ",
    );

    const state = await context.storageState({ indexedDB: true });
    if (!state.cookies.some((cookie) => GOOGLE_COOKIE_DOMAIN.test(cookie.domain))) {
      throw new Error("No Google session detected. Sign-in was not completed; nothing was saved.");
    }

    await writeFileAtomically(storageStatePath, JSON.stringify(state));
    stdout.write(`Saved browser session to ${storageStatePath}\n`);
    await browser.close().catch(() => undefined);
  } finally {
    terminal.close();
    await terminate(chrome);
    await rm(profileDirectory, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Could not save the browser session.");
  process.exitCode = 1;
});
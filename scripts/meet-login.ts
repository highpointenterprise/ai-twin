import "dotenv/config";
import { mkdir, writeFile, chmod } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { chromium } from "playwright";
import { env } from "../lib/env";
import { chromiumOptions } from "../server/meetings/browser-driver";

async function main() {
  if (!stdin.isTTY)
    throw new Error(
      "Run meet:login interactively on a machine with a desktop display.",
    );
  const path = resolve(
    env.MEET_GOOGLE_STORAGE_STATE_PATH ||
      `${env.DATA_DIR}/google-meet-storage-state.json`,
  );
  const browser = await chromium.launch(chromiumOptions(false));
  const terminal = createInterface({ input: stdin, output: stdout });
  try {
    const context = await browser.newContext({ locale: "en-US" });
    const page = await context.newPage();
    await page.goto("https://accounts.google.com/", {
      waitUntil: "domcontentloaded",
    });
    await terminal.question(
      "Sign in yourself in the browser, including any Google verification. Press Enter here when finished to save this browser session. ",
    );
    const state = await context.storageState({ indexedDB: true });
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, JSON.stringify(state), { mode: 0o600 });
    await chmod(path, 0o600);
    stdout.write(
      `Saved browser session to ${path}\nSet MEET_GOOGLE_STORAGE_STATE_PATH to this path and restart the backend.\n`,
    );
  } finally {
    terminal.close();
    await browser.close();
  }
}
void main().catch((error) => {
  console.error(
    error instanceof Error
      ? error.message
      : "Could not save the browser session.",
  );
  process.exitCode = 1;
});

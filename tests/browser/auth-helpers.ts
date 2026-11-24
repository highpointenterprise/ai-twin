import assert from "node:assert/strict";
import type { Page } from "playwright";
import type { authFixture } from "../auth-fixture";
export async function finishSignup(page: Page, base: string, fixture: Awaited<ReturnType<typeof authFixture>>, password: string) {
  await page.waitForURL(`${base}/login?registered=1`);
  const mail = fixture.mail.at(-1)!;
  assert.ok(mail?.token, "Signup must enqueue a verification email");
  await page.goto(`${base}/verify-email#token=${mail.token}`);
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await page.getByRole("status").waitFor();
  assert.equal(new URL(page.url()).hash, "");
  await page.getByRole("link", { name: "Back to login" }).click();
  await page.getByLabel("Email address").fill(mail.email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Log in", exact: true }).click();
  await page.waitForURL(`${base}/dashboard`);
}

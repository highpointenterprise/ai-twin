import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { credentialKey, decryptCredentials, encryptCredentials } from "../server/storage/credentials";

const credentials = { accountSid: `AC${"1".repeat(32)}`, authToken: "2".repeat(32) };
test("provider credentials use authenticated encryption with deployment-owned keys", () => {
  const key = randomBytes(32);
  assert.deepEqual(credentialKey(key.toString("hex")), key);
  assert.deepEqual(credentialKey(key.toString("base64")), key);
  const first = encryptCredentials(credentials, key);
  const second = encryptCredentials(credentials, key);
  assert.notEqual(first.iv, second.iv);
  assert.notEqual(first.ciphertext, second.ciphertext);
  assert.equal(JSON.stringify(first).includes(credentials.authToken), false);
  assert.deepEqual(decryptCredentials(first, key), credentials);
  assert.throws(() => decryptCredentials(first, randomBytes(32)), /Cannot decrypt/);
  assert.throws(() => decryptCredentials({ ...first, tag: Buffer.alloc(16).toString("base64") }, key), /Cannot decrypt/);
  assert.throws(() => credentialKey("short"), /32 random bytes/);
});

test("asynchronous credential storage failure preserves the previous connection", async () => {
  const { TwilioSettings } = await import("../server/providers/twilio-settings");
  const settings = new TwilioSettings({
    load: () => credentials,
    save: async () => { throw new Error("Database unavailable"); },
  }, async () => []);
  await assert.rejects(settings.connect({ accountSid: `AC${"4".repeat(32)}`, authToken: "5".repeat(32) }, () => false), /Could not save/);
  assert.deepEqual(settings.current(), credentials);
  assert.equal(settings.isUpdating, false);
});

test("refresh observes credentials saved by another worker without replacing an update in progress", async () => {
  const { TwilioSettings } = await import("../server/providers/twilio-settings");
  let persisted = credentials;
  let cached = credentials;
  let release: (() => void) | undefined;
  const settings = new TwilioSettings({
    load: () => cached,
    save: async value => { persisted = value; cached = value; },
    refresh: async () => { cached = persisted; },
  }, async () => { await new Promise<void>(resolve => { release = resolve; }); return []; });
  persisted = { accountSid: `AC${"4".repeat(32)}`, authToken: "5".repeat(32) };
  await settings.refresh();
  assert.deepEqual(settings.current(), persisted);
  const replacement = { accountSid: `AC${"6".repeat(32)}`, authToken: "7".repeat(32) };
  const changing = settings.connect(replacement, () => false);
  await settings.refresh();
  assert.deepEqual(settings.current(), persisted);
  release!();
  await changing;
  assert.deepEqual(settings.current(), replacement);
});

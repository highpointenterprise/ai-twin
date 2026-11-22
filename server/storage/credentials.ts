import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Collection, Db } from "mongodb";
import { twilioCredentialsSchema, type TwilioCredentials } from "../../lib/twilio";

const AAD = Buffer.from("ai-twin/provider-credentials/v1/twilio");
export interface CredentialEnvelope {
  version: 1;
  iv: string;
  tag: string;
  ciphertext: string;
}
interface CredentialDocument {
  provider: "twilio";
  envelope: CredentialEnvelope;
  createdAt: Date;
  updatedAt: Date;
}

export function credentialKey(value: string): Buffer {
  const key = /^[a-f0-9]{64}$/i.test(value)
    ? Buffer.from(value, "hex")
    : Buffer.from(value, "base64");
  if (key.length !== 32 || !value)
    throw new Error("CREDENTIAL_ENCRYPTION_KEY must encode exactly 32 random bytes (hex or base64).");
  return key;
}
export function encryptCredentials(credentials: TwilioCredentials, key: Buffer): CredentialEnvelope {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(twilioCredentialsSchema.parse(credentials)), "utf8"),
    cipher.final(),
  ]);
  return { version: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
}
export function decryptCredentials(envelope: CredentialEnvelope, key: Buffer): TwilioCredentials {
  try {
    if (envelope.version !== 1) throw new Error("Unknown credential version");
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
    decipher.setAAD(AAD);
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final(),
    ]);
    return twilioCredentialsSchema.parse(JSON.parse(plaintext.toString("utf8")));
  } catch {
    throw new Error("Cannot decrypt saved Twilio credentials. Restore the matching CREDENTIAL_ENCRYPTION_KEY.");
  }
}

/** The encryption key comes from the deployment secret store, never MongoDB. */
export class MongoTwilioCredentialStore {
  private readonly collection: Collection<CredentialDocument>;
  private readonly key: Buffer;
  private saved?: TwilioCredentials;
  private revision = 0;
  constructor(private readonly db: Db, encryptionKey: string) {
    this.collection = db.collection<CredentialDocument>("providerCredentials");
    this.key = credentialKey(encryptionKey);
  }
  async initialize(): Promise<void> {
    await this.collection.createIndex({ provider: 1 }, { unique: true });
    await this.refresh();
  }
  async refresh(): Promise<void> {
    const revision = this.revision;
    const document = await this.collection.findOne({ provider: "twilio" });
    if (revision === this.revision)
      this.saved = document ? decryptCredentials(document.envelope, this.key) : undefined;
  }
  load(): TwilioCredentials | undefined {
    return this.saved ? { ...this.saved } : undefined;
  }
  async save(credentials: TwilioCredentials): Promise<void> {
    const parsed = twilioCredentialsSchema.parse(credentials);
    this.revision++;
    const now = new Date();
    if (this.saved && this.saved.accountSid !== parsed.accountSid) {
      await this.db.collection<{ _id: string; envelope: CredentialEnvelope }>("provider_credential_accounts").updateOne(
        { _id: this.saved.accountSid }, { $set: { envelope: encryptCredentials(this.saved, this.key) } }, { upsert: true });
    }
    await this.collection.updateOne(
      { provider: "twilio" },
      { $set: { envelope: encryptCredentials(parsed, this.key), updatedAt: now }, $setOnInsert: { provider: "twilio", createdAt: now } },
      { upsert: true },
    );
    this.saved = parsed;
  }
  async forAccount(accountSid: string): Promise<TwilioCredentials | undefined> {
    await this.refresh();
    if (this.saved?.accountSid === accountSid) return { ...this.saved };
    const saved = await this.db.collection<{ _id: string; envelope: CredentialEnvelope }>("provider_credential_accounts").findOne({ _id: accountSid });
    return saved ? decryptCredentials(saved.envelope, this.key) : undefined;
  }
  /** Import only into an empty provider slot; rerunning a migration never replaces newer credentials. */
  async importIfAbsent(credentials: TwilioCredentials): Promise<boolean> {
    this.revision++;
    const now = new Date();
    const result = await this.collection.updateOne(
      { provider: "twilio" },
      { $setOnInsert: { provider: "twilio", envelope: encryptCredentials(credentials, this.key), createdAt: now, updatedAt: now } },
      { upsert: true },
    );
    await this.refresh();
    return result.upsertedCount === 1;
  }
}

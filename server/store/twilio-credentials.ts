import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  twilioCredentialsSchema,
  type TwilioCredentials,
} from "../../lib/twilio";
import { JsonFile } from "./persistence";

const envelopeSchema = z
  .object({
    version: z.literal(1),
    iv: z.string(),
    tag: z.string(),
    ciphertext: z.string(),
  })
  .strict();
type Envelope = z.infer<typeof envelopeSchema>;
const AAD = Buffer.from("ai-twin/twilio-credentials/v1");

// Dedicated encrypted storage: never put provider tokens in assistant/tool JSON.
// Keep this directory and its encryption key private to the backend process.
export class TwilioCredentialStore {
  private readonly path: string;
  private readonly keyPath: string;
  private readonly file: JsonFile<Envelope | null>;
  constructor(private readonly directory: string) {
    this.path = join(directory, "twilio-credentials.enc.json");
    this.keyPath = join(directory, ".credentials.key");
    this.file = new JsonFile(this.path);
  }
  load(): TwilioCredentials | undefined {
    try {
      const saved = this.file.load(null);
      if (!saved) return undefined;
      const envelope = envelopeSchema.parse(saved);
      const key = readFileSync(this.keyPath);
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(envelope.iv, "base64"),
      );
      decipher.setAAD(AAD);
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64")),
        decipher.final(),
      ]);
      return twilioCredentialsSchema.parse(
        JSON.parse(plaintext.toString("utf8")),
      );
    } catch {
      throw new Error(
        "Cannot read saved Twilio credentials. Restore the credential file and its matching encryption key.",
      );
    }
  }
  save(credentials: TwilioCredentials): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (!existsSync(this.keyPath))
      writeFileSync(this.keyPath, randomBytes(32), { flag: "wx", mode: 0o600 });
    chmodSync(this.keyPath, 0o600);
    const key = readFileSync(this.keyPath),
      iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(AAD);
    const ciphertext = Buffer.concat([
      cipher.update(
        JSON.stringify(twilioCredentialsSchema.parse(credentials)),
        "utf8",
      ),
      cipher.final(),
    ]);
    this.file.save({
      version: 1,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    });
    chmodSync(this.path, 0o600);
  }
}

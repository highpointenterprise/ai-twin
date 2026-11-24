import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { credentialKey } from "../storage/credentials";
export const digest = (v: string) => createHash("sha256").update(v).digest("hex");
export const opaqueToken = () => randomBytes(32).toString("base64url");
export function seal(value: string, key: string, context: string): string {
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", credentialKey(key), iv);
  cipher.setAAD(Buffer.from(context));
  const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}
export function unseal(value: string, key: string, context: string): string {
  const bytes = Buffer.from(value, "base64url"), cipher = createDecipheriv("aes-256-gcm", credentialKey(key), bytes.subarray(0, 12));
  cipher.setAAD(Buffer.from(context)); cipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString("utf8");
}
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function newTotpSecret(): string {
  const bits = [...randomBytes(20)].map(b => b.toString(2).padStart(8, "0")).join("");
  return bits.match(/.{5}/g)!.map(v => alphabet[parseInt(v, 2)]).join("");
}
export function totp(secret: string, step = Math.floor(Date.now() / 30000)): string {
  const bits = [...secret].map(v => alphabet.indexOf(v).toString(2).padStart(5, "0")).join("");
  const key = Buffer.from(bits.match(/.{8}/g)!.map(v => parseInt(v, 2))), counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hash = createHmac("sha1", key).update(counter).digest();
  return ((hash.readUInt32BE(hash[19] & 15) & 0x7fffffff) % 1000000).toString().padStart(6, "0");
}
export function totpStep(secret: string, code: string): number | undefined {
  if (!/^\d{6}$/.test(code)) return;
  const now = Math.floor(Date.now() / 30000);
  for (const step of [now, now - 1, now + 1]) if (timingSafeEqual(Buffer.from(totp(secret, step)), Buffer.from(code))) return step;
}

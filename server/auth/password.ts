import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const PROFILE = { N: 131072, r: 8, p: 1 };
let active = 0;
const waiting: (() => void)[] = [];
async function derive(password: string, salt: Buffer, legacy = false): Promise<Buffer> {
  if (active >= 2) {
    if (waiting.length >= 32) throw new Error("Password verification is busy.");
    await new Promise<void>(resolve => waiting.push(resolve));
  } else active++;
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      scrypt(password, salt, 64, { ...PROFILE, ...(legacy ? { N: 32768 } : {}), maxmem: 256 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key));
    });
  } finally { const next = waiting.shift(); if (next) next(); else active--; }
}
export const passwordNeedsUpgrade = (stored: string) => stored.split("$").length === 3;
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16), key = await derive(password, salt);
  return `scrypt$${PROFILE.N}$${PROFILE.r}$${PROFILE.p}$${salt.toString("hex")}$${key.toString("hex")}`;
}
export async function verifyPassword(password: string, stored?: string): Promise<boolean> {
  const parts = stored?.split("$");
  const legacy = parts?.length === 3 && parts[0] === "scrypt";
  const modern = parts?.length === 6 && parts.slice(0, 4).join("$") === "scrypt$131072$8$1";
  const saltHex = parts?.at(-2) || "", hashHex = parts?.at(-1) || "";
  const valid = (legacy || modern) && /^[a-f0-9]{32}$/.test(saltHex) && /^[a-f0-9]{128}$/.test(hashHex);
  const salt = valid ? Buffer.from(saltHex, "hex") : Buffer.alloc(16);
  const expected = valid ? Buffer.from(hashHex, "hex") : Buffer.alloc(64);
  const actual = await derive(password, salt, !!(valid && legacy));
  return timingSafeEqual(actual, expected) && Boolean(valid);
}

import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Collection, Db } from "mongodb";
import type { RequestHandler } from "express";
import { env } from "../../../../lib/env";
import type { RedisCallState } from "../../../storage/redis";
import { ApiError } from "../http/errors";

const KEY_PREFIX = "twk_";
const MAX_TOKEN_LENGTH = 128;
const POSITIVE_CACHE_MS = 30_000;
const CACHE_LIMIT = 10_000;

export interface Principal {
  keyId: string;
  orgId: string;
  name: string;
}

interface ApiKeyDocument {
  _id: string;
  orgId: string;
  name: string;
  hash: string;
  hint: string;
  createdAt: string;
  revokedAt?: string;
  lastUsedAt?: string;
}

const digest = (token: string): string => createHash("sha256").update(token).digest("hex");

export class ApiKeyStore {
  private readonly keys: Collection<ApiKeyDocument>;
  private readonly cache = new Map<string, { principal: Principal; expires: number }>();

  constructor(db: Db, private readonly orgId = "default") {
    this.keys = db.collection<ApiKeyDocument>("api_keys");
  }

  async initialize(): Promise<void> {
    await Promise.all([
      this.keys.createIndex({ hash: 1 }, { unique: true }),
      this.keys.createIndex({ orgId: 1, createdAt: -1 }),
    ]);
  }

  async issue(name: string): Promise<{ id: string; key: string }> {
    const key = `${KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
    const id = randomUUID();
    await this.keys.insertOne({
      _id: id,
      orgId: this.orgId,
      name: name.slice(0, 80),
      hash: digest(key),
      hint: key.slice(-4),
      createdAt: new Date().toISOString(),
    });
    return { id, key };
  }

  async revoke(id: string): Promise<boolean> {
    const result = await this.keys.updateOne(
      { _id: id, revokedAt: { $exists: false } },
      { $set: { revokedAt: new Date().toISOString() } },
    );
    this.cache.clear();
    return result.modifiedCount === 1;
  }

  async verify(token: string): Promise<Principal | undefined> {
    if (!token.startsWith(KEY_PREFIX) || token.length > MAX_TOKEN_LENGTH) return undefined;
    const hash = digest(token);
    const cached = this.cache.get(hash);
    if (cached && cached.expires > Date.now()) return cached.principal;
    const document = await this.keys.findOne({ hash, revokedAt: { $exists: false } });
    if (!document) {
      this.cache.delete(hash);
      return undefined;
    }
    const principal: Principal = { keyId: document._id, orgId: document.orgId, name: document.name };
    if (this.cache.size >= CACHE_LIMIT) this.cache.clear();
    this.cache.set(hash, { principal, expires: Date.now() + POSITIVE_CACHE_MS });
    void this.keys
      .updateOne({ _id: document._id }, { $set: { lastUsedAt: new Date().toISOString() } })
      .catch(() => undefined);
    return principal;
  }
}

const bearerToken = (header: string | undefined): string | undefined => {
  if (!header) return undefined;
  const [scheme, token, ...rest] = header.split(" ");
  return scheme?.toLowerCase() === "bearer" && token && !rest.length ? token : undefined;
};

const WINDOW_MS = 60_000;

export const authenticate =
  (store: ApiKeyStore, state: RedisCallState): RequestHandler =>
  async (req, res, next) => {
    try {
      const token = bearerToken(req.get("authorization"));
      const address = req.ip ?? "unknown";
      const principal = token ? await store.verify(token) : undefined;
      if (!principal) {
        const limit = await state.rateLimit(`auth-denied:${address}`, 30, WINDOW_MS);
        if (!limit.allowed)
          throw new ApiError(429, "Too many failed authentication attempts.", {
            "retry-after": String(Math.ceil(limit.retryAfterMs / 1000)),
          });
        throw new ApiError(401, "Invalid or missing API key.", { "www-authenticate": "Bearer" });
      }
      const budget = await state.rateLimit(`api:${principal.keyId}`, env.API_RATE_LIMIT_PER_MINUTE, WINDOW_MS);
      res.setHeader("ratelimit-limit", String(env.API_RATE_LIMIT_PER_MINUTE));
      res.setHeader("ratelimit-remaining", String(budget.remaining));
      if (!budget.allowed)
        throw new ApiError(429, "Rate limit exceeded.", {
          "retry-after": String(Math.ceil(budget.retryAfterMs / 1000)),
        });
      res.locals.principal = principal;
      next();
    } catch (error) {
      next(error);
    }
  };

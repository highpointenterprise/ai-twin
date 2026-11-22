import { randomBytes, randomUUID } from "node:crypto";
import type { Collection, Db } from "mongodb";
import type { RequestHandler } from "express";
import { env } from "../../../../lib/env";
import type { RedisCallState } from "../../../storage/redis";
import { ApiError } from "../http/errors";
import {
  apiKeyDigest as digest,
  validApiKey,
  type ApiKeyDirectory,
} from "./key-directory";

const KEY_PREFIX = "twk_";

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

export class ApiKeyStore {
  private readonly keys: Collection<ApiKeyDocument>;

  constructor(
    db: Db,
    private readonly orgId = "default",
    private readonly directory?: ApiKeyDirectory,
  ) {
    this.keys = db.collection<ApiKeyDocument>("api_keys");
  }

  async initialize(): Promise<void> {
    await Promise.all([
      this.keys.createIndex({ hash: 1 }, { unique: true }),
      this.keys.createIndex({ orgId: 1, createdAt: -1 }),
      this.keys.createIndex({ orgId: 1, _id: 1 }),
    ]);
    if (this.directory)
      for await (const key of this.keys.find({
        orgId: this.orgId,
        revokedAt: { $exists: false },
      }))
        await this.directory.register(key.hash, this.orgId, key._id);
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
    try {
      await this.directory?.register(digest(key), this.orgId, id);
    } catch (error) {
      await this.keys.deleteOne({ _id: id, orgId: this.orgId });
      throw error;
    }
    return { id, key };
  }

  async list(after?: string) {
    const rows = await this.keys
      .find(
        { orgId: this.orgId, ...(after ? { _id: { $gt: after } } : {}) },
        { projection: { hash: 0 } },
      )
      .sort({ _id: 1 })
      .limit(101)
      .toArray();
    return {
      keys: rows
        .slice(0, 100)
        .map(({ _id, orgId: _orgId, hash: _hash, ...key }) => ({
          id: _id,
          ...key,
        })),
      nextCursor: rows.length > 100 ? rows[99]._id : null,
    };
  }
  async rename(id: string, name: string): Promise<boolean> {
    return !!(
      await this.keys.updateOne(
        { _id: id, orgId: this.orgId, revokedAt: { $exists: false } },
        { $set: { name } },
      )
    ).matchedCount;
  }
  async revoke(id: string): Promise<boolean> {
    const key = await this.keys.findOneAndUpdate(
      { _id: id, orgId: this.orgId },
      { $set: { revokedAt: new Date().toISOString() } },
      { returnDocument: "before" },
    );
    if (!key) return false;
    await this.directory?.remove(key.hash, this.orgId);
    return true;
  }
  async verify(token: string): Promise<Principal | undefined> {
    if (!validApiKey(token)) return undefined;
    const document = await this.keys.findOne({
      hash: digest(token),
      orgId: this.orgId,
      revokedAt: { $exists: false },
    });
    if (!document) return undefined;
    const principal: Principal = {
      keyId: document._id,
      orgId: document.orgId,
      name: document.name,
    };
    void this.keys
      .updateOne(
        { _id: document._id },
        { $set: { lastUsedAt: new Date().toISOString() } },
      )
      .catch(() => undefined);
    return principal;
  }
}

export const bearerToken = (header: string | undefined): string | undefined => {
  if (!header) return undefined;
  const [scheme, token, ...rest] = header.split(" ");
  return scheme?.toLowerCase() === "bearer" && token && !rest.length
    ? token
    : undefined;
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
        const limit = await state.rateLimit(
          `auth-denied:${address}`,
          30,
          WINDOW_MS,
        );
        if (!limit.allowed)
          throw new ApiError(429, "Too many failed authentication attempts.", {
            "retry-after": String(Math.ceil(limit.retryAfterMs / 1000)),
          });
        throw new ApiError(401, "Invalid or missing API key.", {
          "www-authenticate": "Bearer",
        });
      }
      const budget = await state.rateLimit(
        `api:${principal.keyId}`,
        env.API_RATE_LIMIT_PER_MINUTE,
        WINDOW_MS,
      );
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

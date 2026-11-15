import { createHash } from "node:crypto";
import Redis from "ioredis";
import { Queue, Worker, type ConnectionOptions } from "bullmq";
import type { CallContext, ContextBackend } from "../store/contexts";

const DEFAULT_TTL_MS = 10 * 60 * 1000;

/** One hash tag keeps atomic context/index operations in one Redis Cluster slot. */
export class RedisContextBackend implements ContextBackend {
  constructor(
    private readonly redis: Redis,
    private readonly prefix = "voice:{contexts}",
    private readonly ttlMs = DEFAULT_TTL_MS,
  ) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000) throw new Error("Invalid context TTL.");
  }
  private key(id: string): string { return `${this.prefix}:context:${id}`; }
  private sidKey(sid: string): string { return `${this.prefix}:sid:${sid}`; }
  async set(id: string, value: CallContext): Promise<void> {
    const result = await this.redis.eval(`
      if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
      if ARGV[3] ~= '' and redis.call('EXISTS', KEYS[2]) == 1 then return -1 end
      redis.call('HSET', KEYS[1], 'payload', ARGV[1], 'sid', ARGV[3])
      redis.call('PEXPIRE', KEYS[1], ARGV[2])
      if ARGV[3] ~= '' then redis.call('SET', KEYS[2], ARGV[4], 'PX', ARGV[2]) end
      return 1
    `, 2, this.key(id), this.sidKey(value.sid ?? ""), JSON.stringify(value), this.ttlMs, value.sid ?? "", id);
    if (result !== 1) throw new Error("Call context already exists or call is already bound.");
  }
  async get(id: string): Promise<CallContext | undefined> {
    const [raw, sid, purpose] = await this.redis.hmget(this.key(id), "payload", "sid", "purpose");
    if (!raw) return undefined;
    const value = JSON.parse(raw) as CallContext;
    if (sid) value.sid = sid;
    if (purpose) value.purpose = purpose as CallContext["purpose"];
    return value;
  }
  async bind(id: string, sid: string): Promise<boolean> {
    const result = await this.redis.eval(`
      local raw = redis.call('HGET', KEYS[1], 'payload')
      if not raw then return 0 end
      local sid = redis.call('HGET', KEYS[1], 'sid')
      if sid and sid ~= '' and sid ~= ARGV[1] then return 0 end
      local bound = redis.call('GET', KEYS[2])
      if bound and bound ~= ARGV[2] then return 0 end
      local ttl = redis.call('PTTL', KEYS[1])
      if ttl <= 0 then return 0 end
      redis.call('HSET', KEYS[1], 'sid', ARGV[1])
      redis.call('SET', KEYS[2], ARGV[2], 'PX', ttl)
      return 1
    `, 2, this.key(id), this.sidKey(sid), sid, id);
    return result === 1;
  }
  async take(id: string, sid: string): Promise<CallContext | undefined> {
    const raw = await this.redis.eval(`
      local raw = redis.call('HGET', KEYS[1], 'payload')
      if not raw then return false end
      local sid = redis.call('HGET', KEYS[1], 'sid')
      if sid ~= ARGV[1] then return false end
      local purpose = redis.call('HGET', KEYS[1], 'purpose') or ''
      redis.call('DEL', KEYS[1])
      if redis.call('GET', KEYS[2]) == ARGV[2] then redis.call('DEL', KEYS[2]) end
      return {raw, sid, purpose}
    `, 2, this.key(id), this.sidKey(sid), sid, id);
    if (!Array.isArray(raw)) return undefined;
    const value = JSON.parse(raw[0] as string) as CallContext;
    value.sid = raw[1] as string;
    if (raw[2]) value.purpose = raw[2] as CallContext["purpose"];
    return value;
  }
  async idForSid(sid: string): Promise<string | undefined> {
    const id = await this.redis.get(this.sidKey(sid));
    if (!id) return undefined;
    const context = await this.get(id);
    return context?.sid === sid ? id : undefined;
  }
  async delete(id: string): Promise<void> {
    const context = await this.get(id);
    if (!context) return;
    await this.redis.eval(`
      redis.call('DEL', KEYS[1])
      if redis.call('GET', KEYS[2]) == ARGV[1] then redis.call('DEL', KEYS[2]) end
      return 1
    `, 2, this.key(id), this.sidKey(context.sid ?? ""), id);
  }
  async updatePurpose(id: string, purpose: CallContext["purpose"]): Promise<boolean> {
    return (await this.redis.eval(`
      local raw = redis.call('HGET', KEYS[1], 'payload')
      if not raw then return 0 end
      local ttl = redis.call('PTTL', KEYS[1])
      if ttl <= 0 then return 0 end
      redis.call('HSET', KEYS[1], 'purpose', ARGV[1])
      return 1
    `, 1, this.key(id), purpose)) === 1;
  }
}

/** Shared limits and expiring call leases. No process-local fallback on Redis failure. */
export class RedisCallState {
  constructor(private readonly redis: Redis, private readonly prefix = "voice:{calls}") {}
  async rateLimit(key: string, limit: number, windowMs: number): Promise<{ allowed: boolean; remaining: number; retryAfterMs: number }> {
    if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(windowMs) || windowMs < 1)
      throw new Error("Invalid rate limit configuration.");
    const result = await this.redis.eval(`
      local n = redis.call('INCR', KEYS[1])
      if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
      return {n, redis.call('PTTL', KEYS[1])}
    `, 1, `${this.prefix}:limit:${key}`, windowMs) as [number, number];
    return { allowed: result[0] <= limit, remaining: Math.max(0, limit - result[0]), retryAfterMs: Math.max(0, result[1]) };
  }
  async reserve(id: string, limit: number, ttlMs = 120_000): Promise<boolean> {
    if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(ttlMs) || ttlMs < 1000)
      throw new Error("Invalid call lease configuration.");
    return (await this.redis.eval(`
      local time = redis.call('TIME')
      local now = time[1] * 1000 + math.floor(time[2] / 1000)
      redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
      if not redis.call('ZSCORE', KEYS[1], ARGV[1]) and redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[2]) then return 0 end
      redis.call('ZADD', KEYS[1], now + tonumber(ARGV[3]), ARGV[1])
      if redis.call('PTTL', KEYS[1]) < tonumber(ARGV[3]) then redis.call('PEXPIRE', KEYS[1], ARGV[3]) end
      return 1
    `, 1, `${this.prefix}:leases`, id, limit, ttlMs)) === 1;
  }
  async release(id: string): Promise<void> { await this.redis.zrem(`${this.prefix}:leases`, id); }
  async activeCount(): Promise<number> {
    return await this.redis.eval(`
      local time = redis.call('TIME')
      local now = time[1] * 1000 + math.floor(time[2] / 1000)
      redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
      return redis.call('ZCARD', KEYS[1])
    `, 1, `${this.prefix}:leases`) as number;
  }
  async setLiveCall(sid: string, state: Record<string, unknown>, ttlMs = 120_000): Promise<void> {
    await this.redis.set(`${this.prefix}:live:${sid}`, JSON.stringify(state), "PX", ttlMs);
  }
  async getLiveCall(sid: string): Promise<Record<string, unknown> | undefined> {
    const value = await this.redis.get(`${this.prefix}:live:${sid}`);
    return value ? JSON.parse(value) as Record<string, unknown> : undefined;
  }
  async removeLiveCall(sid: string, contextId?: string): Promise<void> {
    if (!contextId) { await this.redis.del(`${this.prefix}:live:${sid}`); return; }
    await this.redis.eval(`
      local raw = redis.call('GET', KEYS[1])
      if raw and cjson.decode(raw).contextId == ARGV[1] then redis.call('DEL', KEYS[1]) end
      return 1
    `, 1, `${this.prefix}:live:${sid}`, contextId);
  }
}

export function redisConnection(url: string): ConnectionOptions {
  const parsed = new URL(url);
  if (!["redis:", "rediss:"].includes(parsed.protocol)) throw new Error("REDIS_URL must use redis:// or rediss://.");
  const db = Number(parsed.pathname.slice(1) || 0);
  if (!Number.isSafeInteger(db) || db < 0) throw new Error("Invalid Redis database number.");
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    db,
    tls: parsed.protocol === "rediss:" ? {} : undefined,
    maxRetriesPerRequest: null,
  };
}

export interface ArchiveCallJob { sid: string; revision: string; }
/** Idempotent, retryable jobs; the processor must use deterministic object keys. */
export class ArtifactQueue {
  private readonly queue: Queue<ArchiveCallJob>;
  private readonly worker?: Worker<ArchiveCallJob>;
  constructor(
    url: string,
    processor?: (job: ArchiveCallJob) => Promise<void>,
    options: { prefix?: string; concurrency?: number; onError?: (error: Error) => void } = {},
  ) {
    const connection = redisConnection(url);
    const prefix = options.prefix ?? "voice";
    this.queue = new Queue<ArchiveCallJob>("call-artifacts", {
      connection: { ...connection, maxRetriesPerRequest: 1 }, prefix,
      defaultJobOptions: {
        attempts: 17,
        backoff: { type: "exponential", delay: 1000 },
        removeOnComplete: { age: 7 * 86400, count: 10_000 },
        removeOnFail: false,
      },
    });
    this.queue.on("error", options.onError ?? ((error) => console.error("artifact.queue_error", error.message)));
    if (processor) {
      this.worker = new Worker<ArchiveCallJob>("call-artifacts", (job) => processor(job.data), {
        connection, prefix, concurrency: options.concurrency ?? 4,
      });
      this.worker.on("error", options.onError ?? ((error) => console.error("artifact.worker_error", error.message)));
      this.worker.on("failed", (job, error) => {
        console.error("artifact.job_failed", { jobId: job?.id, attempts: job?.attemptsMade, message: error.message });
      });
    }
  }
  async ready(): Promise<void> {
    await this.queue.waitUntilReady();
    await this.worker?.waitUntilReady();
  }
  async enqueue(sid: string, revision = "final", delay = 0): Promise<void> {
    if (!Number.isSafeInteger(delay) || delay < 0) throw new Error("Invalid artifact job delay.");
    const jobId = createHash("sha256").update(`${sid}\0${revision}`).digest("hex");
    await this.queue.add("archive", { sid, revision }, { jobId, delay });
  }
  async retryFailed(sid: string, revision = "final"): Promise<boolean> {
    const jobId = createHash("sha256").update(`${sid}\0${revision}`).digest("hex");
    const job = await this.queue.getJob(jobId);
    if (!job || (await job.getState()) !== "failed") return false;
    await job.retry("failed", { resetAttemptsMade: true, resetAttemptsStarted: true });
    return true;
  }
  async close(): Promise<void> {
    await this.worker?.close();
    await this.queue.close();
  }
}

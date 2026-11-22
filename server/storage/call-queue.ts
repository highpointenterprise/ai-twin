import type Redis from "ioredis";

export type ClaimResult =
  | { status: "claimed"; id: string }
  | { status: "at-capacity" }
  | { status: "rate-limited"; retryAfterMs: number }
  | { status: "idle"; nextDueInMs?: number };

export interface ClaimOptions {
  concurrencyLimit: number;
  dispatchesPerMinute: number;
  leaseTtlMs: number;
  processingTtlMs: number;
}

const CLAIM_SCRIPT = `
local t = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', now)
if redis.call('ZCARD', KEYS[3]) >= tonumber(ARGV[1]) then return {'at-capacity'} end
local due = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', now, 'LIMIT', 0, 1)
if #due == 0 then
  local head = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  if #head == 0 then return {'idle'} end
  return {'idle', tostring(math.max(0, tonumber(head[2]) - now))}
end
local dispatched = tonumber(redis.call('GET', KEYS[4]) or '0')
if dispatched >= tonumber(ARGV[4]) then
  return {'rate-limited', tostring(math.max(1, redis.call('PTTL', KEYS[4])))}
end
redis.call('INCR', KEYS[4])
redis.call('PEXPIRE', KEYS[4], ARGV[5])
redis.call('ZREM', KEYS[1], due[1])
redis.call('ZADD', KEYS[3], now + tonumber(ARGV[2]), due[1])
redis.call('ZADD', KEYS[2], now + tonumber(ARGV[3]), due[1])
return {'claimed', due[1]}
`;

const RECOVER_SCRIPT = `
local t = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)
local stale = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', now, 'LIMIT', 0, tonumber(ARGV[1]))
for _, id in ipairs(stale) do redis.call('ZREM', KEYS[1], id) end
return stale
`;

/** All keys share one hash tag so every operation is atomic in Redis Cluster. */
export class CallQueue {
  constructor(
    private readonly redis: Redis,
    private readonly prefix: string,
  ) {}

  private key(name: string): string {
    return `${this.prefix}:${name}`;
  }

  get capacityChannel(): string {
    return this.key("capacity");
  }

  async enqueue(id: string, runAtMs: number, onlyIfAbsent = false): Promise<void> {
    if (!Number.isFinite(runAtMs)) throw new Error("Invalid queue schedule.");
    if (onlyIfAbsent) await this.redis.zadd(this.key("queue"), "NX", runAtMs, id);
    else await this.redis.zadd(this.key("queue"), runAtMs, id);
  }

  async remove(id: string): Promise<boolean> {
    return (await this.redis.zrem(this.key("queue"), id)) === 1;
  }

  async depth(): Promise<number> {
    return this.redis.zcard(this.key("queue"));
  }

  async activeLeases(): Promise<number> {
    return (await this.redis.eval(
      `local t = redis.call('TIME')
       redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', t[1] * 1000 + math.floor(t[2] / 1000))
       return redis.call('ZCARD', KEYS[1])`,
      1,
      this.key("leases"),
    )) as number;
  }

  async claim(options: ClaimOptions): Promise<ClaimResult> {
    const window = Math.floor(Date.now() / 60_000);
    const reply = (await this.redis.eval(
      CLAIM_SCRIPT,
      4,
      this.key("queue"),
      this.key("processing"),
      this.key("leases"),
      this.key(`dispatched:${window}`),
      options.concurrencyLimit,
      options.leaseTtlMs,
      options.processingTtlMs,
      options.dispatchesPerMinute,
      60_000,
    )) as string[];
    switch (reply[0]) {
      case "claimed":
        return { status: "claimed", id: reply[1] };
      case "at-capacity":
        return { status: "at-capacity" };
      case "rate-limited":
        return { status: "rate-limited", retryAfterMs: Number(reply[1]) };
      default:
        return { status: "idle", ...(reply[1] !== undefined ? { nextDueInMs: Number(reply[1]) } : {}) };
    }
  }

  async acknowledge(id: string): Promise<void> {
    await this.redis.zrem(this.key("processing"), id);
  }

  async recoverStale(limit = 100): Promise<string[]> {
    return (await this.redis.eval(RECOVER_SCRIPT, 1, this.key("processing"), limit)) as string[];
  }
}

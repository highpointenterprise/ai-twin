import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import type { LookupFunction } from "node:net";
import { Agent, request, type Dispatcher } from "undici";
import { assistantServerSchema } from "../../lib/assistant-server";

export class DeliveryError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}
const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(address, prefix, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
for (const [address, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const)
  blocked.addSubnet(address, prefix, "ipv6");
export function publicAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4
    ? !blocked.check(address, "ipv4")
    : family === 6 &&
        globalV6.check(address, "ipv6") &&
        !blocked.check(address, "ipv6");
}
export async function publicLookup(hostname: string, resolve = lookup) {
  const addresses = await resolve(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((a) => !publicAddress(a.address)))
    throw new DeliveryError(
      "Webhook destination must resolve to public addresses.",
      false,
    );
  return addresses;
}
export function retryAfter(
  value: string | string[] | undefined,
  now = Date.now(),
): number | undefined {
  if (typeof value !== "string") return undefined;
  const delay = /^\d+(\.\d+)?$/.test(value)
    ? Number(value) * 1000
    : Date.parse(value) - now;
  return Number.isFinite(delay)
    ? Math.min(3_600_000, Math.max(0, delay))
    : undefined;
}
export interface DeliveryRequest {
  url: string;
  timeoutSeconds: number;
  body: string;
  id: string;
  signal?: AbortSignal;
}
export async function postServerEvent(
  input: DeliveryRequest,
  testDispatcher?: Dispatcher,
): Promise<number> {
  // Validate only configuration fields; payload and delivery metadata never enter the URL schema.
  const config = assistantServerSchema.safeParse({
    url: input.url,
    timeoutSeconds: input.timeoutSeconds,
  });
  if (!config.success || !config.data.url)
    throw new DeliveryError("Invalid webhook URL configuration.", false);
  const hostname = new URL(input.url).hostname.replace(/^\[|\]$/g, "");
  if (isIP(hostname) && !publicAddress(hostname))
    throw new DeliveryError("Webhook destination must be public.", false);
  let destinationError: unknown;
  const pinnedLookup: LookupFunction = (host, options, callback) => {
    void publicLookup(host)
      .then((addresses) => {
        if (options.all) callback(null, addresses);
        else callback(null, addresses[0].address, addresses[0].family);
      })
      .catch((error) => {
        destinationError = error;
        callback(error, "", 4);
      });
  };
  const dispatcher =
    testDispatcher ??
    new Agent({ connect: { lookup: pinnedLookup }, connections: 1 });
  const timeoutMs = Math.ceil(input.timeoutSeconds * 1000);
  const timeout = AbortSignal.timeout(timeoutMs);
  try {
    const response = await request(input.url, {
      dispatcher,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": input.id,
      },
      body: input.body,
      signal: input.signal ? AbortSignal.any([input.signal, timeout]) : timeout,
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
    });
    response.body.destroy();
    if (response.statusCode < 200 || response.statusCode >= 300)
      throw new DeliveryError(
        `Webhook returned HTTP ${response.statusCode}.`,
        [408, 425, 429].includes(response.statusCode) ||
          response.statusCode >= 500,
        response.statusCode,
        retryAfter(response.headers["retry-after"]),
      );
    return response.statusCode;
  } catch (error) {
    if (destinationError instanceof DeliveryError) throw destinationError;
    if (error instanceof DeliveryError) throw error;
    throw new DeliveryError(
      timeout.aborted
        ? "Webhook request timed out."
        : "Webhook connection failed.",
      true,
    );
  } finally {
    if (!testDispatcher) await dispatcher.destroy();
  }
}

import "server-only";
import { headers } from "next/headers";

export class BackendError extends Error {
  constructor(readonly status: number, message: string, readonly retryAfter?: string) {
    super(message);
  }
}

export function backendUrl(path: string): string {
  const origin = process.env.BACKEND_API_URL;
  if (!origin) throw new Error("BACKEND_API_URL is required.");
  const url = new URL(origin);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
      !["http:", "https:"].includes(url.protocol) ||
      (process.env.NODE_ENV === "production" && url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname))) {
    throw new Error("BACKEND_API_URL must be an HTTPS origin in production.");
  }
  return `${url.origin}${path}`;
}

export async function backendFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(backendUrl(path), {
    ...init,
    cache: "no-store",
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
}

export async function authRequest<T>(path: string, data: unknown): Promise<T> {
  const secret = process.env.AUTH_API_SECRET;
  if (!secret || secret.length < 32) throw new Error("AUTH_API_SECRET must contain at least 32 characters.");
  const incoming = await headers();
  const clientIp = process.env.VERCEL === "1"
    ? incoming.get("x-forwarded-for")?.split(",")[0].trim() || "unknown"
    : "local";
  const response = await backendFetch(`/api/v1/auth/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-auth-client-secret": secret,
      "x-auth-client-ip": clientIp,
    },
    body: JSON.stringify(data),
  });
  const body = await response.json();
  if (!response.ok) throw new BackendError(response.status, body.error || "Authentication failed.", response.headers.get("retry-after") ?? undefined);
  return body as T;
}

export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  const expected = process.env.NEXTAUTH_URL;
  return origin === new URL(expected || request.url).origin;
}

import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { getToken } from "next-auth/jwt";
import { redirect } from "next/navigation";
import type { AuthUser } from "./auth";
import { backendFetch } from "./backend";

export async function backendSessionToken(): Promise<string | null> {
  const incoming = await cookies();
  const token = await getToken({
    req: {
      headers: {},
      cookies: Object.fromEntries(incoming.getAll().map(({ name, value }) => [name, value])),
    } as Parameters<typeof getToken>[0]["req"],
    secret: process.env.NEXTAUTH_SECRET,
  });
  if (!token?.backendToken || !token.backendExpiresAt || Date.parse(token.backendExpiresAt) <= Date.now()) return null;
  return token.backendToken;
}

export const currentUser = cache(async (): Promise<AuthUser | null> => {
  const token = await backendSessionToken();
  if (!token) return null;
  const response = await backendFetch("/api/v1/auth/session", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error("Authentication is temporarily unavailable. Please try again.");
  return ((await response.json()) as { user: AuthUser }).user;
});

export async function requireUser(): Promise<AuthUser> {
  const user = await currentUser();
  if (!user) redirect("/login");
  return user;
}

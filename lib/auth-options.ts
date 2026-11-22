import "server-only";
import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import { loginSchema, SESSION_MAX_AGE, type AuthSession } from "./auth";
import { authRequest, backendFetch, BackendError } from "./backend";

export const authOptions: NextAuthOptions = {
  secret: process.env.NEXTAUTH_SECRET,
  session: { strategy: "jwt", maxAge: SESSION_MAX_AGE },
  pages: { signIn: "/login", error: "/login" },
  providers: [
    CredentialsProvider({
      name: "Email and password",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const parsed = loginSchema.safeParse(credentials);
        if (!parsed.success) return null;
        try {
          const session = await authRequest<AuthSession>("login", parsed.data);
          return { ...session.user, backendToken: session.token, backendExpiresAt: session.expiresAt };
        } catch (error) {
          if (error instanceof BackendError && error.status === 401) return null;
          if (error instanceof BackendError && error.status === 429) throw new Error("RateLimited");
          throw new Error("ServiceUnavailable");
        }
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.backendToken = user.backendToken;
        token.backendExpiresAt = user.backendExpiresAt;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) session.user.id = token.sub!;
      if (token.backendExpiresAt) session.expires = token.backendExpiresAt;
      return session;
    },
    async redirect({ url, baseUrl }) {
      if (url.startsWith("/") && !url.startsWith("//")) return `${baseUrl}${url}`;
      if (new URL(url, baseUrl).origin === baseUrl) return url;
      return `${baseUrl}/dashboard`;
    },
  },
  events: {
    async signOut({ token }) {
      if (!token?.backendToken) return;
      try {
        const response = await backendFetch("/api/v1/auth/session", {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token.backendToken}` },
        });
        if (!response.ok && response.status !== 401) console.error("auth.session_revocation_failed");
      } catch {
        console.error("auth.session_revocation_failed");
      }
    },
  },
};

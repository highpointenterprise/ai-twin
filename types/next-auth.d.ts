import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: DefaultSession["user"] & { id: string };
  }
  interface User {
    backendToken: string;
    backendExpiresAt: string;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    backendToken?: string;
    backendExpiresAt?: string;
  }
}

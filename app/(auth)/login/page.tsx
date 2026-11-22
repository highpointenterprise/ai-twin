import type { Metadata } from "next";
import { AuthForm } from "@/app/components/auth-form";

export const metadata: Metadata = { title: "Log in · AI Twin" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ registered?: string }> }) {
  const { registered } = await searchParams;
  return <AuthForm mode="login" registered={registered === "1"} />;
}

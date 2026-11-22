import type { Metadata } from "next";
import { AuthForm } from "@/app/components/auth-form";

export const metadata: Metadata = { title: "Sign up · AI Twin" };

export default function SignupPage() {
  return <AuthForm mode="signup" />;
}

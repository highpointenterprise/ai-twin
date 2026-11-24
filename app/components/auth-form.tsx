"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { signIn } from "next-auth/react";
import { loginSchema, signupSchema } from "@/lib/auth";

export function AuthForm({ mode, registered = false }: { mode: "login" | "signup"; registered?: boolean }) {
  const signup = mode === "signup";
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setError("");
    const fields = new FormData(event.currentTarget);
    const input = (signup ? signupSchema : loginSchema).safeParse(Object.fromEntries(fields));
    if (!input.success) { setError(input.error.issues[0].message); return; }
    if (signup && input.data.password !== fields.get("confirmPassword")) {
      setError("Your passwords do not match.");
      return;
    }
    setPending(true);
    try {
      if (signup) {
        const response = await fetch("/api/signup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input.data),
        });
        const body = await response.json();
        if (!response.ok) { setError(body.error || "Unable to create your account."); return; }
        router.replace("/login?registered=1");
        return;
      }
      const result = await signIn("credentials", {
        email: input.data.email,
        password: input.data.password,
        code: fields.get("code") || undefined,
        redirect: false,
        callbackUrl: "/dashboard",
      });
      if (result?.ok && !result.error) {
        router.replace("/dashboard");
        router.refresh();

      } else {
        setError(result?.error === "CredentialsSignin" ? "Invalid email or password."
          : result?.error === "EmailNotVerified" ? "Verify your email before signing in. Use the Verify email link below to request a new link."
          : result?.error === "MfaRequired" ? "Enter your authenticator or recovery code."
          : result?.error === "MfaInvalid" ? "Invalid or already used security code."
          : result?.error === "RateLimited" ? "Too many attempts. Please try again later."
          : "Login is temporarily unavailable. Please try again.");
      }
    } catch {
      setError("Unable to connect. Please try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">{signup ? "Create your account" : "Welcome back"}</h1>
      <p className="mt-2 text-sm text-zinc-500">{signup ? "Get started with AI Twin." : "Log in to your AI Twin workspace."}</p>
      {registered && <p role="status" className="notice success mt-5">Check your inbox to verify your email before logging in. If you already have an account, log in or reset your password.</p>}
      <form onSubmit={submit} className="mt-7 space-y-4" aria-busy={pending}>
        {signup && (
          <label htmlFor="name">Full name
            <input id="name" name="name" autoComplete="name" maxLength={80} required disabled={pending} placeholder="Your name" />
          </label>
        )}
        <label htmlFor="email">Email address
          <input id="email" name="email" type="email" autoComplete="email" maxLength={254} required disabled={pending} placeholder="you@example.com" autoCapitalize="none" spellCheck={false} />
        </label>
        <label htmlFor="password">Password
          <input id="password" name="password" type="password" autoComplete={signup ? "new-password" : "current-password"} minLength={signup ? 12 : 1} maxLength={128} required disabled={pending} aria-describedby={signup ? "password-help" : undefined} />
        </label>
        {signup && (
          <>
            <p id="password-help" className="-mt-2 text-xs text-zinc-500">Use 12–128 characters.</p>
            <label htmlFor="confirmPassword">Confirm password
              <input id="confirmPassword" name="confirmPassword" type="password" autoComplete="new-password" maxLength={128} required disabled={pending} />
            </label>
          </>
        )}
        {!signup && <label htmlFor="code">Authenticator or recovery code (if enabled)
          <input id="code" name="code" autoComplete="one-time-code" maxLength={32} disabled={pending} />
        </label>}
        {error && <p role="alert" className="error text-sm">{error}</p>}
        <button type="submit" className="w-full transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2" disabled={pending}>
          {pending ? (signup ? "Creating account…" : "Logging in…") : (signup ? "Create account" : "Log in")}
        </button>
      </form>
      {!signup && <div className="mt-5 flex justify-between text-sm"><Link href="/forgot-password">Forgot password?</Link><Link href="/resend-verification">Verify email</Link></div>}
      <p className="mt-6 text-center text-sm text-zinc-500">
        {signup ? "Already have an account? " : "New to AI Twin? "}
        <Link className="font-medium text-zinc-900" href={signup ? "/login" : "/signup"}>{signup ? "Log in" : "Create an account"}</Link>
      </p>
    </>
  );
}

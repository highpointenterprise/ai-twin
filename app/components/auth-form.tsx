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
    let created = false;
    try {
      if (signup) {
        const response = await fetch("/api/signup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input.data),
        });
        const body = await response.json();
        if (!response.ok) { setError(body.error || "Unable to create your account."); return; }
        created = true;
      }
      const result = await signIn("credentials", {
        email: input.data.email,
        password: input.data.password,
        redirect: false,
        callbackUrl: "/dashboard",
      });
      if (result?.ok && !result.error) {
        router.replace("/dashboard");
        router.refresh();
      } else if (created) {
        router.replace("/login?registered=1");
      } else {
        setError(result?.error === "CredentialsSignin" ? "Invalid email or password."
          : result?.error === "RateLimited" ? "Too many attempts. Please try again later."
          : "Login is temporarily unavailable. Please try again.");
      }
    } catch {
      if (created) router.replace("/login?registered=1");
      else setError("Unable to connect. Please try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">{signup ? "Create your account" : "Welcome back"}</h1>
      <p className="mt-2 text-sm text-zinc-500">{signup ? "Get started with AI Twin." : "Log in to your AI Twin workspace."}</p>
      {registered && <p role="status" className="notice success mt-5">Your account is ready. Log in to continue.</p>}
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
        {error && <p role="alert" className="error text-sm">{error}</p>}
        <button type="submit" className="w-full transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2" disabled={pending}>
          {pending ? (signup ? "Creating account…" : "Logging in…") : (signup ? "Create account" : "Log in")}
        </button>
      </form>
      <p className="mt-6 text-center text-sm text-zinc-500">
        {signup ? "Already have an account? " : "New to AI Twin? "}
        <Link className="font-medium text-zinc-900" href={signup ? "/login" : "/signup"}>{signup ? "Log in" : "Create an account"}</Link>
      </p>
    </>
  );
}

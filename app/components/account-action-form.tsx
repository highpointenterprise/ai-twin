"use client";
import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
type Action = "forgot-password" | "reset-password" | "verify-email" | "resend-verification" | "confirm-email";
const titles: Record<Action, string> = { "forgot-password": "Forgot password", "reset-password": "Reset your password", "verify-email": "Verify your email", "resend-verification": "Request verification email", "confirm-email": "Confirm your new email" };
export function AccountActionForm({ action }: { action: Action }) {
  const [token, setToken] = useState(""), [pending, setPending] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const requestLink = action === "forgot-password" || action === "resend-verification";
  useEffect(() => {
    setToken(new URLSearchParams(window.location.hash.slice(1)).get("token") || "");
    window.history.replaceState(null, "", window.location.pathname);
  }, []);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); if (pending) return;
    const fields = new FormData(e.currentTarget);
    if (action === "reset-password" && fields.get("password") !== fields.get("confirmPassword")) { setError("Your passwords do not match."); return; }
    setPending(true); setError("");
    try {
      const response = await fetch(`/api/account-auth/${action}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(requestLink ? { email: fields.get("email") } : { token, ...(action === "reset-password" ? { password: fields.get("password") } : {}) }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Unable to complete your request.");
      setNotice(requestLink ? result.message : "Your account has been updated. Sign in to continue.");
      if (!requestLink) setToken("");
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to connect. Please try again."); }
    finally { setPending(false); }
  }
  return <>
    <h1 className="text-2xl font-semibold">{titles[action]}</h1>
    <p className="mt-3 text-sm text-zinc-500">{requestLink ? "Enter your email address and we will send you the next steps if your account is eligible." : "Confirm below to complete your request. Links can be used only once."}</p>
    {notice && <p role="status" className="notice success mt-4">{notice}</p>}
    {!notice && !requestLink && !token && <p className="notice mt-4">Open the complete link from your email. If it has expired, request a new link.</p>}
    {(requestLink || token) && <form onSubmit={submit} className="mt-6 space-y-4" aria-busy={pending}>
      {requestLink && <label>Email address<input name="email" type="email" autoComplete="email" maxLength={254} required disabled={pending} /></label>}
      {action === "reset-password" && <><label>New password<input name="password" type="password" autoComplete="new-password" minLength={12} maxLength={128} required disabled={pending} /></label><label>Confirm new password<input name="confirmPassword" type="password" autoComplete="new-password" maxLength={128} required disabled={pending} /></label><p className="text-sm text-zinc-500">Use 12–128 characters. This signs out all sessions and invalidates existing API keys. Two-factor authentication stays enabled.</p></>}
      <button type="submit" className="w-full" disabled={pending}>{pending ? "Working…" : requestLink ? "Send email" : action === "reset-password" ? "Reset password" : "Confirm"}</button>
    </form>}
    {error && <p role="alert" className="notice error mt-4">{error}</p>}
    <div className="mt-6 flex flex-wrap gap-4 text-sm"><Link href="/login">Back to login</Link>{!requestLink && <Link href={action === "reset-password" ? "/forgot-password" : action === "confirm-email" ? "/dashboard" : "/resend-verification"}>Request a new link</Link>}</div>
  </>;
}

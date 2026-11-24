"use client";
import { useEffect, useState, type FormEvent } from "react";
import { signOut } from "next-auth/react";
import type { AccountSession, AuthUser, SecurityEvent } from "@/lib/auth";
interface Account { user: AuthUser; sessions: AccountSession[]; activity: SecurityEvent[] }
async function request<T>(path = "", method = "GET", data?: unknown): Promise<T> {
  const response = await fetch(`/api/account${path}`, { method, headers: { "Content-Type": "application/json" }, ...(data === undefined ? {} : { body: JSON.stringify(data) }), cache: "no-store" });
  if (response.status === 204) return undefined as T;
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Unable to update your account.");
  return body as T;
}
function Proof({ mfa }: { mfa: boolean }) {
  return <><label>Current password<input type="password" name="currentPassword" autoComplete="current-password" maxLength={128} required /></label>{mfa && <label>Authenticator or recovery code<input name="code" autoComplete="one-time-code" maxLength={32} required /></label>}</>;
}
export function AccountSettings({ onUser }: { onUser: (user: AuthUser) => void }) {
  const [account, setAccount] = useState<Account | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null), [recovery, setRecovery] = useState<string[]>([]);
  useEffect(() => { let active = true; void request<Account>().then(a => { if (active) setAccount(a); }).catch(e => { if (active) setError(e.message); }); return () => { active = false; }; }, []);
  const logout = () => signOut({ callbackUrl: "/login" });
  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : "Unable to update your account."); } finally { setBusy(false); }
  }
  function form(e: FormEvent<HTMLFormElement>, action: (data: Record<string, FormDataEntryValue>) => Promise<void>) {
    e.preventDefault(); const element = e.currentTarget, data = Object.fromEntries(new FormData(element));
    void run(async () => { await action(data); element.reset(); });
  }
  if (recovery.length) return <section className="editor account-settings"><h3>Save your recovery codes</h3><p>Two-factor authentication is enabled. Each code works once. Store these somewhere private; they will not be shown again.</p><div className="recovery-codes">{recovery.map(code => <code key={code}>{code}</code>)}</div><p>All sessions and existing API keys have been invalidated.</p><button onClick={() => { setRecovery([]); void logout(); }}>I saved my codes — sign in again</button></section>;
  return <div className="account-settings">
    {error && <p role="alert" className="notice error">{error}</p>}{notice && <p role="status" className="notice success">{notice}</p>}
    {!account ? <p>{error ? "Sign in again if your session has expired." : "Loading account settings…"}</p> : <>
      <section className="editor"><h3>Profile</h3><p>{account.user.email} · {account.user.emailVerified ? "Verified" : "Unverified"}</p><form onSubmit={e => form(e, async data => { const result = await request<{ user: AuthUser }>("/profile", "PATCH", data); setAccount({ ...account, user: result.user }); onUser(result.user); setNotice("Profile saved."); })}><fieldset disabled={busy}><label>Full name<input name="name" defaultValue={account.user.name} maxLength={80} required /></label><button>Save profile</button></fieldset></form></section>
      <section className="editor"><h3>Email address</h3><p>Your existing email remains active until you confirm the new address. Confirmation signs out all sessions and invalidates existing API keys.</p><form onSubmit={e => form(e, async data => { const result = await request<{ message: string }>("/email", "POST", data); setNotice(result.message); })}><fieldset disabled={busy}><label>New email address<input name="email" type="email" autoComplete="email" maxLength={254} required /></label><Proof mfa={account.user.mfaEnabled} /><button>Send confirmation email</button></fieldset></form></section>
      <section className="editor"><h3>Password</h3><p>Use a unique password of 12–128 characters. Changing it signs out all sessions and invalidates existing API keys.</p><form onSubmit={e => form(e, async data => { if (data.password !== data.confirmPassword) throw new Error("Your passwords do not match."); await request("/password", "POST", data); await logout(); })}><fieldset disabled={busy}><Proof mfa={account.user.mfaEnabled} /><label>New password<input name="password" type="password" autoComplete="new-password" minLength={12} maxLength={128} required /></label><label>Confirm new password<input name="confirmPassword" type="password" autoComplete="new-password" maxLength={128} required /></label><button>Change password</button></fieldset></form></section>
      <section className="editor"><h3>Two-factor authentication</h3><p>{account.user.mfaEnabled ? "Enabled. Your authenticator or a recovery code is required to sign in and make sensitive changes." : "Add an authenticator app to protect your account with a second factor."}</p><p>Enabling or disabling two-factor authentication signs out all sessions and invalidates existing API keys.</p>
        {setup ? <><p>In your authenticator app, add a time-based account using this setup key.</p><code className="setup-key">{setup.secret}</code><form onSubmit={e => form(e, async data => { const result = await request<{ recoveryCodes: string[] }>("/mfa/enable", "POST", data); setSetup(null); setRecovery(result.recoveryCodes); })}><fieldset disabled={busy}><label>Six-digit authenticator code<input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required /></label><button>Enable two-factor authentication</button><button type="button" className="ghost" onClick={() => setSetup(null)}>Cancel setup</button></fieldset></form></> : <form onSubmit={e => form(e, async data => { if (account.user.mfaEnabled) { await request("/mfa/disable", "POST", data); await logout(); } else setSetup(await request("/mfa/setup", "POST", data)); })}><fieldset disabled={busy}><Proof mfa={account.user.mfaEnabled} /><button>{account.user.mfaEnabled ? "Disable two-factor authentication" : "Set up authenticator"}</button></fieldset></form>}
      </section>
      <section className="editor"><h3>Active sessions</h3><p>Sessions expire after 24 hours of inactivity or seven days. Sign out any device you do not recognize.</p><button className="ghost" disabled={busy} onClick={() => void run(async () => { await request("/sessions/revoke-others", "POST", {}); setAccount(await request<Account>()); setNotice("Other sessions signed out."); })}>Sign out other sessions</button><ul className="account-list">{account.sessions.map(session => <li key={session.id}><div><strong>{session.current ? "This session" : "Other session"}</strong><p>{session.userAgent || "Unknown device"}</p><small>Last active {new Date(session.lastSeenAt).toLocaleString()}</small></div><button className="ghost" disabled={busy} onClick={() => void run(async () => { await request(`/sessions/${session.id}`, "DELETE"); if (session.current) await logout(); else setAccount(await request<Account>()); })}>Sign out</button></li>)}</ul></section>
      <section className="editor"><h3>Recent security activity</h3><ul className="account-list">{account.activity.map(event => <li key={event.id}><span>{event.action.replaceAll(/[._]/g, " ")}</span><time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString()}</time></li>)}</ul></section>
    </>}
  </div>;
}

"use client";
import { useState } from "react";
import type {
  TwilioConnectionResult,
  TwilioConnectionStatus,
} from "../../lib/twilio";
import { api } from "./api";

export function TwilioConnection({
  connection,
  onConnected,
}: {
  connection: TwilioConnectionStatus | null;
  onConnected: (result: TwilioConnectionResult) => void;
}) {
  const [accountSid, setAccountSid] = useState(connection?.accountSid ?? "");
  const [authToken, setAuthToken] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const connect = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await api<TwilioConnectionResult>(
        "/integrations/twilio",
        "PUT",
        { accountSid: accountSid.trim(), authToken: authToken.trim() },
      );
      setAuthToken("");
      onConnected(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not connect to Twilio.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section>
      <div className="section-head">
        <div>
          <p className="eyebrow">TELEPHONY</p>
          <h2>Connect Twilio</h2>
        </div>
        <span className="badge">
          {connection?.configured ? "Credentials configured" : "Not connected"}
        </span>
      </div>
      <p className="hint">
        Enter the Account SID and Auth Token from your Twilio Console. We'll
        verify your account and load its phone numbers.
      </p>
      {connection?.configured && (
        <p className="hint">
          Current account: <span className="mono">{connection.accountSid}</span>{" "}
          ·{" "}
          {connection.source === "workspace"
            ? "Saved in this workspace"
            : "Configured on the server"}
          . Enter a new token to update the connection.
        </p>
      )}
      <form
        className="fields"
        onSubmit={(e) => {
          e.preventDefault();
          void connect();
        }}
      >
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <div className="row">
          <label>
            Twilio Account SID
            <input
              name="twilioAccountSid"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              value={accountSid}
              onChange={(e) => setAccountSid(e.target.value)}
              placeholder="AC…"
              pattern="AC[a-fA-F0-9]{32}"
              title="Account SID: AC followed by 32 hexadecimal characters"
              required
              disabled={busy}
            />
          </label>
          <label>
            Twilio Auth Token
            <input
              name="twilioAuthToken"
              type="password"
              autoComplete="new-password"
              autoCapitalize="none"
              spellCheck={false}
              value={authToken}
              onChange={(e) => setAuthToken(e.target.value)}
              placeholder={
                connection?.configured
                  ? "Enter a token to replace the saved connection"
                  : "Your Twilio Auth Token"
              }
              pattern="[a-fA-F0-9]{32}"
              title="32-character Twilio Auth Token"
              required
              disabled={busy}
            />
          </label>
        </div>
        <p className="hint">
          Credentials are saved on the server and take effect immediately. Your
          token is never returned to this page. Loading numbers only requires
          Twilio; AI calls also need the voice providers configured above.
        </p>
        <button disabled={busy}>
          {busy ? "Connecting…" : "Connect & load numbers"}
        </button>
      </form>
    </section>
  );
}

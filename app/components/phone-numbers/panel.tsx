"use client";
import { useState } from "react";
import type { AgentConfig, PhoneNumberView } from "@/lib/types";
import type {
  TwilioConnectionStatus,
  TwilioConnectionResult,
} from "@/lib/twilio";
import { api } from "../api";
import { TwilioConnection } from "../twilio-connection";
import { PurchaseNumber } from "./purchase";

function NumberRow({
  number,
  agents,
  disabled,
  onUpdate,
  onCall,
  onBusy,
}: {
  number: PhoneNumberView;
  agents: AgentConfig[];
  disabled: boolean;
  onUpdate: (number: PhoneNumberView) => void;
  onCall: (number: string) => void;
  onBusy: (busy: boolean) => void;
}) {
  const [label, setLabel] = useState(number.label);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function update(path: string, method: string, body: unknown) {
    setBusy(true);
    onBusy(true);
    setError("");
    try {
      onUpdate(await api<PhoneNumberView>(path, method, body));
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not update this number.",
      );
    } finally {
      setBusy(false);
      onBusy(false);
    }
  }
  return (
    <article className="phone-card fields">
      <div className="section-head">
        <h3>{number.phoneNumber}</h3>
        <span className="badge">
          {number.routingStatus === "ready"
            ? "Inbound route ready"
            : number.agentId
              ? "Route needs update"
              : "Unassigned"}
        </span>
      </div>
      <p className="hint">
        {number.capabilities?.voice === false ? "No voice support" : "Voice"}
        {number.capabilities?.sms ? " · SMS" : ""}
        {number.capabilities?.mms ? " · MMS" : ""}
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void update(`/numbers/${number.sid}`, "PATCH", { label });
        }}
        className="row"
      >
        <label>
          Number name
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            required
            maxLength={64}
            disabled={disabled || busy}
          />
        </label>
        <button
          className="ghost"
          disabled={disabled || busy || label === number.label}
        >
          Save name
        </button>
      </form>
      <div className="row">
        <label>
          Inbound assistant
          <select
            aria-label={`Inbound assistant for ${number.phoneNumber}`}
            value={number.agentId ?? ""}
            disabled={disabled || busy || number.capabilities?.voice === false}
            onChange={(e) =>
              void update(`/numbers/${number.sid}/assign`, "POST", {
                agentId: e.target.value || null,
              })
            }
          >
            <option value="">No assistant</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        {number.agentId && (
          <button
            className="ghost"
            disabled={disabled || busy}
            onClick={() =>
              void update(`/numbers/${number.sid}/assign`, "POST", {
                agentId: number.agentId,
              })
            }
          >
            Refresh inbound route
          </button>
        )}
        <button
          className="ghost"
          disabled={disabled || busy || number.capabilities?.voice === false}
          onClick={() => onCall(number.phoneNumber)}
        >
          Make a call
        </button>
      </div>
      {number.voiceUrl && (
        <p className="hint phone-url">Voice webhook: {number.voiceUrl}</p>
      )}
      {busy && <p role="status">Updating number…</p>}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </article>
  );
}

export function PhoneNumbersPanel({
  connection,
  numbers,
  agents,
  loading,
  onConnected,
  onRefresh,
  onNumbers,
  onCall,
}: {
  connection: TwilioConnectionStatus | null;
  numbers: PhoneNumberView[];
  agents: AgentConfig[];
  loading: boolean;
  onConnected: (result: TwilioConnectionResult) => void;
  onRefresh: () => Promise<void>;
  onNumbers: (
    update: (numbers: PhoneNumberView[]) => PhoneNumberView[],
  ) => void;
  onCall: (number: string) => void;
}) {
  const [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
  const replace = (number: PhoneNumberView) =>
    onNumbers((all) =>
      [...all.filter((n) => n.sid !== number.sid), number].sort((a, b) =>
        a.phoneNumber.localeCompare(b.phoneNumber),
      ),
    );
  return (
    <div className="fields">
      <fieldset disabled={busy || loading}>
        <TwilioConnection connection={connection} onConnected={onConnected} />
      </fieldset>
      {notice && <p role="status">{notice}</p>}
      <section className="fields">
        <div className="section-head">
          <h2>Your Twilio numbers ({numbers.length})</h2>
          <button
            className="ghost"
            disabled={!connection?.configured || loading || busy}
            onClick={() => void onRefresh()}
          >
            {loading ? "Loading numbers…" : "Refresh numbers"}
          </button>
        </div>
        <p className="hint">
          Assigning an assistant configures Twilio's voice webhook for this
          workspace and replaces any existing voice application or SIP trunk
          routing. Refresh the route after your public backend URL changes.
        </p>
        {!numbers.length && (
          <p className="empty">
            {loading
              ? "Loading phone numbers…"
              : connection?.configured
                ? "No phone numbers yet. Buy one below or refresh to import numbers from Twilio."
                : "Connect Twilio to load and manage your phone numbers."}
          </p>
        )}
        {numbers.map((n) => (
          <NumberRow
            key={`${connection?.accountSid}:${n.sid}:${n.label}`}
            number={n}
            agents={agents}
            disabled={busy || loading}
            onUpdate={replace}
            onCall={onCall}
            onBusy={setBusy}
          />
        ))}
      </section>
      {connection?.configured && (
        <PurchaseNumber
          disabled={busy || loading}
          onBusy={setBusy}
          onPurchased={(n) => {
            replace(n);
            setNotice(
              `${n.phoneNumber} is ready. Assign an assistant to receive calls.`,
            );
          }}
        />
      )}
    </div>
  );
}

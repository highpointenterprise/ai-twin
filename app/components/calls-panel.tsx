"use client";
import { useEffect, useState } from "react";
import type {
  AgentConfig,
  CallRecord,
  CallTraceView,
  PhoneNumberView,
} from "../../lib/types";
import { api } from "./api";
interface TransferView {
  id: string;
  phase: string;
  reason?: string;
  operatorSid?: string;
  destination: string;
  recoveryAttempts: number;
  lastError?: string;
}
export function CallsPanel({
  agents,
  numbers,
  onError,
}: {
  agents: AgentConfig[];
  numbers: PhoneNumberView[];
  onError: (s: string) => void;
}) {
  const [calls, setCalls] = useState<CallRecord[]>([]),
    [selected, setSelected] = useState("");
  const [transfer, setTransfer] = useState<TransferView | null>(null);
  const [trace, setTrace] = useState<CallTraceView | null>(null);
  const [agentId, setAgent] = useState(agents[0]?.id ?? ""),
    [to, setTo] = useState(""),
    [from, setFrom] = useState(""),
    [context, setContext] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let disposed = false;
    const load = async () => {
      try {
        const c = await api<CallRecord[]>("/calls");
        if (!disposed) setCalls(c);
        if (selected) {
          const t = await api<CallTraceView>(`/calls/${selected}/trace`).catch(
            () => null,
          );
          const transfer = await api<TransferView | null>(
            `/calls/${selected}/transfer`,
          ).catch(() => null);
          if (!disposed) {
            setTrace(t);
            setTransfer(transfer);
          }
        }
      } catch (e) {
        if (!disposed)
          onError(e instanceof Error ? e.message : "Cannot load calls.");
      }
    };
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [selected, onError]);
  const start = async () => {
    setBusy(true);
    try {
      const call = await api<CallRecord>("/calls", "POST", {
        agentId,
        to,
        from: from || undefined,
        context: context || undefined,
      });
      setTrace(null);
      setTransfer(null);
      setSelected(call.sid);
      setCalls((c) => [call, ...c]);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Call failed.");
    } finally {
      setBusy(false);
    }
  };
  const active = calls.find((c) => c.sid === selected);
  return (
    <div className="fields">
      <div className="section-head">
        <div>
          <p className="eyebrow">TWILIO TELEPHONY</p>
          <h2>Calls</h2>
        </div>
        <span className="badge">{calls.length} recent</span>
      </div>
      <section>
        <h3>New outbound call</h3>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void start();
          }}
        >
          <div className="row">
            <label>
              Assistant
              <select
                value={agentId}
                onChange={(e) => setAgent(e.target.value)}
              >
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              From number
              <select value={from} onChange={(e) => setFrom(e.target.value)}>
                <option value="">Assistant's assigned number</option>
                {numbers.map((n) => (
                  <option key={n.sid} value={n.phoneNumber}>
                    {n.phoneNumber}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label>
            Destination number
            <input
              type="tel"
              placeholder="+14155550123"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              required
            />
          </label>
          <label>
            Call context (optional)
            <textarea
              value={context}
              onChange={(e) => setContext(e.target.value)}
              placeholder="Purpose, customer details, or instructions for this call"
            />
          </label>
          <button disabled={busy || !agentId}>
            {busy ? "Starting…" : "Start call"}
          </button>
        </form>
      </section>
      <section>
        <h3>Inbound & outbound history</h3>
        {!calls.length ? (
          <p className="empty">
            Your calls will appear here with status, transcript, and tool
            activity.
          </p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Direction</th>
                  <th>Customer</th>
                  <th>Status</th>
                  <th>Outcome</th>
                </tr>
              </thead>
              <tbody>
                {calls.map((c) => (
                  <tr
                    key={c.sid}
                    className={selected === c.sid ? "selected" : ""}
                  >
                    <td>
                      <button
                        className="text-button"
                        onClick={() => {
                          setSelected(c.sid);
                          setTrace(null);
                          setTransfer(null);
                        }}
                      >
                        {c.parentCallSid ? "Consultation" : c.direction}
                      </button>
                    </td>
                    <td>{c.direction === "outbound" ? c.to : c.from}</td>
                    <td>{c.status}</td>
                    <td>{c.endedReason ?? c.answeredBy ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {active && (
        <section>
          <div className="section-head">
            <h3>Call detail</h3>
            {!["completed", "failed"].includes(active.status) && (
              <button
                className="danger"
                onClick={() =>
                  void api(`/calls/${active.sid}/end`, "POST", {}).catch((e) =>
                    onError(e.message),
                  )
                }
              >
                End call
              </button>
            )}
          </div>
          <p className="mono subtle">{active.sid}</p>
          <p>
            {active.status}{" "}
            {active.screeningEncountered ? "· Screening encountered" : ""}{" "}
            {active.transferStatus
              ? `· Transfer: ${active.transferStatus}`
              : ""}
          </p>
          {active.parentCallSid && (
            <p>
              <button
                className="text-button"
                onClick={() => {
                  setSelected(active.parentCallSid!);
                  setTrace(null);
                  setTransfer(null);
                }}
              >
                View original caller
              </button>
            </p>
          )}
          {transfer && (
            <fieldset>
              <legend>Warm transfer</legend>
              <p>
                {transfer.phase.replaceAll("-", " ")} · {transfer.destination}
                {transfer.reason ? ` · ${transfer.reason}` : ""}
              </p>
              {transfer.operatorSid && (
                <button
                  className="ghost"
                  onClick={() => {
                    setSelected(transfer.operatorSid!);
                    setTrace(null);
                    setTransfer(null);
                  }}
                >
                  View recipient consultation
                </button>
              )}
              {transfer.phase === "recovery-failed" && (
                <>
                  <p role="alert" className="error">
                    Caller recovery could not be confirmed. {transfer.lastError}{" "}
                    Check the live Twilio call before retrying or ending it.
                  </p>
                  <button
                    onClick={() =>
                      void api<TransferView>(
                        `/calls/${active.sid}/transfer/retry`,
                        "POST",
                        {},
                      )
                        .then(setTransfer)
                        .catch((e) => onError(e.message))
                    }
                  >
                    Retry caller recovery
                  </button>
                </>
              )}
            </fieldset>
          )}
          {trace ? (
            <>
              <ol className="transcript">
                {trace.transcript.map((l, i) => (
                  <li className={l.role} key={i}>
                    <b>{l.role}</b>
                    {l.text}
                  </li>
                ))}
              </ol>
              <details>
                <summary>
                  Events & tool activity ({trace.events.length})
                </summary>
                <pre>
                  {trace.events
                    .map(
                      (e) =>
                        `${new Date(e.at).toLocaleTimeString()} ${e.event} ${JSON.stringify(e.detail)}`,
                    )
                    .join("\n")}
                </pre>
              </details>
            </>
          ) : (
            <p className="hint">
              No trace is available in this server session.
            </p>
          )}
        </section>
      )}
    </div>
  );
}

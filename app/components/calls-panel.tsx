"use client";
import { useEffect, useState } from "react";
import type {
  AgentConfig,
  CallRecord,
  CallCost,
  PhoneNumberView,
} from "../../lib/types";
import { api } from "./api";
import { callOutcome } from "../../lib/call-outcomes";
import { CallRecordings } from "./call-recordings";
import { CallServerEvents } from "./call-server-events";
import { useCallTrace } from "./use-call-trace";
import { CallLog, downloadCallLogs } from "./call-log";
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
  initialFrom = "",
}: {
  agents: AgentConfig[];
  numbers: PhoneNumberView[];
  onError: (s: string) => void;
  initialFrom?: string;
}) {
  const [calls, setCalls] = useState<CallRecord[]>([]),
    [selected, setSelected] = useState("");
  const [cursor, setCursor] = useState("");
  const [previousPages, setPreviousPages] = useState<string[]>([]);
  const [nextCursor, setNextCursor] = useState("");
  const [transfer, setTransfer] = useState<TransferView | null>(null);
  const { trace, loading: traceLoading, error: traceError } = useCallTrace(selected);
  const [agentId, setAgent] = useState(agents[0]?.id ?? ""),
    [to, setTo] = useState(""),
    [from, setFrom] = useState(initialFrom),
    [context, setContext] = useState("");
  const [busy, setBusy] = useState(false);
  const [artifactMessage, setArtifactMessage] = useState("");
  const downloadArtifact = async (
    sid: string,
    kind: "transcript" | "logs" | "recording",
  ) => {
    setArtifactMessage("");
    const tab = window.open("about:blank", "_blank");
    if (tab) tab.opener = null;
    try {
      const response = await fetch(
        `/api/backend/calls/${encodeURIComponent(sid)}/artifacts/${kind}`,
      );
      if (response.status === 404) {
        tab?.close();
        setArtifactMessage(
          `${kind === "recording" ? "Recording" : kind === "logs" ? "Logs" : "Transcript"} is still processing or unavailable for this call.`,
        );
        return;
      }
      if (!response.ok) throw new Error("Cannot download this call artifact.");
      const { url } = (await response.json()) as { url: string };
      const target = new URL(url);
      if (!["https:", "http:"].includes(target.protocol))
        throw new Error("Invalid download URL.");
      if (tab) tab.location.href = target.href;
      else
        setArtifactMessage(
          "Allow pop-ups for this site, then try the download again.",
        );
    } catch (error) {
      tab?.close();
      setArtifactMessage(
        error instanceof Error ? error.message : "Download failed.",
      );
    }
  };
  useEffect(() => {
    let disposed = false;
    const load = async () => {
      try {
        const response = await fetch(
          `/api/backend/calls?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        );
        if (!response.ok) throw new Error("Cannot load call history.");
        const c = (await response.json()) as CallRecord[];
        if (!disposed) {
          setCalls(c);
          setNextCursor(response.headers.get("X-Next-Cursor") ?? "");
        }
        if (selected) {
          const transfer = await api<TransferView | null>(
            `/calls/${selected}/transfer`,
          ).catch(() => null);
          if (!disposed) {
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
  }, [selected, onError, cursor]);
  const start = async () => {
    setBusy(true);
    try {
      const call = await api<CallRecord>("/calls", "POST", {
        agentId,
        to,
        from: from || undefined,
        context: context || undefined,
      });
      setTransfer(null);
      setCursor("");
      setPreviousPages([]);
      setSelected(call.sid);
      setCalls((c) => [call, ...c]);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Call failed.");
    } finally {
      setBusy(false);
    }
  };
  const active = calls.find((c) => c.sid === selected);
  const activeOutcome = active ? callOutcome(active) : undefined;
  return (
    <div className="fields">
      <div className="section-head">
        <div>
          <p className="eyebrow">TWILIO TELEPHONY</p>
          <h2>Calls</h2>
        </div>
        <span className="badge">{calls.length} on this page</span>
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
                  <th>Cost</th>
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
                          setTransfer(null);
                        }}
                      >
                        {c.parentCallSid ? "Consultation" : c.direction}
                      </button>
                    </td>
                    <td>{c.direction === "outbound" ? c.to : c.from}</td>
                    <td>{c.status}</td>
                    <td title={callOutcome(c)?.reason}>
                      {callOutcome(c)?.label ?? "In progress"}
                    </td>
                    <td>
                      {c.cost ? (
                        <>
                          <span>${c.cost.totalUsd.toFixed(4)}</span>
                          <br />
                          <small>
                            {c.cost.status === "incomplete"
                              ? "Known subtotal"
                              : c.cost.estimated
                                ? "Estimated"
                                : "Final"}
                          </small>
                        </>
                      ) : (
                        "Pending"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="section-head">
          <button
            type="button"
            disabled={!previousPages.length}
            onClick={() => {
              setCursor(previousPages.at(-1) ?? "");
              setPreviousPages((p) => p.slice(0, -1));
              setSelected("");
            }}
          >
            Newer calls
          </button>
          <button
            type="button"
            disabled={!nextCursor}
            onClick={() => {
              setPreviousPages((p) => [...p, cursor]);
              setCursor(nextCursor);
              setSelected("");
            }}
          >
            Older calls
          </button>
        </div>
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
          {activeOutcome && (
            <div>
              <p><strong>Outcome:</strong> {activeOutcome.label}</p>
              <p className="mono subtle">{activeOutcome.reason}</p>
              <p className="hint">
                This describes how the call ended; it does not evaluate whether
                a business goal was achieved.
              </p>
              <CallServerEvents key={active.sid} sid={active.sid} />
            </div>
          )}
          {activeOutcome && <CallRecordings key={active.sid} sid={active.sid} />}
          <div className="row">
            <button
              className="ghost"
              onClick={() => void downloadArtifact(active.sid, "transcript")}
            >
              Download transcript
            </button>
            <button
              className="ghost"
              disabled={!trace || traceLoading || !!traceError}
              onClick={() => trace && downloadCallLogs(active.sid, trace.events)}
            >
              Download all logs
            </button>
            <button
              className="ghost"
              onClick={() => void downloadArtifact(active.sid, "recording")}
            >
              Download recording
            </button>
          </div>
          {artifactMessage && (
            <p className="hint" role="status">
              {artifactMessage}
            </p>
          )}
          <p className="hint">
            For webhook, provider and audio delivery details, open Diagnostics
            and filter by this Call SID.
          </p>
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
          {active.cost ? (
            <CallCostDetails cost={active.cost} />
          ) : (
            <p className="hint">
              Usage and costs will appear after call processing completes.
            </p>
          )}
          {traceLoading && <p role="status">Loading complete call history…</p>}
          {traceError && <p role="alert" className="error">{traceError} Displayed events may be incomplete until refresh succeeds.</p>}
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
                <CallLog key={active.sid} events={trace.events} />
              </details>
            </>
          ) : (
            <p className="hint">
              No transcript or events are available for this call yet.
            </p>
          )}
        </section>
      )}
    </div>
  );
}

function CallCostDetails({ cost }: { cost: CallCost }) {
  const money = (value: number | null | undefined) =>
    value === null || value === undefined ? "Unpriced" : `$${value.toFixed(6)}`;
  return (
    <fieldset>
      <legend>Usage & costs</legend>
      <p>
        <strong>
          {cost.status === "incomplete" ? "Known subtotal" : "Total"}:{" "}
          {money(cost.totalUsd)} USD
        </strong>
        {" · "}
        {cost.status ?? (cost.estimated ? "estimated" : "final")}
      </p>
      {cost.reportedUsd !== undefined && <p className="hint">Provider-reported charges: {money(cost.reportedUsd)} · Measured usage × rate: {money(cost.calculatedUsd)} · Estimates: {money(cost.estimatedUsd)} · Unpriced items: {cost.unpricedItems ?? 0}</p>}
      {cost.pricingVersion && <p className="hint">Pricing version: {cost.pricingVersion} · Duration: {(cost.durationSec / 60).toFixed(3)} minutes</p>}
      {cost.reconciliationStatus === "pending" && (
        <p className="hint">
          Provider charges are still being reconciled. Values may update.
        </p>
      )}
      {cost.costBreakdown && (
        <p className="hint">
          Model {money(cost.costBreakdown.llm)} · Transcriber{" "}
          {money(cost.costBreakdown.stt)} · Voice{" "}
          {money(cost.costBreakdown.tts)} · Telephony{" "}
          {money(cost.costBreakdown.transport)} · Hosting{" "}
          {money(cost.costBreakdown.hosting)}
        </p>
      )}
      <div className="table-scroll">
        <table aria-label="Call cost breakdown">
          <thead>
            <tr>
              <th>Provider / service</th>
              <th>Usage</th>
              <th>Rate</th>
              <th>Cost (USD)</th>
              <th>Source</th>
            </tr>
          </thead>
          <tbody>
            {cost.lines.map((line, index) => (
              <tr key={index}>
                <td>
                  {line.provider}
                  <br />
                  <small>{line.item}</small>
                </td>
                <td>
                  {line.unit === "unknown"
                    ? "Pending"
                    : `${line.quantity.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${line.unit}`}
                </td>
                <td>
                  {line.rate === null
                    ? "—"
                    : `${money(line.rate)} / ${line.unit}`}
                </td>
                <td>{money(line.usd)}</td>
                <td>
                  {line.source === "provider"
                    ? "Provider reported"
                    : line.usd === null
                      ? "Missing rate"
                      : line.basis === "measured-usage" ? "Measured usage × rate" : line.basis === "infrastructure-estimate" ? "Infrastructure estimate" : "Estimated usage"}
                  {line.note && (
                    <details>
                      <summary>Details</summary>
                      <small>{line.note}</small>
                    </details>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!!cost.usage?.llm.length && (
        <>
          <h4>Model tokens</h4>
          <div className="table-scroll">
            <table aria-label="Model token usage">
              <thead>
                <tr>
                  <th>Provider / model</th>
                  <th>Requests</th>
                  <th>Input</th>
                  <th>Cached input</th>
                  <th>Output</th>
                  <th>Reasoning</th>
                  <th>Audio input / output</th>
                </tr>
              </thead>
              <tbody>
                {cost.usage.llm.map((usage) => (
                  <tr key={`${usage.provider}:${usage.model}`}>
                    <td>
                      {usage.provider}
                      <br />
                      <small>{usage.model}</small>
                    </td>
                    <td>
                      {usage.requests}
                      {usage.estimatedRequests > 0 && (
                        <small> ({usage.estimatedRequests} estimated)</small>
                      )}
                    </td>
                    <td>{usage.prompt.toLocaleString()}</td>
                    <td>{usage.cached.toLocaleString()}</td>
                    <td>{usage.completion.toLocaleString()}</td>
                    <td>{usage.reasoning.toLocaleString()}</td>
                    <td>
                      {usage.inputAudio.toLocaleString()} /{" "}
                      {usage.outputAudio.toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="hint">
            Cached and audio input are included in input tokens. Reasoning and
            audio output are included in output tokens.
          </p>
        </>
      )}
      {cost.usage && (
        <p className="hint">
          Transcribed audio:{" "}
          {cost.usage.transcriber
            .reduce((sum, item) => sum + item.audioSeconds, 0)
            .toFixed(2)}{" "}
          seconds · Generated voice:{" "}
          {cost.usage.voice
            .reduce((sum, item) => sum + item.characters, 0)
            .toLocaleString()}{" "}
          characters · Call duration: {cost.durationSec.toFixed(1)} seconds
        </p>
      )}
      {!!cost.usage?.requests?.length && <details><summary>Provider request evidence & credits</summary><div className="table-scroll"><table aria-label="Provider request usage"><thead><tr><th>Provider</th><th>Request</th><th>Usage</th><th>Credits</th><th>Reconciliation</th></tr></thead><tbody>{cost.usage.requests.map((r) => <tr key={r.id}><td>{r.provider}<small>{r.model}</small></td><td>{r.providerRequestId ?? "No provider ID"}</td><td>{r.reportedQuantity ?? r.quantity} {r.unit}</td><td>{r.credits ?? "Unknown"}</td><td>{r.reconciliation ?? "Not reported"}</td></tr>)}</tbody></table></div></details>}
      {!!cost.relatedCalls?.length && (
        <details>
          <summary>
            {cost.relatedCalls.some(
              (call) =>
                call.totalUsd === null ||
                call.status === "incomplete" ||
                call.status === "pending",
            )
              ? "Known subtotal including transfer calls"
              : "Including transfer calls"}
            : {money(cost.totalWithRelatedUsd)}
          </summary>
          <p className="hint">
            Each transfer call has its own bill. This combined figure includes
            those bills once.
          </p>
          <ul>
            {cost.relatedCalls.map((call) => (
              <li key={call.callId}>
                <span className="mono">{call.callId}</span>:{" "}
                {money(call.totalUsd)} ({call.status})
              </li>
            ))}
          </ul>
        </details>
      )}
      {cost.warnings.length > 0 && (
        <ul className="hint">
          {cost.warnings.map((warning, index) => (
            <li key={index}>{warning}</li>
          ))}
        </ul>
      )}
    </fieldset>
  );
}

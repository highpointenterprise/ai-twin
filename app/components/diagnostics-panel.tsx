"use client";
import { useEffect, useState } from "react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { api } from "./api";
interface Snapshot {
  configuration: {
    missing: string[];
    publicBaseUrl: string;
    inboundUrl: string;
    mediaUrl: string;
    assistants: {
      id: string;
      name: string;
      voiceConfigured: boolean;
      voiceSource: string;
      assignedNumber: string | null;
      firstMessageMode: string;
    }[];
  };
  events: {
    at: number;
    scope: string;
    event: string;
    detail: Record<string, string | number | boolean>;
  }[];
}
export function DiagnosticsPanel() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [callSid, setCallSid] = useState(""),
    [error, setError] = useState("");
  useEffect(() => {
    let disposed = false;
    const load = () =>
      api<Snapshot>(
        `/diagnostics${callSid ? `?callSid=${encodeURIComponent(callSid.trim())}` : ""}`,
      )
        .then((data) => {
          if (!disposed) {
            setSnapshot(data);
            setError("");
          }
        })
        .catch((e) => {
          if (!disposed) setError(e.message);
        });
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [callSid]);
  const download = () => {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(snapshot, null, 2)], {
        type: "application/json",
      }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "voice-agent-diagnostics.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <div className="fields">
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <section className="fields">
        <h3>Calling configuration</h3>
        {snapshot && (
          <>
            <p className="hint">
              {snapshot.configuration.missing.length
                ? `Missing: ${snapshot.configuration.missing.join(", ")}`
                : "Required server settings are present. This does not verify provider access or the ngrok connection."}
            </p>
            <p>
              Inbound webhook:{" "}
              <code className="mono">{snapshot.configuration.inboundUrl}</code>
            </p>
            <p>
              Media WebSocket:{" "}
              <code className="mono">{snapshot.configuration.mediaUrl}</code>
            </p>
            <p className="hint">
              After changing your ngrok HTTPS URL, update PUBLIC_BASE_URL,
              restart the backend and use Refresh inbound route under Phone
              numbers.
            </p>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Assistant</th>
                    <th>Voice</th>
                    <th>Inbound number</th>
                    <th>Opening mode</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshot.configuration.assistants.map((a) => (
                    <tr key={a.id}>
                      <td>{a.name}</td>
                      <td>
                        {a.voiceConfigured ? a.voiceSource : "Missing voice ID"}
                      </td>
                      <td>{a.assignedNumber ?? "Not assigned"}</td>
                      <td>{a.firstMessageMode}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
      <section className="fields">
        <div className="section-head">
          <h3>Live diagnostic log</h3>
          <Button variant="outline" disabled={!snapshot} onClick={download}>
            Download logs
          </Button>
        </div>
        <label>
          Filter by full Call SID (optional)
          <Input
            value={callSid}
            onChange={(e) => setCallSid(e.target.value)}
            placeholder="CA…"
          />
        </label>
        <p className="hint">
          Updates every 3 seconds. Includes webhooks, stream authentication,
          transcription, model, voice generation, playback and errors. Provider
          keys and raw audio are excluded. Logs can contain conversation text.
        </p>
        <pre aria-label="Diagnostic events" style={{ maxHeight: 600 }}>
          {snapshot?.events
            .map(
              (e) =>
                `${new Date(e.at).toISOString()} [${e.scope}] ${e.event} ${JSON.stringify(e.detail)}`,
            )
            .join("\n") ||
            "No events yet. Make a test call, then watch the stages appear here."}
        </pre>
      </section>
    </div>
  );
}

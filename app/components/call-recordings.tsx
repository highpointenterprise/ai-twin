"use client";
import { useEffect, useState } from "react";
import { api } from "./api";
const labels = {
  monoRecording: "Mono (combined)",
  recording: "Stereo (both channels)",
  assistantRecording: "Assistant audio",
  customerRecording: "Customer audio",
} as const;
type RecordingKind = keyof typeof labels;
interface RecordingStatus { state: string; lastError?: string; available: RecordingKind[] }
export function CallRecordings({ sid }: { sid: string }) {
  const [status, setStatus] = useState<RecordingStatus>();
  const [kind, setKind] = useState<RecordingKind>("monoRecording");
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      try {
        const view = await api<RecordingStatus>(`/calls/${sid}/recordings`);
        if (!disposed) setStatus(view);
      } catch { if (!disposed) setError("Cannot load recording status."); }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => { disposed = true; clearInterval(timer); };
  }, [sid, revision]);
  const available = status?.available.includes(kind) ?? false;
  useEffect(() => {
    let disposed = false;
    setUrl("");
    if (available) {
      setError("");
      void api<{ url: string }>(`/calls/${sid}/artifacts/${kind}?play=true`).then((result) => {
        if (!["https:", "http:"].includes(new URL(result.url).protocol)) throw new Error("Invalid audio URL.");
        if (!disposed) setUrl(result.url);
      }).catch(() => { if (!disposed) setError("Cannot load this recording. Try reloading the audio link."); });
    }
    return () => { disposed = true; };
  }, [sid, kind, available, revision]);
  const retry = async () => {
    setBusy(true); setError("");
    try { await api(`/calls/${sid}/recordings/retry`, "POST", {}); setRevision((r) => r + 1); }
    catch { setError("Could not retry recording processing."); }
    finally { setBusy(false); }
  };
  const download = async () => {
    const tab = window.open("about:blank", "_blank");
    if (tab) tab.opener = null;
    try {
      const result = await api<{ url: string }>(`/calls/${sid}/artifacts/${kind}`);
      if (!["https:", "http:"].includes(new URL(result.url).protocol)) throw new Error("Invalid download URL.");
      if (tab) tab.location.href = result.url;
      else setError("Allow pop-ups to download the recording.");
    } catch { tab?.close(); setError("Cannot download this recording."); }
  };
  return <section aria-label="Call recordings">
    <h4>Recordings</h4>
    <p role="status">{status ? `Recording: ${status.state}` : "Loading recordings…"}</p>
    {status?.lastError && <p className="hint">{status.lastError}</p>}
    {error && <p role="alert">{error}</p>}
    <label>Audio track
      <select value={kind} onChange={(event) => setKind(event.target.value as RecordingKind)}>
        {Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
    </label>
    {url ? <audio key={url} aria-label={labels[kind]} controls preload="metadata" src={url} style={{ width: "100%" }} onError={() => setError("Audio could not load or the link expired. Reload the audio link and try again.")} /> : <p className="hint">{available ? "Loading audio…" : "This track is not available yet."}</p>}
    <div className="row">
      <button type="button" className="ghost" disabled={!available} onClick={() => setRevision((r) => r + 1)}>Reload audio link</button>
      <button type="button" className="ghost" disabled={!available} onClick={() => void download()}>Download WAV</button>
      {status && !["completed", "started", "requested", "starting"].includes(status.state) && <button type="button" disabled={busy} onClick={() => void retry()}>{busy ? "Retrying…" : "Retry recording processing"}</button>}
    </div>
    <p className="hint">Audio links are private and expire. Calls that never connected have no audio. Recordings disabled before a call cannot be recreated.</p>
  </section>;
}

"use client";
import { useState } from "react";
import type { TraceEvent } from "../../lib/types";
import { formatCallLogs } from "../../lib/call-trace";

export function downloadCallLogs(sid: string, events: TraceEvent[]) {
  const url = URL.createObjectURL(new Blob([formatCallLogs(events) + "\n"], { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${sid}-logs.txt`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function CallLog({ events }: { events: TraceEvent[] }) {
  const [visible, setVisible] = useState(500);
  return <div className="fields">
    <p className="hint">{events.length} events loaded. All loaded events are included in the download.</p>
    {events.length > visible && <button type="button" onClick={() => setVisible(count => count + 500)}>Show 500 earlier events ({events.length - visible} remaining)</button>}
    <pre aria-label="Call events" style={{ maxHeight: 600, overflow: "auto" }}>{formatCallLogs(events.slice(-visible)) || "No call events yet."}</pre>
  </div>;
}

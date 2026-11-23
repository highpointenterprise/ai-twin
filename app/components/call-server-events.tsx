"use client";
import { useEffect, useState } from "react";
import { api } from "./api";

interface ServerEventStatus {
  event: string;
  state: "pending" | "delivering" | "delivered" | "failed";
  attempts: number;
  dueAt: string;
  deliveredAt?: string;
  statusCode?: number;
  lastError?: string;
}

export function CallServerEvents({ sid }: { sid: string }) {
  const [events, setEvents] = useState<ServerEventStatus[]>([]);
  const [error, setError] = useState("");
  const [retrying, setRetrying] = useState(false);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let disposed = false;
    setEvents([]);
    setLoaded(false);
    setError("");
    const refresh = async () => {
      try {
        const rows = await api<ServerEventStatus[]>(
          `/calls/${encodeURIComponent(sid)}/server-events`,
        );
        if (!disposed) {
          setEvents(rows);
          setError("");
          setLoaded(true);
        }
      } catch (cause) {
        if (!disposed)
          setError(
            cause instanceof Error
              ? cause.message
              : "Cannot load webhook delivery status.",
          );
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [sid]);
  const retry = async () => {
    setRetrying(true);
    setError("");
    try {
      await api(
        `/calls/${encodeURIComponent(sid)}/server-events/retry`,
        "POST",
        {},
      );
      setEvents(
        await api<ServerEventStatus[]>(
          `/calls/${encodeURIComponent(sid)}/server-events`,
        ),
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Cannot retry webhook delivery.",
      );
    } finally {
      setRetrying(false);
    }
  };
  return (
    <section aria-label="Server webhook delivery">
      <h4>End-of-call webhook</h4>
      {error && <p role="alert">{error}</p>}
      {!loaded && !error && <p role="status">Loading delivery status…</p>}
      {loaded && !events.length && (
        <p className="hint">
          No delivery queued. Reports use the Server URL saved on the assistant
          when the call starts. A newly ended call may still be processing.
        </p>
      )}
      {events.map((event) => (
        <div key={event.event}>
          <p role="status">
            {event.state} · {event.attempts} attempt
            {event.attempts === 1 ? "" : "s"}
            {event.statusCode ? ` · HTTP ${event.statusCode}` : ""}
          </p>
          {event.deliveredAt && (
            <p className="hint">
              Delivered {new Date(event.deliveredAt).toLocaleString()}
            </p>
          )}
          {event.lastError && <p>{event.lastError}</p>}
          {event.state === "pending" && (
            <p className="hint">
              Next attempt: {new Date(event.dueAt).toLocaleString()}
            </p>
          )}
          {event.state === "failed" && (
            <button
              type="button"
              disabled={retrying}
              onClick={() => void retry()}
            >
              {retrying ? "Retrying…" : "Retry webhook"}
            </button>
          )}
        </div>
      ))}
    </section>
  );
}

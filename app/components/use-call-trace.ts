"use client";
import { useEffect, useState } from "react";
import type { CallTraceView } from "../../lib/types";
import { loadCallTrace } from "../../lib/call-trace";

export function useCallTrace(sid: string) {
  const [state, setState] = useState<{ sid: string; trace: CallTraceView | null; error: string; loading: boolean }>({ sid: "", trace: null, error: "", loading: false });
  useEffect(() => {
    setState({ sid, trace: null, error: "", loading: !!sid });
    if (!sid) return;
    const controller = new AbortController();
    let snapshot: CallTraceView | null = null, refreshes = 0;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const next = await loadCallTrace(async query => {
          const response = await fetch(`/api/backend/calls/${encodeURIComponent(sid)}/trace?${query}`, { signal: controller.signal, cache: "no-store" });
          if (!response.ok) throw new Error("Cannot load the full call log. Please retry.");
          return response.json();
        }, refreshes++ % 10 === 0 ? null : snapshot);
        if (controller.signal.aborted) return;
        snapshot = next;
        setState({ sid, trace: next, error: "", loading: false });
      } catch (e) {
        if (!controller.signal.aborted) setState({ sid, trace: snapshot, loading: false, error: e instanceof Error ? e.message : "Cannot load call logs." });
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => void load(), 3000);
      }
    };
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [sid]);
  return state.sid === sid ? state : { trace: null, error: "", loading: !!sid };
}

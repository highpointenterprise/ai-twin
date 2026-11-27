import type { CallTraceView, TraceEvent, TranscriptLine } from "./types";

type Row = TraceEvent | TranscriptLine;
const identity = (row: Row) => row.id ?? JSON.stringify(row);
const merge = <T extends Row>(previous: T[], added: T[]): T[] => {
  const rows = new Map(previous.map((row) => [identity(row), row]));
  for (const row of added) rows.set(identity(row), row);
  return [...rows.values()].sort(
    (a, b) => a.at - b.at || (a.id ?? "").localeCompare(b.id ?? ""),
  );
};

export async function loadCallTrace(
  read: (query: string) => Promise<CallTraceView>,
  previous?: CallTraceView | null,
): Promise<CallTraceView> {
  const knownEvents = new Set(previous?.events.map(identity));
  const knownTranscript = new Set(previous?.transcript.map(identity));
  let events: TraceEvent[] = [],
    transcript: TranscriptLine[] = [];
  let eventsCursor: string | null | undefined,
    transcriptCursor: string | null | undefined;
  let latest: CallTraceView | undefined;
  const visited = new Set<string>();
  do {
    const query = new URLSearchParams({ limit: "500" });
    if (eventsCursor) query.set("eventsCursor", eventsCursor);
    if (transcriptCursor) query.set("transcriptCursor", transcriptCursor);
    if (visited.has(query.toString()))
      throw new Error("Call log pagination did not advance. Please retry.");
    visited.add(query.toString());
    const page = await read(query.toString());
    latest ??= page;
    if (eventsCursor !== null) {
      events.push(...page.events);
      eventsCursor = page.events.some((row) => knownEvents.has(identity(row)))
        ? null
        : (page.pagination?.eventsNextCursor ?? null);
    }
    if (transcriptCursor !== null) {
      transcript.push(...page.transcript);
      transcriptCursor = page.transcript.some((row) =>
        knownTranscript.has(identity(row)),
      )
        ? null
        : (page.pagination?.transcriptNextCursor ?? null);
    }
  } while (eventsCursor || transcriptCursor);
  return {
    ...latest!,
    events: merge(previous?.events ?? [], events),
    transcript: merge(previous?.transcript ?? [], transcript),
    pagination: { eventsNextCursor: null, transcriptNextCursor: null },
  };
}

export const formatCallLogs = (events: TraceEvent[]): string =>
  events
    .map(
      (event) =>
        `${new Date(event.at).toISOString()} ${event.event} ${JSON.stringify(event.detail)}`,
    )
    .join("\n");

import test from "node:test";
import assert from "node:assert/strict";
import { loadCallTrace, formatCallLogs } from "../lib/call-trace";
import type { CallTraceView, TraceEvent, TranscriptLine } from "../lib/types";

function fixture(count: number, messages: number) {
  const events: TraceEvent[] = Array.from({ length: count }, (_, i) => ({
    id: `e${String(i).padStart(6, "0")}`,
    at: 1000,
    event: "media.sent",
    detail: {},
  }));
  const transcript: TranscriptLine[] = Array.from(
    { length: messages },
    (_, i) => ({
      id: `t${String(i).padStart(6, "0")}`,
      at: 1000,
      role: "caller",
      text: "Repeated words",
    }),
  );
  let reads = 0;
  const read = async (query: string): Promise<CallTraceView> => {
    reads++;
    const params = new URLSearchParams(query),
      limit = Number(params.get("limit"));
    const eventEnd = params.has("eventsCursor")
      ? Number(params.get("eventsCursor"))
      : events.length;
    const transcriptEnd = params.has("transcriptCursor")
      ? Number(params.get("transcriptCursor"))
      : transcript.length;
    return {
      startedAt: 1000,
      stats: {
        turns: messages,
        avgLatencyMs: 0,
        p50LatencyMs: 0,
        maxLatencyMs: 0,
      },
      events: events.slice(Math.max(0, eventEnd - limit), eventEnd),
      transcript: transcript.slice(
        Math.max(0, transcriptEnd - limit),
        transcriptEnd,
      ),
      pagination: {
        eventsNextCursor: eventEnd > limit ? String(eventEnd - limit) : null,
        transcriptNextCursor:
          transcriptEnd > limit ? String(transcriptEnd - limit) : null,
      },
    };
  };
  return { events, transcript, read, reads: () => reads };
}

test("loads every stored event and transcript across independently sized pages", async () => {
  for (const [events, transcript] of [
    [1537, 3],
    [2, 1102],
    [1201, 1201],
  ]) {
    const f = fixture(events, transcript),
      trace = await loadCallTrace(f.read);
    assert.deepEqual(trace.events, f.events);
    assert.deepEqual(trace.transcript, f.transcript);
    assert.equal(formatCallLogs(trace.events).split("\n").length, events);
    assert.ok(f.reads() > 1);
  }
});

test("refresh backfills bursts larger than one page without losing older history or repeated same-time events", async () => {
  const f = fixture(1450, 50);
  const previous = await loadCallTrace(f.read);
  const reads = f.reads();
  assert.deepEqual(await loadCallTrace(f.read, previous), previous);
  assert.equal(f.reads() - reads, 1);
  for (let i = 0; i < 1001; i++)
    f.events.push({
      id: `new-${i}`,
      at: 2000 + i,
      event: "media.sent",
      detail: {},
    });
  const updated = await loadCallTrace(f.read, previous);
  assert.equal(updated.events.length, 2451);
  assert.deepEqual(updated.events, f.events);
  assert.equal(updated.transcript.length, 50);
});

test("pagination errors never silently return a truncated full history", async () => {
  const f = fixture(1001, 1);
  let calls = 0;
  await assert.rejects(
    loadCallTrace((query) =>
      ++calls === 2 ? Promise.reject(new Error("unavailable")) : f.read(query),
    ),
    /unavailable/,
  );
  const page = await f.read("limit=500");
  await assert.rejects(
    loadCallTrace(async () => page),
    /did not advance/,
  );
});

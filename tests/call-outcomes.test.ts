import { test } from "node:test";
import assert from "node:assert/strict";
import {
  callOutcome,
  normalizeEndedReason,
  type CallOutcome,
} from "../lib/call-outcomes";
import { callEndedReason } from "../server/api/v1/mappers/call";
import { endOfCallReport } from "../server/webhooks/end-of-call-report";
import type { StoredCall } from "../server/storage/calls";

const cases: [string, string, CallOutcome][] = [
  ["customer-ended-call", "customer-ended-call", "completed"],
  [
    "call.in-progress.twilio-completed-call",
    "call.in-progress.twilio-completed-call",
    "completed",
  ],
  ["assistant-ended-call", "assistant-ended-call", "completed"],
  ["user-ended", "manually-canceled", "canceled"],
  ["voicemail", "voicemail", "voicemail"],
  ["answer-detection-ended", "voicemail", "voicemail"],
  ["busy", "customer-busy", "busy"],
  ["no-answer", "customer-did-not-answer", "no-answer"],
  ["canceled", "manually-canceled", "canceled"],
  ["transfer-completed", "assistant-forwarded-call", "transferred"],
  ["transfer-busy", "call.forwarding.operator-busy", "transfer-failed"],
  ["transfer-no-answer", "call.forwarding.no-answer", "transfer-failed"],
  [
    "transfer-failed",
    "call.in-progress.error-transfer-failed",
    "transfer-failed",
  ],
  [
    "transfer-canceled",
    "call.in-progress.error-transfer-failed",
    "transfer-failed",
  ],
  [
    "warm-transfer-fallback-error",
    "call.in-progress.error-transfer-failed",
    "transfer-failed",
  ],
  [
    "warm-transfer-fallback-ended",
    "call.forwarding.operator-busy",
    "transfer-failed",
  ],
  ["silence-timeout", "silence-timed-out", "silence-timeout"],
  ["screening-timeout", "silence-timed-out", "silence-timeout"],
  ["max-duration", "exceeded-max-duration", "max-duration"],
  ["failed", "twilio-failed-to-connect-call", "failed"],
  [
    "transcriber-error",
    "pipeline-error-deepgram-transcriber-failed",
    "provider-failed",
  ],
  [
    "speech-provider-error",
    "pipeline-error-eleven-labs-voice-failed",
    "provider-failed",
  ],
  [
    "consultation-provider-error",
    "pipeline-error-openai-llm-failed",
    "provider-failed",
  ],
  ["server-restarted", "worker-shutdown", "connection-failed"],
  [
    "media-stream-error: connection lost",
    "phone-call-provider-closed-websocket",
    "connection-failed",
  ],
  ["no-agent-assigned", "assistant-not-found", "start-failed"],
  [
    "configuration-missing",
    "call.start.error-get-resources-validation",
    "start-failed",
  ],
  [
    "voice-id-missing",
    "call.start.error-get-resources-validation",
    "start-failed",
  ],
  [
    "capacity-or-credentials-update",
    "call.start.error-concurrency-limit-reached",
    "start-failed",
  ],
  [
    "call.start.error-schedule-expired",
    "call.start.error-schedule-expired",
    "start-failed",
  ],
  [
    "customer-ended-call-during-transfer",
    "customer-ended-call-during-transfer",
    "transfer-interrupted",
  ],
  [
    "assistant-ended-call-after-message-spoken",
    "assistant-ended-call-after-message-spoken",
    "completed",
  ],
  ["assistant-join-timed-out", "assistant-join-timed-out", "join-timeout"],
  [
    "customer-did-not-give-microphone-permission",
    "customer-did-not-give-microphone-permission",
    "permission-denied",
  ],
  ["call-deleted", "call-deleted", "deleted"],
  [
    "call.ending.hook-executed-transfer",
    "call.ending.hook-executed-transfer",
    "transferred",
  ],
  ["future-reason", "future-reason", "unknown"],
];

for (const [raw, expected, outcome] of cases) {
  test(`API, report and dashboard preserve the outcome for ${raw}`, () => {
    const call = {
      sid: "CA11111111111111111111111111111111",
      id: "call-id",
      assistantId: "assistant-id",
      agentId: "assistant-id",
      status: "completed",
      endedReason: raw,
      direction: "outbound",
      type: "outboundPhoneCall",
      from: "+14155550100",
      to: "+14155550101",
      createdAt: "2026-11-23T00:00:00.000Z",
      endedAt: "2026-11-23T00:01:00.000Z",
      updatedAt: Date.parse("2026-11-23T00:01:00.000Z"),
    } as StoredCall;
    const report = endOfCallReport({
      call,
      transcript: [],
      orgId: "owner",
      baseUrl: "https://api.example",
    });
    assert.equal(normalizeEndedReason(raw), expected);
    assert.equal(callEndedReason(raw, "ended"), expected);
    assert.equal(report.message.endedReason, expected);
    assert.equal(report.message.call.endedReason, expected);
    assert.equal(callOutcome(call)?.outcome, outcome);
    assert.deepEqual(report.message.analysis, {});
    assert.equal(report.message.cost, undefined);
  });
}

test("missing and unfamiliar end reasons never invent a successful ending", () => {
  assert.equal(normalizeEndedReason(), "unknown");
  assert.equal(callOutcome({ status: "completed" })?.outcome, "unknown");
  assert.equal(callOutcome({ status: "failed" })?.outcome, "failed");
  assert.equal(
    callOutcome({ status: "ringing", endedReason: "busy" }),
    undefined,
  );
  assert.equal(callEndedReason("busy", "in-progress"), undefined);
  assert.equal(
    callOutcome({ status: "completed", answeredBy: "machine_end_beep" })
      ?.outcome,
    "voicemail",
  );
});

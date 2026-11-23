const aliases: Readonly<Record<string, string>> = {
  "user-ended": "manually-canceled",
  "answer-detection-ended": "voicemail",
  "max-duration": "exceeded-max-duration",
  "silence-timeout": "silence-timed-out",
  "screening-timeout": "silence-timed-out",
  "no-answer": "customer-did-not-answer",
  busy: "customer-busy",
  failed: "twilio-failed-to-connect-call",
  canceled: "manually-canceled",
  "server-restarted": "worker-shutdown",
  "media-session-error": "phone-call-provider-closed-websocket",
  "transcriber-error": "pipeline-error-deepgram-transcriber-failed",
  "speech-provider-error": "pipeline-error-eleven-labs-voice-failed",
  "consultation-provider-error": "pipeline-error-openai-llm-failed",
  "meeting-provider-error": "pipeline-error-openai-llm-failed",
  "transfer-completed": "assistant-forwarded-call",
  "transfer-busy": "call.forwarding.operator-busy",
  "transfer-no-answer": "call.forwarding.no-answer",
  "transfer-failed": "call.in-progress.error-transfer-failed",
  "transfer-canceled": "call.in-progress.error-transfer-failed",
  "warm-transfer-fallback-error": "call.in-progress.error-transfer-failed",
  "warm-transfer-fallback-ended": "call.forwarding.operator-busy",
  "no-agent-assigned": "assistant-not-found",
  "configuration-missing": "call.start.error-get-resources-validation",
  "voice-id-missing": "call.start.error-get-resources-validation",
  "capacity-or-credentials-update":
    "call.start.error-concurrency-limit-reached",
};

export function normalizeEndedReason(raw?: string): string {
  if (!raw) return "unknown";
  if (raw.startsWith("media-stream-error"))
    return "phone-call-provider-closed-websocket";
  return aliases[raw] ?? raw;
}

export const outcomeLabels = {
  completed: "Completed",
  voicemail: "Voicemail",
  busy: "Busy",
  "no-answer": "No answer",
  canceled: "Canceled",
  transferred: "Transferred",
  "transfer-failed": "Transfer failed",
  "transfer-interrupted": "Transfer interrupted",
  "permission-denied": "Microphone permission denied",
  "join-timeout": "Join timeout",
  deleted: "Deleted",
  "silence-timeout": "Silence timeout",
  "max-duration": "Maximum duration reached",
  "start-failed": "Call setup failed",
  "provider-failed": "Provider error",
  "connection-failed": "Connection lost",
  failed: "Failed",
  unknown: "Unknown outcome",
} as const;
export type CallOutcome = keyof typeof outcomeLabels;

export function callEndedReasonFor(call: {
  status: string;
  endedReason?: string;
  answeredBy?: string;
  transferStatus?: string;
}): string {
  const reason = normalizeEndedReason(call.endedReason);
  if (
    [
      "unknown",
      "customer-ended-call",
      "call.in-progress.twilio-completed-call",
    ].includes(reason)
  ) {
    if (
      call.transferStatus === "warm-completed" ||
      call.transferStatus === "completed"
    )
      return "assistant-forwarded-call";
    if (call.answeredBy?.startsWith("machine")) return "voicemail";
    if (call.status === "failed" && reason === "unknown")
      return "twilio-failed-to-connect-call";
  }
  return reason;
}

export function callOutcome(call: {
  status: string;
  endedReason?: string;
  answeredBy?: string;
  transferStatus?: string;
}) {
  if (!["completed", "failed", "ended"].includes(call.status)) return undefined;
  const reason = callEndedReasonFor(call);
  let outcome: CallOutcome = "unknown";
  if (reason === "voicemail") outcome = "voicemail";
  else if (reason === "customer-busy") outcome = "busy";
  else if (reason === "customer-did-not-answer") outcome = "no-answer";
  else if (reason === "manually-canceled") outcome = "canceled";
  else if (reason === "call-deleted" || reason === "scheduled-call-deleted")
    outcome = "deleted";
  else if (reason === "customer-did-not-give-microphone-permission")
    outcome = "permission-denied";
  else if (reason.includes("join-timed-out")) outcome = "join-timeout";
  else if (/^customer-ended-call-.*transfer/.test(reason))
    outcome = "transfer-interrupted";
  else if (
    reason === "assistant-forwarded-call" ||
    reason.endsWith("hook-executed-transfer")
  )
    outcome = "transferred";
  else if (
    /forwarding|transfer.*(?:error|failed|busy|no-answer|canceled)/.test(reason)
  )
    outcome = "transfer-failed";
  else if (reason === "silence-timed-out") outcome = "silence-timeout";
  else if (reason === "exceeded-max-duration") outcome = "max-duration";
  else if (
    /call[.-]start[.-]error|assistant-(?:not-found|not-valid|request-)/.test(
      reason,
    )
  )
    outcome = "start-failed";
  else if (/pipeline-error|providerfault/.test(reason))
    outcome = "provider-failed";
  else if (
    /websocket|transport|worker-(?:shutdown|died)|connection/.test(reason)
  )
    outcome = "connection-failed";
  else if (
    [
      "customer-ended-call",
      "assistant-forced-hangup",
      "call.in-progress.twilio-completed-call",
      "call.in-progress.sip-completed-call",
    ].includes(reason) ||
    /^assistant-(?:ended-call|said-end-call-phrase)/.test(reason) ||
    reason.endsWith("hook-executed-say")
  )
    outcome = "completed";
  else if (/error|failed/.test(reason) || call.status === "failed")
    outcome = "failed";
  return { outcome, label: outcomeLabels[outcome], reason };
}

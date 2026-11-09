import type { AgentConfig } from "../../lib/types";
export function voicemailAction(
  answeredBy: string,
  plan: AgentConfig["voicemailDetection"],
): "conversation" | "voicemail" | "hangup" {
  if (!plan.enabled) return "conversation";
  if (answeredBy === "fax") return "hangup";
  if (answeredBy.startsWith("machine"))
    return plan.action === "leave-message" &&
      answeredBy.startsWith("machine_end")
      ? "voicemail"
      : "hangup";
  if (
    (!answeredBy || answeredBy === "unknown") &&
    plan.unknownAction === "hangup"
  )
    return "hangup";
  return "conversation";
}

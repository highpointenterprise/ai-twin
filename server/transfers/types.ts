import type { ToolConfig, WarmTransferPlan } from "../../lib/config";
import type { ConversationSnapshot } from "../core/ports";
export type TransferTool = Extract<ToolConfig, { type: "transferCall" }>;
export type TransferDestination = TransferTool["destinations"][number];
export type TransferPhase =
  | "preparing"
  | "dialing"
  | "consulting"
  | "connecting"
  | "connected"
  | "returning"
  | "returned"
  | "recovery-failed"
  | "cancelled"
  | "completed";
export interface WarmTransferRecord {
  id: string;
  callerSid: string;
  operatorSid?: string;
  conferenceSid?: string;
  room: string;
  from: string;
  destination: TransferDestination;
  plan: WarmTransferPlan;
  ringTimeoutSeconds: number;
  phase: TransferPhase;
  reason?: string;
  createdAt: number;
  updatedAt: number;
  deadline: number;
  snapshot: ConversationSnapshot;
  consultationContextId?: string;
  resumeContextId?: string;
  recoveryAttempts: number;
  lastError?: string;
}
export interface WarmTransferTelephony {
  redirectCall(sid: string, url: string): Promise<void>;
  dialOperator(input: {
    to: string;
    from: string;
    url: string;
    statusUrl: string;
    timeoutSeconds: number;
  }): Promise<string>;
  endCall(sid: string): Promise<void>;
  callStatus(sid: string): Promise<string>;
  conferenceMembers(
    room: string,
  ): Promise<{ sid: string; callSids: string[] } | undefined>;
}

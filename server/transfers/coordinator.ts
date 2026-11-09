import { randomUUID } from "node:crypto";
import { env } from "../../lib/env";
import type { CallStatus } from "../../lib/types";
import type { ChatMessage, ConversationSnapshot } from "../core/ports";
import { HttpError } from "../core/errors";
import { JsonFile } from "../store/persistence";
import type { ContextStore } from "../store/contexts";
import type { CallRegistry } from "../store/calls";
import type { TraceStore } from "../observability/trace";
import type {
  TransferDestination,
  TransferPhase,
  TransferTool,
  WarmTransferRecord,
  WarmTransferTelephony,
} from "./types";
import { transferUrl } from "./twiml";

const TERMINAL = new Set<TransferPhase>(["returned", "cancelled", "completed"]);
const TERMINAL_CALL = new Set([
  "completed",
  "canceled",
  "failed",
  "busy",
  "no-answer",
]);
export function settledHistory(
  history: ChatMessage[],
  reason: string,
): ChatMessage[] {
  const result = structuredClone(history);
  for (let i = 0; i < result.length; i++) {
    const calls = result[i].toolCalls;
    if (!calls) continue;
    let j = i + 1;
    const answered = new Set<string>();
    while (result[j]?.role === "tool") {
      answered.add(result[j].toolCallId!);
      j++;
    }
    const missing = calls
      .filter((c) => !answered.has(c.id))
      .map((c) => ({
        role: "tool" as const,
        toolCallId: c.id,
        content: JSON.stringify({ status: "transfer-returned", reason }),
      }));
    result.splice(j, 0, ...missing);
  }
  return result;
}

export class WarmTransferCoordinator {
  private readonly records = new Map<string, WarmTransferRecord>();
  private readonly file: JsonFile<WarmTransferRecord[]>;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly recoveries = new Map<string, Promise<void>>();
  private readonly verifications = new Set<string>();
  private closed = false;
  constructor(
    private readonly deps: {
      telephony: WarmTransferTelephony;
      contexts: ContextStore;
      registry: CallRegistry;
      traces: TraceStore;
      path?: string;
      now?: () => number;
    },
  ) {
    this.file = new JsonFile(deps.path);
    for (const record of this.file.load([]))
      this.records.set(record.id, record);
  }
  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
  get(id: string): WarmTransferRecord {
    const record = this.records.get(id);
    if (!record) throw new HttpError(404, "Warm transfer not found.");
    return record;
  }
  forCaller(sid: string): WarmTransferRecord | undefined {
    return [...this.records.values()]
      .reverse()
      .find((r) => r.callerSid === sid);
  }
  view(sid: string) {
    const r = this.forCaller(sid);
    return r
      ? {
          id: r.id,
          phase: r.phase,
          reason: r.reason,
          operatorSid: r.operatorSid,
          destination: r.destination.number,
          recoveryAttempts: r.recoveryAttempts,
          updatedAt: r.updatedAt,
          lastError: r.lastError,
        }
      : null;
  }
  start(
    callerSid: string,
    tool: TransferTool,
    destination: TransferDestination,
    snapshot: ConversationSnapshot,
  ): string {
    if (this.closed)
      throw new HttpError(503, "Transfer service is shutting down.");
    const existing = this.forCaller(callerSid);
    if (existing && !TERMINAL.has(existing.phase))
      throw new HttpError(
        409,
        "A warm transfer is already active for this caller.",
      );
    const caller = this.deps.registry.get(callerSid);
    if (!caller || ["completed", "failed"].includes(caller.status))
      throw new HttpError(409, "Caller is no longer active.");
    const reservedLegs = [...this.records.values()].filter(
      (r) => !TERMINAL.has(r.phase) && !r.operatorSid,
    ).length;
    if (
      this.deps.registry.activeCount + reservedLegs >=
      env.MAX_CONCURRENT_CALLS
    )
      throw new HttpError(503, "No capacity for the consultation leg.");
    const id = randomUUID(),
      now = this.now();
    const record: WarmTransferRecord = {
      id,
      callerSid,
      room: `warm-${id}`,
      from: caller.direction === "inbound" ? caller.to : caller.from,
      destination: structuredClone(destination),
      plan: structuredClone(tool.warmTransfer),
      ringTimeoutSeconds: tool.timeoutSeconds,
      phase: "preparing",
      createdAt: now,
      updatedAt: now,
      deadline: Math.min(
        snapshot.deadline,
        now + (tool.timeoutSeconds + 20) * 1000,
      ),
      snapshot: structuredClone(snapshot),
      recoveryAttempts: 0,
    };
    if (!/^\+[1-9]\d{6,14}$/.test(record.from))
      throw new HttpError(
        400,
        "A Twilio caller ID is required for warm transfer.",
      );
    this.records.set(id, record);
    this.deps.registry.patch(callerSid, {
      transferId: id,
      operatorCallSid: undefined,
    });
    this.save(record);
    this.arm(record);
    // Once persisted, this orchestration owns the handoff. The caller's old media
    // abort signal is expected to fire when Twilio switches it onto hold.
    void this.launch(record).catch((error) =>
      this.failOperation(record, "start-failed", error),
    );
    return id;
  }
  private async launch(r: WarmTransferRecord): Promise<void> {
    await this.deps.telephony.redirectCall(
      r.callerSid,
      transferUrl(r.id, "hold"),
    );
    if (r.phase !== "preparing") return;
    this.phase(r, "dialing");
    const sid = await this.deps.telephony.dialOperator({
      to: r.destination.number,
      from: r.from,
      url: transferUrl(r.id, "operator"),
      statusUrl: transferUrl(r.id, "operator-status"),
      timeoutSeconds: r.ringTimeoutSeconds,
    });
    if (r.operatorSid && r.operatorSid !== sid) {
      await this.deps.telephony.endCall(sid);
      throw new Error("Recipient call SID mismatch.");
    }
    this.bindOperator(r, sid);
    if (
      [
        "returning",
        "recovery-failed",
        "returned",
        "cancelled",
        "completed",
      ].includes(r.phase)
    )
      await this.stopOperator(r);
  }
  private bindOperator(r: WarmTransferRecord, sid: string): void {
    if (r.operatorSid && r.operatorSid !== sid)
      throw new HttpError(403, "Unexpected recipient call.");
    r.operatorSid = sid;
    if (!this.deps.registry.get(sid))
      this.deps.registry.create({
        sid,
        agentId: r.snapshot.agent.id,
        direction: "outbound",
        from: r.from,
        to: r.destination.number,
        status: "initiating",
        parentCallSid: r.callerSid,
        transferId: r.id,
      });
    if (this.deps.registry.get(r.callerSid)?.transferId === r.id)
      this.deps.registry.patch(r.callerSid, { operatorCallSid: sid });
    this.save(r);
  }
  operatorAnswered(id: string, sid: string, to: string): string | undefined {
    const r = this.get(id);
    if (to !== r.destination.number)
      throw new HttpError(403, "Recipient number mismatch.");
    this.bindOperator(r, sid);
    if (!["dialing", "consulting"].includes(r.phase)) return undefined;
    if (r.consultationContextId)
      return this.deps.contexts.get(r.consultationContextId)
        ? r.consultationContextId
        : undefined;
    r.consultationContextId = randomUUID();
    r.deadline = Math.min(
      r.snapshot.deadline,
      this.now() + r.plan.maxDurationSeconds * 1000,
    );
    this.deps.contexts.set(r.consultationContextId, {
      agent: r.snapshot.agent,
      tools: [],
      brief: "",
      direction: "outbound",
      purpose: "warm-consultation",
      sid,
      warmTransferId: id,
      deadline: r.deadline,
    });
    this.deps.registry.update(sid, "connected");
    this.phase(r, "consulting");
    this.arm(r);
    return r.consultationContextId;
  }
  async accept(id: string, operatorSid: string): Promise<void> {
    const r = this.get(id);
    if (r.operatorSid !== operatorSid)
      throw new HttpError(403, "Recipient call mismatch.");
    if (["connecting", "connected"].includes(r.phase)) return;
    if (r.phase !== "consulting")
      throw new HttpError(409, "This consultation is no longer active.");
    this.phase(r, "connecting");
    r.deadline = Math.min(
      r.snapshot.deadline,
      this.now() + r.plan.bridgeTimeoutSeconds * 1000,
    );
    this.save(r);
    this.arm(r);
    try {
      const conference = await this.deps.telephony.conferenceMembers(r.room);
      if (this.get(id).phase !== "connecting") return;
      if (!conference?.callSids.includes(r.callerSid))
        throw new Error("Caller is not present in the waiting conference.");
      r.conferenceSid = conference.sid;
      this.save(r);
      await this.deps.telephony.redirectCall(
        operatorSid,
        transferUrl(id, "bridge"),
      );
      // REST redirect success is not bridge success. Poll membership as well as
      // processing conference callbacks, so a lost callback cannot claim success.
      await this.verifyBridge(id);
    } catch (error) {
      await this.failOperation(r, "bridge-failed", error);
    }
  }
  async verifyBridge(id: string): Promise<void> {
    const r = this.get(id);
    if (r.phase !== "connecting" || this.verifications.has(id)) return;
    this.verifications.add(id);
    try {
      const conference = await this.deps.telephony.conferenceMembers(r.room);
      if (this.get(id).phase !== "connecting") return;
      if (
        conference?.callSids.includes(r.callerSid) &&
        r.operatorSid &&
        conference.callSids.includes(r.operatorSid)
      ) {
        r.conferenceSid = conference.sid;
        this.phase(r, "connected");
        this.clearTimer(id);
      }
    } catch (e) {
      this.error(r, e);
    } finally {
      this.verifications.delete(id);
    }
  }
  operatorStatus(id: string, sid: string, to: string, status: string): void {
    const r = this.get(id);
    if (to !== r.destination.number)
      throw new HttpError(403, "Recipient number mismatch.");
    this.bindOperator(r, sid);
    const mapped = (
      {
        queued: "initiating",
        initiated: "initiating",
        ringing: "ringing",
        "in-progress": "connected",
        completed: "completed",
        busy: "failed",
        "no-answer": "failed",
        canceled: "failed",
        failed: "failed",
      } as Record<string, CallStatus>
    )[status];
    if (mapped) this.deps.registry.update(sid, mapped);
    if (!TERMINAL_CALL.has(status)) {
      this.deps.registry.restoreLive(sid);
      if (
        [
          "returning",
          "recovery-failed",
          "returned",
          "cancelled",
          "completed",
        ].includes(r.phase)
      )
        void this.stopOperator(r).catch((e) => this.error(r, e));
      return;
    }
    if (r.phase === "connected") {
      this.phase(r, "completed", `operator-${status}`);
      this.clearTimer(id);
    } else if (
      ![
        "returning",
        "returned",
        "recovery-failed",
        "cancelled",
        "completed",
      ].includes(r.phase)
    )
      void this.rollback(id, `operator-${status}`);
  }
  conferenceEvent(
    id: string,
    event: string,
    sid: string,
    conferenceSid: string,
  ): void {
    const r = this.get(id);
    if (TERMINAL.has(r.phase)) return;
    if (r.conferenceSid && r.conferenceSid !== conferenceSid)
      throw new HttpError(403, "Conference mismatch.");
    r.conferenceSid = conferenceSid;
    this.save(r);
    if (event === "participant-join" && r.phase === "connecting")
      void this.verifyBridge(id);
    if (
      event === "participant-leave" &&
      sid === r.callerSid &&
      !["returning", "returned", "recovery-failed"].includes(r.phase)
    )
      void this.callerEnded(r.callerSid);
    if (
      event === "participant-leave" &&
      sid === r.operatorSid &&
      r.phase === "connecting"
    )
      void this.rollback(id, "operator-left-before-bridge");
    if (event === "conference-end" && r.phase === "connected") {
      this.phase(r, "completed", "conference-ended");
      this.clearTimer(id);
    }
  }
  async callerEnded(sid: string): Promise<void> {
    const r = this.forCaller(sid);
    if (!r || TERMINAL.has(r.phase)) return;
    const connected = r.phase === "connected";
    this.phase(r, connected ? "completed" : "cancelled", "caller-ended");
    this.clearTimer(r.id);
    this.removeContexts(r);
    try {
      await this.stopOperator(r);
    } catch (error) {
      this.error(r, error);
    }
  }
  consultationDisconnected(id: string): void {
    const r = this.get(id);
    if (r.phase === "consulting")
      void this.rollback(id, "consultation-disconnected");
  }
  async rollback(id: string, reason: string): Promise<void> {
    const r = this.get(id);
    if (TERMINAL.has(r.phase) || r.phase === "connected") return;
    if (r.phase !== "returning") {
      this.phase(r, "returning", reason);
      this.clearTimer(id);
    }
    const existing = this.recoveries.get(id);
    if (existing) return existing;
    const recovery = this.recoverCaller(r).finally(() =>
      this.recoveries.delete(id),
    );
    this.recoveries.set(id, recovery);
    await recovery;
  }
  private async recoverCaller(r: WarmTransferRecord): Promise<void> {
    r.recoveryAttempts++;
    this.save(r);
    try {
      const callerStatus = await this.deps.telephony.callStatus(r.callerSid);
      if (r.phase !== "returning") return;
      if (TERMINAL_CALL.has(callerStatus)) {
        await this.callerEnded(r.callerSid);
        return;
      }
      this.deps.registry.restoreLive(r.callerSid);
      // End the private recipient leg before resuming. Failed cleanup is retried;
      // never leave an untracked consultation running behind a "returned" status.
      await this.stopOperator(r);
      if (r.phase !== "returning") return;
      if (r.snapshot.deadline <= this.now()) {
        await this.deps.telephony.endCall(r.callerSid);
        this.phase(r, "cancelled", "max-duration");
        this.removeContexts(r);
        return;
      }
      if (!r.resumeContextId || !this.deps.contexts.get(r.resumeContextId)) {
        r.resumeContextId = randomUUID();
        this.deps.contexts.set(r.resumeContextId, {
          ...r.snapshot,
          agent: {
            ...r.snapshot.agent,
            firstMessageMode: "assistant-speaks-first",
            firstMessage: r.plan.fallbackMessage,
          },
          history: settledHistory(
            r.snapshot.history,
            r.reason ?? "transfer-failed",
          ),
          purpose: "conversation",
          sid: r.callerSid,
          resumeTransferId: r.id,
          endAfterFirstMessage: r.plan.endCallOnFailure,
        });
      }
      this.save(r);
      await this.deps.telephony.redirectCall(
        r.callerSid,
        transferUrl(r.id, "resume"),
      );
      if (r.phase !== "returning") return;
      r.deadline = this.now() + 20000;
      this.save(r);
      this.arm(r);
      // The resumed media start, not this REST response, establishes recovery.
    } catch (error) {
      this.error(r, error);
      if (r.phase !== "returning") return;
      if (r.recoveryAttempts < 3) {
        r.deadline = this.now() + 2000 * r.recoveryAttempts;
        this.save(r);
        this.arm(r);
      } else {
        this.phase(r, "recovery-failed", r.reason);
        this.clearTimer(r.id);
      }
    }
  }
  resumed(id: string, sid: string): void {
    const r = this.get(id);
    if (r.callerSid !== sid || r.phase !== "returning")
      throw new HttpError(409, "This caller is not awaiting recovery.");
    this.phase(r, "returned", r.reason);
    this.clearTimer(id);
    if (r.consultationContextId)
      this.deps.contexts.delete(r.consultationContextId);
  }
  async retry(id: string): Promise<void> {
    const r = this.get(id);
    if (r.phase !== "recovery-failed")
      throw new HttpError(409, "No failed recovery to retry.");
    r.recoveryAttempts = 0;
    await this.rollback(id, r.reason ?? "manual-recovery");
  }
  async checkDeadline(id: string): Promise<void> {
    const r = this.get(id);
    if (
      TERMINAL.has(r.phase) ||
      r.phase === "connected" ||
      r.phase === "recovery-failed"
    )
      return;
    if (r.deadline > this.now()) {
      if (r.phase === "connecting") await this.verifyBridge(id);
      if (r.phase === "connecting") this.arm(r);
      return;
    }
    if (r.phase === "returning" && r.recoveryAttempts >= 3) {
      this.phase(r, "recovery-failed", "resume-not-confirmed");
      this.clearTimer(id);
      return;
    }
    await this.rollback(
      id,
      r.phase === "consulting"
        ? "consultation-timeout"
        : r.phase === "connecting"
          ? "bridge-timeout"
          : r.phase === "returning"
            ? (r.reason ?? "resume-timeout")
            : "ring-timeout",
    );
  }
  async recoverAfterRestart(): Promise<void> {
    for (const r of [...this.records.values()]) {
      if (TERMINAL.has(r.phase)) continue;
      try {
        const status = await this.deps.telephony.callStatus(r.callerSid);
        if (TERMINAL_CALL.has(status)) {
          await this.callerEnded(r.callerSid);
          continue;
        }
        this.deps.registry.restoreLive(r.callerSid);
        if (r.phase === "connected") {
          // Native human conferences survive restarts. Restore the recipient's
          // record only after checking it, and never redial or redirect here.
          if (r.operatorSid) {
            const operatorStatus = await this.deps.telephony.callStatus(
              r.operatorSid,
            );
            if (TERMINAL_CALL.has(operatorStatus)) {
              this.phase(r, "completed", `operator-${operatorStatus}`);
            } else this.deps.registry.restoreLive(r.operatorSid);
          }
          continue;
        }
        r.resumeContextId = undefined;
        r.consultationContextId = undefined;
        r.recoveryAttempts = 0;
        await this.rollback(r.id, "server-restarted");
      } catch (error) {
        this.error(r, error);
        // A transient status-query outage must not turn an established human
        // conference into a recovery action that disconnects its recipient.
        if (r.phase !== "connected")
          this.phase(r, "recovery-failed", "restart-recovery-failed");
      }
    }
  }
  shutdown(): void {
    this.closed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
  private async stopOperator(r: WarmTransferRecord): Promise<void> {
    if (!r.operatorSid) return;
    try {
      await this.deps.telephony.endCall(r.operatorSid);
    } catch (error) {
      if (
        !TERMINAL_CALL.has(await this.deps.telephony.callStatus(r.operatorSid))
      )
        throw error;
    }
    this.deps.registry.update(r.operatorSid, "completed");
  }
  private removeContexts(r: WarmTransferRecord): void {
    if (r.consultationContextId)
      this.deps.contexts.delete(r.consultationContextId);
    if (r.resumeContextId) this.deps.contexts.delete(r.resumeContextId);
  }
  private async failOperation(
    r: WarmTransferRecord,
    reason: string,
    error: unknown,
  ): Promise<void> {
    this.error(r, error);
    await this.rollback(r.id, reason);
  }
  private error(r: WarmTransferRecord, error: unknown): void {
    r.lastError =
      error instanceof Error ? error.message : "Provider operation failed";
    this.save(r);
    this.deps.traces
      .for(r.callerSid)
      .log("warm.error", { transferId: r.id, message: r.lastError });
  }
  private phase(
    r: WarmTransferRecord,
    phase: TransferPhase,
    reason?: string,
  ): void {
    if (r.phase === phase && reason === undefined) return;
    r.phase = phase;
    if (reason) r.reason = reason;
    this.save(r);
    this.deps.traces
      .for(r.callerSid)
      .log(`warm.${phase}`, { transferId: r.id, reason: r.reason ?? "" });
  }
  private save(r: WarmTransferRecord): void {
    r.updatedAt = this.now();
    // Keep all active transfers, and a bounded terminal history.
    const terminal = [...this.records.values()]
      .filter((v) => TERMINAL.has(v.phase))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    for (const old of terminal.slice(200)) this.records.delete(old.id);
    this.file.save([...this.records.values()]);
    if (this.deps.registry.get(r.callerSid)?.transferId === r.id)
      this.deps.registry.patch(r.callerSid, {
        transferStatus: `warm-${r.phase}`,
      });
  }
  private clearTimer(id: string): void {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
  }
  private arm(r: WarmTransferRecord): void {
    this.clearTimer(r.id);
    if (this.closed) return;
    const ms = Math.max(1, r.deadline - this.now());
    this.timers.set(
      r.id,
      setTimeout(
        () => {
          void this.checkDeadline(r.id).catch((e) => this.error(r, e));
        },
        r.phase === "connecting" ? Math.min(ms, 1000) : ms,
      ),
    );
  }
}

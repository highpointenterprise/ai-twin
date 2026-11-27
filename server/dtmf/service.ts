import { randomUUID } from "node:crypto";
import { signStreamToken } from "../../lib/token";
import type { DtmfCheckpoint } from "../calls/detection";
import type { Telephony, ToolContext, ToolOutcome } from "../core/ports";
import type { TraceStore } from "../observability/trace";
import type { ContextStore } from "../store/contexts";

export interface DtmfResume {
  operationId: string;
  previousContextId: string;
  requestedAt: number;
  expiresAt: number;
  handling: DtmfCheckpoint;
}
interface Operation {
  id: string;
  callSid: string;
  contextId: string;
  previousContextId: string;
  requestedAt: number;
  resumed: boolean;
  ended: boolean;
  cleanupAttempts?: number;
  timer?: NodeJS.Timeout;
  task?: Promise<ToolOutcome>;
}
export class DtmfService {
  private readonly pending = new Map<string, Operation>();
  constructor(private readonly deps: {
    telephony: Telephony;
    contexts: ContextStore;
    traces: TraceStore;
    publicBaseUrl: string;
    endCall: (sid: string, reason: string) => Promise<void>;
    releaseLease?: (id: string) => Promise<void>;
    reconnectTimeoutMs?: number;
  }) {}

  send(operationId: string, keys: string, context: ToolContext): Promise<ToolOutcome> {
    const existing = this.pending.get(context.callSid);
    if (existing) {
      if (existing.id === operationId && existing.task) {
        this.deps.traces.for(context.callSid).log("dtmf.duplicate_suppressed", { operationId });
        return existing.task;
      }
      return Promise.reject(new Error("A keypad operation is already in progress."));
    }
    const op: Operation = {
      id: operationId, callSid: context.callSid, contextId: randomUUID(),
      previousContextId: context.snapshot?.mediaContextId ?? "",
      requestedAt: Date.now(), resumed: false, ended: false,
    };
    this.pending.set(context.callSid, op);
    op.task = this.deliver(op, keys, context).catch(error => {
      if (!op.timer && this.pending.get(op.callSid) === op) this.pending.delete(op.callSid);
      throw error;
    });
    return op.task;
  }

  private async deliver(op: Operation, keys: string, context: ToolContext): Promise<ToolOutcome> {
    const { snapshot } = context;
    if (!/^[0-9A-D*#wW]{1,32}$/.test(keys) || !/[0-9A-D*#]/.test(keys))
      throw new Error("Invalid DTMF sequence.");
    if (!this.deps.telephony.sendDigits || !snapshot?.handling || !op.previousContextId || !context.handoff)
      throw new Error("Provider keypad delivery requires an active telephone session.");
    context.signal.throwIfAborted();
    const expiresAt = Math.min(snapshot.deadline, op.requestedAt + (this.deps.reconnectTimeoutMs ?? 90_000));
    if (expiresAt <= Date.now()) throw new Error("Call duration limit reached.");
    const trace = this.deps.traces.for(op.callSid);
    const result = { status: "provider-playback-finished", remoteRecognition: "unconfirmed", operationId: op.id };
    const params = {
      agentId: snapshot.agent.id, callId: op.contextId,
      token: signStreamToken(snapshot.agent.id, op.contextId),
    };
    await this.deps.contexts.setAsync(op.contextId, {
      ...snapshot, purpose: "conversation", sid: op.callSid,
      history: [...snapshot.history, { role: "tool", toolCallId: op.id, content: JSON.stringify(result) }],
      dtmfResume: {
        operationId: op.id, previousContextId: op.previousContextId,
        requestedAt: op.requestedAt, expiresAt, handling: snapshot.handling,
      },
    });
    try {
      context.signal.throwIfAborted();
      if (op.ended) throw new Error("Call already ended.");
    }
    catch (error) { await this.deps.contexts.deleteAsync(op.contextId); throw error; }
    context.handoff(true);
    op.timer = setTimeout(() => void this.expire(op), Math.max(1, expiresAt - Date.now()));
    op.timer.unref();
    trace.log("dtmf.provider_requested", {
      operationId: op.id, transport: "twilio-play-digits",
      audibleTones: "carrier-dependent",
      recordingTones: "not-guaranteed",
      digitCount: keys.replace(/[wW]/g, "").length,
      pauseMs: [...keys].reduce((sum, k) => sum + (k === "w" ? 500 : k === "W" ? 1000 : 0), 0),
      selection: keys.length === 1 ? keys : "[redacted sequence]",
      reconnectTimeoutMs: expiresAt - op.requestedAt, automaticRetry: false,
    });
    try {
      await this.deps.telephony.sendDigits(op.callSid, keys,
        `${this.deps.publicBaseUrl.replace(/^http/, "ws")}/media`, params,
        `${this.deps.publicBaseUrl}/twilio/stream-status`);
      trace.log("dtmf.provider_accepted", { operationId: op.id, ms: Date.now() - op.requestedAt, remoteRecognition: "unconfirmed" });
      return { terminal: true, result: { status: "provider-command-accepted", remoteRecognition: "unconfirmed", operationId: op.id } };
    } catch (error) {
      const status = Number((error as { status?: unknown })?.status) || 0;
      const code = Number((error as { code?: unknown })?.code) || 0;
      const rejected = status >= 400 && status < 500 && status !== 408;
      trace.log(rejected ? "dtmf.provider_rejected" : "dtmf.delivery_uncertain", {
        operationId: op.id, httpStatus: status, providerCode: code,
        ms: Date.now() - op.requestedAt, automaticRetry: false, streamResumed: op.resumed,
      });
      if (rejected && !op.resumed && !op.ended) {
        await this.deps.contexts.deleteAsync(op.contextId);
        clearTimeout(op.timer);
        this.pending.delete(op.callSid);
        context.handoff(false);
        return { waitForUser: true, result: { error: "The phone provider rejected keypad delivery. Wait for the next menu before trying again.", operationId: op.id } };
      }
      return { terminal: true, result: { status: "delivery-uncertain", operationId: op.id, retryAllowed: false } };
    }
  }

  resumed(resume: DtmfResume, sid: string): void {
    const op = this.pending.get(sid);
    if (op?.id === resume.operationId) {
      op.resumed = true;
      clearTimeout(op.timer);
      this.pending.delete(sid);
    }
    this.deps.traces.for(sid).log("dtmf.stream_resumed", {
      operationId: resume.operationId, ms: Date.now() - resume.requestedAt,
      status: "provider-playback-finished", remoteRecognition: "unconfirmed",
    });
  }

  private async expire(op: Operation): Promise<void> {
    if (op.resumed || op.ended) return;
    op.cleanupAttempts = (op.cleanupAttempts ?? 0) + 1;
    this.deps.traces.for(op.callSid).log("dtmf.reconnect_timeout", { operationId: op.id, ms: Date.now() - op.requestedAt, automaticRetry: false });
    try {
      await this.deps.endCall(op.callSid, "dtmf-reconnect-timeout");
      await this.callerEnded(op.callSid);
    } catch {
      this.deps.traces.for(op.callSid).log("dtmf.reconnect_cleanup_failed", { operationId: op.id, attempt: op.cleanupAttempts });
      if (!op.ended && op.cleanupAttempts < 3) {
        op.timer = setTimeout(() => void this.expire(op), 5000);
        op.timer.unref();
      }
    }
  }

  async callerEnded(sid: string): Promise<void> {
    const op = this.pending.get(sid);
    if (!op) return;
    op.ended = true;
    clearTimeout(op.timer);
    this.pending.delete(sid);
    await this.deps.contexts.deleteAsync(op.contextId);
    await this.deps.releaseLease?.(op.previousContextId);
    this.deps.traces.for(sid).log("dtmf.operation_closed", { operationId: op.id, reason: "call-ended" });
  }
  shutdown(): void {
    for (const op of this.pending.values()) clearTimeout(op.timer);
  }
}

import type { ChatMessage } from "../core/ports";
import type { AgentConfig } from "../../lib/types";
import type { ToolConfig } from "../../lib/config";
export interface CallContext {
  dtmfResume?: import("../dtmf/service").DtmfResume;
  agent: AgentConfig;
  tools: ToolConfig[];
  brief: string;
  direction: "inbound" | "outbound";
  purpose: "conversation" | "voicemail" | "warm-consultation";
  history?: ChatMessage[];
  deadline?: number;
  warmTransferId?: string;
  resumeTransferId?: string;
  endAfterFirstMessage?: boolean;
  sid?: string;
  requestId?: string;
  from?: string;
  to?: string;
}
export interface ContextBackend {
  set(id: string, value: CallContext): Promise<void>;
  get(id: string): Promise<CallContext | undefined>;
  bind(id: string, sid: string): Promise<boolean>;
  take(id: string, sid: string): Promise<CallContext | undefined>;
  idForSid(sid: string): Promise<string | undefined>;
  delete(id: string): Promise<void>;
  updatePurpose(id: string, purpose: CallContext["purpose"]): Promise<boolean>;
}
export class ContextStore {
  constructor(private readonly backend?: ContextBackend) {}
  private localOnly(): void {
    if (this.backend) throw new Error("Use asynchronous context methods with shared storage.");
  }
  async setAsync(id: string, value: CallContext): Promise<void> {
    if (this.backend) return this.backend.set(id, value);
    this.set(id, value);
  }
  async getAsync(id: string): Promise<CallContext | undefined> {
    return this.backend ? this.backend.get(id) : this.get(id);
  }
  async bindAsync(id: string, sid: string): Promise<boolean> {
    return this.backend ? this.backend.bind(id, sid) : this.bind(id, sid);
  }
  async takeAsync(id: string, sid: string): Promise<CallContext | undefined> {
    return this.backend ? this.backend.take(id, sid) : this.take(id, sid);
  }
  async idForSidAsync(sid: string): Promise<string | undefined> {
    return this.backend ? this.backend.idForSid(sid) : this.idForSid(sid);
  }
  async deleteAsync(id: string): Promise<void> {
    if (this.backend) return this.backend.delete(id);
    this.delete(id);
  }
  async updatePurposeAsync(id: string, purpose: CallContext["purpose"]): Promise<boolean> {
    if (this.backend) return this.backend.updatePurpose(id, purpose);
    const context = this.get(id);
    if (!context) return false;
    context.purpose = purpose;
    return true;
  }
  private readonly contexts = new Map<
    string,
    { value: CallContext; expires: number }
  >();
  set(id: string, value: CallContext): void {
    this.localOnly();
    this.prune();
    this.contexts.set(id, {
      value: structuredClone(value),
      expires: Date.now() + 10 * 60000,
    });
  }
  get(id: string): CallContext | undefined {
    this.localOnly();
    this.prune();
    return this.contexts.get(id)?.value;
  }
  bind(id: string, sid: string): boolean {
    const v = this.get(id);
    if (!v || (v.sid && v.sid !== sid)) return false;
    v.sid = sid;
    return true;
  }
  take(id: string, sid: string): CallContext | undefined {
    const v = this.get(id);
    if (!v || v.sid !== sid) return undefined;
    this.contexts.delete(id);
    return v;
  }
  idForSid(sid: string): string | undefined {
    this.localOnly();
    this.prune();
    return [...this.contexts].find(([, v]) => v.value.sid === sid)?.[0];
  }
  delete(id: string): void {
    this.localOnly();
    this.contexts.delete(id);
  }
  private prune(): void {
    for (const [id, v] of this.contexts)
      if (v.expires < Date.now()) this.contexts.delete(id);
  }
}

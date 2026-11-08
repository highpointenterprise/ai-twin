import type { AgentConfig } from "../../lib/types";
import type { ToolConfig } from "../../lib/config";
export interface CallContext {
  agent: AgentConfig;
  tools: ToolConfig[];
  brief: string;
  direction: "inbound" | "outbound";
  purpose: "conversation" | "voicemail";
  sid?: string;
  from?: string;
  to?: string;
}
export class ContextStore {
  private readonly contexts = new Map<
    string,
    { value: CallContext; expires: number }
  >();
  set(id: string, value: CallContext): void {
    this.prune();
    this.contexts.set(id, {
      value: structuredClone(value),
      expires: Date.now() + 10 * 60000,
    });
  }
  get(id: string): CallContext | undefined {
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
    this.prune();
    return [...this.contexts].find(([, v]) => v.value.sid === sid)?.[0];
  }
  delete(id: string): void {
    this.contexts.delete(id);
  }
  private prune(): void {
    for (const [id, v] of this.contexts)
      if (v.expires < Date.now()) this.contexts.delete(id);
  }
}

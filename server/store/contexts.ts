export class ContextStore {
  private readonly briefs = new Map<string, string>();

  set(callId: string, brief: string): void {
    if (brief) this.briefs.set(callId, brief);
  }

  take(callId: string): string {
    const brief = this.briefs.get(callId) ?? "";
    this.briefs.delete(callId);
    return brief;
  }
}

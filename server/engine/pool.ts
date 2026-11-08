import type { ConversationSession } from "../core/ports";

export class SessionPool {
  private readonly sessions = new Set<ConversationSession>();

  constructor(private readonly capacity: number) {}

  get isFull(): boolean {
    return this.sessions.size >= this.capacity;
  }

  add(session: ConversationSession): void {
    this.sessions.add(session);
  }

  remove(session: ConversationSession): void {
    this.sessions.delete(session);
  }

  closeAll(): void {
    for (const session of this.sessions) session.close();
    this.sessions.clear();
  }
}

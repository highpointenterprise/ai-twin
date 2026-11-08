import type { ChatMessage } from "../core/ports";
import type { CallTrace } from "../observability/trace";

const MAX_TURNS = 24;
const KEEP_TURNS = 10;

export class ConversationMemory {
  private summary = "";
  private readonly turns: ChatMessage[] = [];
  private compacting = false;

  constructor(
    private readonly systemPrompt: string,
    private readonly summarize: (prior: string, turns: ChatMessage[]) => Promise<string>,
    private readonly trace: CallTrace,
  ) {}

  add(role: "user" | "assistant", content: string): void {
    this.turns.push({ role, content });
    void this.compact();
  }

  messages(note: string): ChatMessage[] {
    const memory = this.summary ? `\n\nCall memory so far (do not repeat anything covered here):\n${this.summary}` : "";
    return [{ role: "system", content: `${this.systemPrompt}${memory}\n\n${note}` }, ...this.turns];
  }

  private async compact(): Promise<void> {
    if (this.compacting || this.turns.length <= MAX_TURNS) return;
    this.compacting = true;
    const batch = this.turns.slice(0, this.turns.length - KEEP_TURNS);
    try {
      const started = Date.now();
      this.summary = await this.summarize(this.summary, batch);
      this.turns.splice(0, batch.length);
      this.trace.log("memory.compacted", { turns_summarized: batch.length, ms: Date.now() - started, memory: this.summary });
    } catch (error) {
      this.trace.log("memory.compaction_failed", { message: error instanceof Error ? error.message : "unknown" });
    } finally {
      this.compacting = false;
    }
  }
}

export class TurnGate {
  private resolveCommit!: (at: number) => void;
  private at?: number;
  readonly committed = new Promise<number>((resolve) => {
    this.resolveCommit = resolve;
  });

  static open(): TurnGate {
    const gate = new TurnGate();
    gate.commit();
    return gate;
  }

  get isCommitted(): boolean {
    return this.at !== undefined;
  }

  commit(at = Date.now()): void {
    if (this.at !== undefined) return;
    this.at = at;
    this.resolveCommit(at);
  }

  until(signal: AbortSignal): Promise<number> {
    if (this.at !== undefined) return Promise.resolve(this.at);
    return new Promise<number>((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      const onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      void this.committed.then((at) => {
        signal.removeEventListener("abort", onAbort);
        resolve(at);
      });
    });
  }
}

/** Ordered, bounded writes. Failed operations remain retryable until acknowledged. */
export class PendingWrites {
  private tail: Promise<void> = Promise.resolve();
  private failures: { write: () => Promise<unknown>; error: unknown }[] = [];
  private queued = 0;
  private draining?: Promise<void>;
  enqueue(write: () => Promise<unknown>): void {
    if (this.queued + this.failures.length >= 10_000)
      throw new Error(
        "Storage backlog is full; refusing to discard call data.",
      );
    this.queued++;
    this.tail = this.tail
      .then(async () => {
        if (this.failures.length) {
          this.failures.push({ write, error: this.failures[0].error });
          return;
        }
        await write();
      })
      .catch((error) => {
        this.failures.push({ write, error });
        console.error(
          "storage.write_failed",
          error instanceof Error ? error.message : "Unknown error",
        );
      })
      .finally(() => {
        this.queued--;
      });
  }
  flush(): Promise<void> {
    if (this.draining) return this.draining;
    const task = this.drain();
    this.draining = task;
    void task
      .finally(() => {
        if (this.draining === task) this.draining = undefined;
      })
      .catch(() => {});
    return task;
  }
  private async drain(): Promise<void> {
    await this.tail;
    const failed = this.failures.splice(0);
    for (const item of failed) this.enqueue(item.write);
    await this.tail;
    if (this.failures.length)
      throw new AggregateError(
        this.failures.map((item) => item.error),
        "Storage writes failed; retained for retry.",
      );
  }
}

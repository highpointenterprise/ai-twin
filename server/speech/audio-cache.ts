export class AudioCache {
  private readonly entries = new Map<
    string,
    { frames: readonly string[]; bytes: number; expires: number }
  >();
  private bytes = 0;

  constructor(
    private readonly capacity = 64,
    private readonly maxBytes = 12 * 1024 * 1024,
    private readonly ttlMs = 300_000,
  ) {}

  get(key: string): readonly string[] | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expires <= Date.now()) {
      this.remove(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.frames;
  }

  set(key: string, frames: readonly string[]): void {
    this.remove(key);
    const bytes = frames.reduce((sum, frame) => sum + frame.length * 2, 0);
    if (bytes > this.maxBytes || !frames.length) return;
    this.entries.set(key, {
      frames: [...frames],
      bytes,
      expires: Date.now() + this.ttlMs,
    });
    this.bytes += bytes;
    while (this.entries.size > this.capacity || this.bytes > this.maxBytes)
      this.remove(this.entries.keys().next().value!);
  }

  private remove(key: string): void {
    this.bytes -= this.entries.get(key)?.bytes ?? 0;
    this.entries.delete(key);
  }
}

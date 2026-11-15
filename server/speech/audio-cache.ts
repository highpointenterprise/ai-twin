export class AudioCache {
  private readonly entries = new Map<string, readonly string[]>();

  constructor(private readonly capacity = 64) {}

  get(key: string): readonly string[] | undefined {
    const frames = this.entries.get(key);
    if (!frames) return undefined;
    this.entries.delete(key);
    this.entries.set(key, frames);
    return frames;
  }

  set(key: string, frames: readonly string[]): void {
    this.entries.delete(key);
    this.entries.set(key, frames);
    if (this.entries.size > this.capacity)
      this.entries.delete(this.entries.keys().next().value as string);
  }
}

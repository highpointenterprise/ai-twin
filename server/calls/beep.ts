import type { AudioFormat } from "../core/ports";
import { decodeMulaw } from "../speech/audio";

export class BeepDetector {
  private readonly samples: number[] = [];
  private toneMs = 0;
  private frequency = 0;
  private quietMs = 0;
  constructor(
    private readonly format: AudioFormat = {
      encoding: "mulaw",
      sampleRate: 8000,
    },
  ) {}
  push(audio: Buffer): boolean {
    const step = this.format.encoding === "mulaw" ? 1 : 2;
    let found = false;
    for (let i = 0; i + step <= audio.length; i += step) {
      this.samples.push(
        step === 1 ? decodeMulaw(audio[i]) : audio.readInt16LE(i),
      );
      if (this.samples.length < this.format.sampleRate / 50) continue;
      found = this.frame(this.samples) || found;
      this.samples.length = 0;
    }
    return found;
  }
  private frame(samples: number[]): boolean {
    const energy = samples.reduce((sum, sample) => sum + sample * sample, 0);
    let peak = 0,
      frequency = 0;
    if (energy / samples.length > 400 * 400) {
      for (let hz = 350; hz <= 1800; hz += 25) {
        const coeff = 2 * Math.cos((2 * Math.PI * hz) / this.format.sampleRate);
        let a = 0,
          b = 0;
        for (const sample of samples) {
          const next = sample + coeff * a - b;
          b = a;
          a = next;
        }
        const power =
          (2 * (a * a + b * b - coeff * a * b)) / (energy * samples.length);
        if (power > peak) {
          peak = power;
          frequency = hz;
        }
      }
    }
    if (peak >= 0.8) {
      if (Math.abs(frequency - this.frequency) > 35) this.toneMs = 0;
      this.frequency = frequency;
      this.toneMs += 20;
      this.quietMs = 0;
      return false;
    }
    this.quietMs += 20;
    if (this.quietMs < 60) return false;
    const found =
      this.toneMs >= 120 &&
      this.toneMs <= 1500 &&
      energy / samples.length < 400 * 400;
    this.toneMs = 0;
    return found;
  }
}

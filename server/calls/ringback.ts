import type { AudioFormat } from "../core/ports";
import { decodeMulaw } from "../speech/audio";

const profiles = [
  {
    name: "north-america",
    frequencies: [440, 480],
    on: [1200, 2800],
    off: [2500, 5500],
  },
  { name: "425hz", frequencies: [425], on: [600, 2200], off: [1500, 5500] },
] as const;
type Profile = (typeof profiles)[number];
export interface RingbackObservation {
  profile: string;
  toneMs: number;
  silenceMs: number;
}

export class RingbackDetector {
  private readonly samples: number[] = [];
  private readonly coefficients: Map<number, number>;
  private profile?: Profile;
  private previous?: Profile;
  private toneMs = 0;
  private previousToneMs = 0;
  private gapMs = 0;
  private noiseMs = 0;
  private cycleGapMs?: number;
  private announced = false;
  private pendingByte?: number;

  constructor(
    private readonly format: AudioFormat = {
      encoding: "mulaw",
      sampleRate: 8000,
    },
  ) {
    this.coefficients = new Map(
      [425, 440, 480].map((hz) => [
        hz,
        2 * Math.cos((2 * Math.PI * hz) / format.sampleRate),
      ]),
    );
  }

  reset(): void {
    this.samples.length = 0;
    this.profile = this.previous = undefined;
    this.toneMs = this.previousToneMs = this.gapMs = this.noiseMs = 0;
    this.cycleGapMs = undefined;
    this.announced = false;
    this.pendingByte = undefined;
  }

  push(audio: Buffer): RingbackObservation | undefined {
    let found: RingbackObservation | undefined;
    const sample = (value: number) => {
      this.samples.push(value);
      if (this.samples.length < Math.round(this.format.sampleRate * 0.08))
        return;
      found = this.frame(this.samples) ?? found;
      this.samples.length = 0;
    };
    for (const byte of audio) {
      if (this.format.encoding === "mulaw") sample(decodeMulaw(byte));
      else if (this.pendingByte === undefined) this.pendingByte = byte;
      else {
        const value = this.pendingByte | (byte << 8);
        sample(value >= 32768 ? value - 65536 : value);
        this.pendingByte = undefined;
      }
    }
    return found;
  }

  private frame(samples: number[]): RingbackObservation | undefined {
    const energy = samples.reduce((sum, value) => sum + value * value, 0);
    const quiet = energy / samples.length < 400 ** 2;
    const power = (hz: number) => {
      const coefficient = this.coefficients.get(hz)!;
      let a = 0,
        b = 0;
      for (const sample of samples) {
        const next = sample + coefficient * a - b;
        b = a;
        a = next;
      }
      return (
        (2 * (a * a + b * b - coefficient * a * b)) / (energy * samples.length)
      );
    };
    const profile = quiet
      ? undefined
      : profiles.find((p) => {
          const bands = p.frequencies.map(power);
          return (
            bands.every((value) => value > (bands.length === 1 ? 0.85 : 0.2)) &&
            bands.reduce((sum, value) => sum + value, 0) > 0.8
          );
        });
    if (profile) {
      if (this.profile !== profile) {
        this.cycleGapMs =
          !this.profile &&
          this.previous === profile &&
          this.gapMs >= profile.off[0] &&
          this.gapMs <= profile.off[1]
            ? this.gapMs
            : undefined;
        this.profile = profile;
        this.toneMs = 0;
        this.announced = false;
      }
      this.toneMs += 80;
      if (
        this.cycleGapMs !== undefined &&
        this.toneMs >= 240 &&
        !this.announced
      ) {
        this.announced = true;
        return {
          profile: profile.name,
          toneMs: this.previousToneMs,
          silenceMs: this.cycleGapMs,
        };
      }
      return;
    }
    if (this.profile) {
      this.previous =
        this.toneMs >= this.profile.on[0] && this.toneMs <= this.profile.on[1]
          ? this.profile
          : undefined;
      this.previousToneMs = this.toneMs;
      this.profile = undefined;
      this.gapMs = this.noiseMs = 0;
    }
    this.gapMs += 80;
    this.noiseMs = quiet ? 0 : this.noiseMs + 80;
    if (this.gapMs > 5500 || this.noiseMs > 160) this.previous = undefined;
  }
}

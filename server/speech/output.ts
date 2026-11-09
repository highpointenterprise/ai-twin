import { randomUUID } from "node:crypto";
import type { SessionInit, SynthesizerFactory } from "../core/ports";
import { delay } from "./timing";
export class SpeechOutput {
  private readonly pending = new Map<string, () => void>();
  active = false;
  constructor(
    private readonly init: SessionInit,
    private readonly synthesize: SynthesizerFactory,
  ) {}
  mark(name: string): void {
    this.pending.get(name)?.();
  }
  clear(): void {
    this.init.send({ event: "clear", streamSid: this.init.streamSid });
  }
  async speak(text: string, signal: AbortSignal, waitMs = 0): Promise<void> {
    if (!text.trim() || signal.aborted) return;
    this.active = true;
    let audioBytes = 0;
    let audioLimitExceeded = false;
    let stopped = false;
    let queue = Promise.resolve();
    let first = true;
    const synth = this.synthesize(
      this.init.agent.voiceId,
      (payload) => {
        if (signal.aborted || stopped) return;
        audioBytes += Buffer.from(payload, "base64").length;
        if (audioBytes > 8000 * 180) {
          audioLimitExceeded = true;
          return;
        }
        const firstPacket = first;
        first = false;
        queue = queue.then(async () => {
          if (firstPacket && waitMs) await delay(waitMs, signal);
          if (!signal.aborted && !stopped)
            this.init.send({
              event: "media",
              streamSid: this.init.streamSid,
              media: { payload },
            });
        });
        void queue.catch(() => {});
      },
      this.init.agent.voice,
    );
    const abort = () => {
      synth.close();
      this.clear();
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      await synth.push(text);
      await synth.end();
      await queue;
      if (audioLimitExceeded)
        throw new Error("Synthesized utterance exceeded three minutes.");
      if (!signal.aborted && audioBytes)
        await this.drain(signal, audioBytes / 8 + 10000);
    } catch (error) {
      stopped = true;
      this.clear();
      throw error;
    } finally {
      signal.removeEventListener("abort", abort);
      synth.close();
      this.active = false;
    }
  }
  async play(audio: Buffer, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    this.active = true;
    try {
      // Twilio buffers these 20 ms frames and acknowledges when playback finishes.
      for (let i = 0; i < audio.length; i += 160) {
        signal.throwIfAborted();
        this.init.send({
          event: "media",
          streamSid: this.init.streamSid,
          media: { payload: audio.subarray(i, i + 160).toString("base64") },
        });
      }
      await this.drain(signal, audio.length / 8 + 10000);
    } finally {
      this.active = false;
    }
  }
  private drain(signal: AbortSignal, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      const name = randomUUID();
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        this.pending.delete(name);
      };
      const abort = () => {
        cleanup();
        this.clear();
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Twilio playback acknowledgement timed out."));
      }, timeoutMs);
      this.pending.set(name, () => {
        cleanup();
        resolve();
      });
      signal.addEventListener("abort", abort, { once: true });
      this.init.send({
        event: "mark",
        streamSid: this.init.streamSid,
        mark: { name },
      });
    });
  }
}

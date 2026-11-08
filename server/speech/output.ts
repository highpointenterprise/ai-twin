import { randomUUID } from "node:crypto";
import type {
  AudioOutputPort,
  SessionInit,
  SynthesizerFactory,
} from "../core/ports";
import { delay } from "./timing";
export class SpeechOutput {
  private readonly pending = new Map<string, () => void>();
  active = false;
  private readonly transport: AudioOutputPort;
  private readonly bytesPerSecond: number;
  constructor(
    private readonly init: SessionInit,
    private readonly synthesize: SynthesizerFactory,
  ) {
    this.transport = init.audioOutput ?? {
      audio: (payload) =>
        init.send({
          event: "media",
          streamSid: init.streamSid,
          media: { payload },
        }),
      mark: (name) =>
        init.send({ event: "mark", streamSid: init.streamSid, mark: { name } }),
      clear: () => init.send({ event: "clear", streamSid: init.streamSid }),
    };
    const format = init.outputAudioFormat ?? {
      encoding: "mulaw",
      sampleRate: 8000,
    };
    this.bytesPerSecond =
      format.sampleRate * (format.encoding === "mulaw" ? 1 : 2);
  }
  mark(name: string): void {
    this.pending.get(name)?.();
  }
  clear(): void {
    this.transport.clear();
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
        if (audioBytes > this.bytesPerSecond * 180) {
          audioLimitExceeded = true;
          return;
        }
        const firstPacket = first;
        first = false;
        queue = queue.then(async () => {
          if (firstPacket && waitMs) await delay(waitMs, signal);
          if (!signal.aborted && !stopped) this.transport.audio(payload);
        });
        void queue.catch(() => {});
      },
      this.init.agent.voice,
      this.init.outputAudioFormat,
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
        await this.drain(
          signal,
          (audioBytes * 1000) / this.bytesPerSecond + 15000,
        );
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
        this.transport.audio(audio.subarray(i, i + 160).toString("base64"));
      }
      await this.drain(
        signal,
        (audio.length * 1000) / this.bytesPerSecond + 10000,
      );
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
        reject(new Error("Audio playback acknowledgement timed out."));
      }, timeoutMs);
      this.pending.set(name, () => {
        cleanup();
        resolve();
      });
      signal.addEventListener("abort", abort, { once: true });
      try {
        this.transport.mark(name);
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  }
}

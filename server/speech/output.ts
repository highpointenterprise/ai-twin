import { randomUUID } from "node:crypto";
import type {
  AudioOutputPort,
  SessionInit,
  SpeechSynthesizer,
  SynthesizerFactory,
} from "../core/ports";
import { errorDetail } from "../observability/diagnostics";
import { speechCache as sharedCache, speechCacheKey, type PreparedOpening } from "./preparation";
import { base64ByteLength } from "./audio";
import { TurnGate } from "./gate";
import { delay } from "./timing";

const MAX_UTTERANCE_SECONDS = 180;
const DEFAULT_CHARS_PER_MS = 0.0145;
const PLAYOUT_LAG_MS = 120;

export interface SpeechStreamOptions {
  gate?: TurnGate;
  floorMs?: number;
  cacheKey?: string;
  prepared?: PreparedOpening;
  onFirstAudio?: (at: number) => void;
}

export interface SpeechStreamResult {
  spoken: string;
  firstAudioAt?: number;
}

export class SpeechStream {
  private readonly speechId = randomUUID();
  private readonly opened = Date.now();
  private readonly gate: TurnGate;
  private readonly bytesPerMs: number;
  private readonly frames: string[] = [];
  private readonly pending: string[] = [];
  private synth?: SpeechSynthesizer;
  private pushChain: Promise<void> = Promise.resolve();
  private releasing?: Promise<void>;
  private released = false;
  private disposed = false;
  private failure?: Error;
  private audioBytes = 0;
  private spokenText = "";
  private synthesisComplete = false;
  private sentAudio = false;
  private counted = false;
  private cacheHit: readonly string[] | undefined;
  private unsubscribe?: () => void;
  firstAudioAt?: number;

  constructor(
    private readonly host: StreamHost,
    private readonly signal: AbortSignal,
    private readonly options: SpeechStreamOptions,
  ) {
    this.gate = options.gate ?? TurnGate.open();
    this.bytesPerMs = host.bytesPerSecond / 1000;
    this.cacheHit = options.cacheKey
      ? sharedCache.get(options.cacheKey)
      : undefined;
    host.trace.log("speech.requested", {
      speechId: this.speechId,
      voiceId: host.voiceId,
      cached: !!this.cacheHit,
    });
    signal.addEventListener("abort", this.onAbort, { once: true });
  }

  get text(): string {
    return this.spokenText;
  }

  write(text: string): void {
    if (!text.trim() || this.disposed || this.signal.aborted) return;
    this.spokenText += (this.spokenText ? " " : "") + text.trim();
    if (this.cacheHit) return;
    if (this.options.prepared?.usable) {
      this.unsubscribe ??= this.options.prepared.subscribe((payload) => this.receive(payload));
      return;
    }
    this.synth ??= this.createSynthesizer();
    const synth = this.synth!;
    this.pushChain = this.pushChain
      .then(() => synth.push(text))
      .catch((error: unknown) => {
        this.failure ??= error instanceof Error ? error : new Error("TTS failed");
      });
  }

  async finish(): Promise<SpeechStreamResult> {
    try {
      await this.pushChain;
      if (this.failure) throw this.failure;
      if (!this.spokenText.trim()) return { spoken: "" };
      if (this.cacheHit) this.replayCached(this.cacheHit);
      else {
        if (this.unsubscribe) await this.options.prepared!.done;
        else await this.synth!.end();
        this.synthesisComplete = true;
      }
      await this.releasing;
      this.signal.throwIfAborted();
      if (!this.audioBytes && !this.cacheHit)
        throw new Error("Speech generation returned no audio.");
      if (this.audioBytes > this.host.bytesPerSecond * MAX_UTTERANCE_SECONDS)
        throw new Error("Synthesized utterance exceeded three minutes.");
      await this.host.drain(
        this.signal,
        this.audioBytes / this.bytesPerMs + 15000,
      );
      this.storeInCache();
      return { spoken: this.spokenText, firstAudioAt: this.firstAudioAt };
    } catch (error) {
      this.host.trace.log(
        this.signal.aborted ? "speech.cancelled" : "speech.failed",
        {
          speechId: this.speechId,
          ...errorDetail(error),
          bytes: this.audioBytes,
        },
      );
      if (!this.signal.aborted) this.host.clearIfSent(this.sentAudio);
      throw error;
    } finally {
      this.dispose();
    }
  }

  heardText(): string {
    if (!this.firstAudioAt || !this.spokenText) return "";
    const audioMs = this.audioBytes / this.bytesPerMs;
    const playedMs = Math.max(
      0,
      Math.min(Date.now() - this.firstAudioAt - PLAYOUT_LAG_MS, audioMs),
    );
    const rate =
      this.synthesisComplete && audioMs > 0
        ? this.spokenText.length / audioMs
        : DEFAULT_CHARS_PER_MS;
    const chars = Math.floor(playedMs * rate);
    if (chars >= this.spokenText.length) return this.spokenText;
    const cut = this.spokenText.lastIndexOf(" ", chars);
    return cut > 0 ? this.spokenText.slice(0, cut).trim() : "";
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.signal.removeEventListener("abort", this.onAbort);
    this.synth?.close();
    this.unsubscribe?.();
    if (this.counted) this.host.streamClosed();
  }

  private readonly onAbort = (): void => {
    this.options.prepared?.cancel();
    this.unsubscribe?.();
    this.synth?.close();
    this.host.clearIfSent(this.sentAudio);
  };

  private createSynthesizer(): SpeechSynthesizer {
    return this.host.synthesize(
      this.host.voiceId,
      (payload) => this.receive(payload),
      this.host.voice,
      this.host.format,
      {
        log: (event, detail = {}) =>
          this.host.trace.log(event, { ...detail, speechId: this.speechId }),
        usage: this.host.trace.usage,
      },
    );
  }

  private receive(payload: string): void {
    if (this.signal.aborted || this.disposed) return;
    this.audioBytes += base64ByteLength(payload);
    if (this.audioBytes > this.host.bytesPerSecond * MAX_UTTERANCE_SECONDS)
      return;
    if (this.options.cacheKey) this.frames.push(payload);
    this.emit(payload);
  }

  private emit(payload: string): void {
    if (this.released) {
      this.transmit(payload);
      return;
    }
    this.pending.push(payload);
    this.releasing ??= this.release();
    void this.releasing.catch(() => undefined);
  }

  private async release(): Promise<void> {
    const committedAt = await this.gate.until(this.signal);
    const floor = committedAt + (this.options.floorMs ?? 0) - Date.now();
    if (floor > 0) await delay(floor, this.signal);
    this.signal.throwIfAborted();
    for (const payload of this.pending.splice(0)) this.transmit(payload);
    this.released = true;
  }

  private transmit(payload: string): void {
    this.host.transport.audio(payload);
    this.sentAudio = true;
    if (!this.counted) {
      this.counted = true;
      this.host.streamOpened();
    }
    if (this.firstAudioAt) return;
    this.firstAudioAt = Date.now();
    this.host.trace.log("speech.first_audio_sent", {
      speechId: this.speechId,
      ms: this.firstAudioAt - this.opened,
    });
    this.options.onFirstAudio?.(this.firstAudioAt);
  }

  private replayCached(frames: readonly string[]): void {
    this.host.trace.log("speech.cache_hit", { speechId: this.speechId });
    for (const payload of frames) {
      this.audioBytes += base64ByteLength(payload);
      this.emit(payload);
    }
  }

  private storeInCache(): void {
    const { cacheKey } = this.options;
    if (!cacheKey || this.cacheHit || !this.frames.length) return;
    sharedCache.set(cacheKey, this.frames);
  }
}

export interface StreamHost {
  readonly voiceId: string;
  readonly voice: SessionInit["agent"]["voice"];
  readonly format: SessionInit["outputAudioFormat"];
  readonly bytesPerSecond: number;
  readonly transport: AudioOutputPort;
  readonly trace: SessionInit["trace"];
  synthesize: SynthesizerFactory;
  drain: (signal: AbortSignal, timeoutMs: number) => Promise<void>;
  clearIfSent: (sent: boolean) => void;
  streamOpened: () => void;
  streamClosed: () => void;
}

export class SpeechOutput {
  private readonly pending = new Map<string, () => void>();
  private activeStreams = 0;
  private lastClear = 0;
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

  get active(): boolean {
    return this.activeStreams > 0;
  }

  mark(name: string): void {
    this.init.trace.log(
      this.pending.has(name) ? "playback.acknowledged" : "playback.stale_mark",
      { mark: name },
    );
    this.pending.get(name)?.();
  }

  clear(): void {
    const now = Date.now();
    if (now - this.lastClear < 100) return;
    this.lastClear = now;
    this.init.trace.log("playback.clear");
    this.transport.clear();
  }

  open(signal: AbortSignal, options: SpeechStreamOptions = {}): SpeechStream {
    return new SpeechStream(
      {
        voiceId: this.init.agent.voiceId,
        voice: this.init.agent.voice,
        format: this.init.outputAudioFormat,
        bytesPerSecond: this.bytesPerSecond,
        transport: this.transport,
        trace: this.init.trace,
        synthesize: this.synthesize,
        drain: (s, timeoutMs) => this.drain(s, timeoutMs),
        clearIfSent: (sent) => {
          if (sent) this.clear();
        },
        streamOpened: () => void this.activeStreams++,
        streamClosed: () => void (this.activeStreams = Math.max(0, this.activeStreams - 1)),
      },
      signal,
      options,
    );
  }

  cacheKey(text: string): string {
    return speechCacheKey(this.init.agent, text, this.init.outputAudioFormat);
  }

  async speak(
    text: string,
    signal: AbortSignal,
    waitMs = 0,
    cache = false,
  ): Promise<void> {
    if (!text.trim() || signal.aborted) return;
    const stream = this.open(signal, {
      floorMs: waitMs,
      cacheKey: cache ? this.cacheKey(text) : undefined,
      prepared: cache && this.init.preparedOpening?.key === this.cacheKey(text)
        ? this.init.preparedOpening : undefined,
    });
    stream.write(text);
    try {
      await stream.finish();
    } catch (error) {
      if (!signal.aborted && cache && this.init.preparedOpening && !this.init.preparedOpening.usable && !stream.firstAudioAt) {
        this.init.trace.log("opening.preparation_fallback");
        const retry = this.open(signal, { floorMs: waitMs, cacheKey: this.cacheKey(text) });
        retry.write(text);
        await retry.finish();
      } else throw error;
    }
  }

  async play(audio: Buffer, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    this.activeStreams++;
    try {
      for (let i = 0; i < audio.length; i += 160) {
        signal.throwIfAborted();
        this.transport.audio(audio.subarray(i, i + 160).toString("base64"));
      }
      await this.drain(
        signal,
        (audio.length * 1000) / this.bytesPerSecond + 10000,
      );
    } finally {
      this.activeStreams = Math.max(0, this.activeStreams - 1);
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
        this.init.trace.log("playback.timeout", { mark: name, timeoutMs });
        reject(new Error("Audio playback acknowledgement timed out."));
      }, timeoutMs);
      this.pending.set(name, () => {
        cleanup();
        resolve();
      });
      signal.addEventListener("abort", abort, { once: true });
      try {
        this.init.trace.log("playback.mark_sent", { mark: name, timeoutMs });
        this.transport.mark(name);
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  }
}

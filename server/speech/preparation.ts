import { createHash } from "node:crypto";
import type { AgentConfig } from "../../lib/types";
import type {
  AudioFormat,
  ProviderTrace,
  SpeechSynthesizer,
  SynthesizerFactory,
} from "../core/ports";
import type { CallTrace } from "../observability/trace";
import { UsageMeter } from "../billing/meter";
import { AudioCache } from "./audio-cache";

export const speechCache = new AudioCache();
export const speechCacheKey = (
  agent: AgentConfig,
  text: string,
  format?: AudioFormat,
): string =>
  createHash("sha256")
    .update(
      JSON.stringify([
        agent.id,
        agent.voiceId,
        agent.voice,
        format?.encoding ?? "mulaw",
        format?.sampleRate ?? 8000,
        text,
      ]),
    )
    .digest("hex");

export class PreparedOpening {
  readonly usage = new UsageMeter();
  readonly done: Promise<void>;
  readonly key: string;
  private readonly frames: string[] = [];
  private readonly listeners = new Set<(payload: string) => void>();
  private readonly logs: Parameters<ProviderTrace["log"]>[] = [];
  private trace?: CallTrace;
  private synth?: SpeechSynthesizer;
  private failed?: Error;
  private stopped = false;
  private reject!: (error: Error) => void;
  private timer?: NodeJS.Timeout;
  private bytes = 0;

  constructor(
    readonly agent: AgentConfig,
    synthesize: SynthesizerFactory,
  ) {
    this.key = speechCacheKey(agent, agent.firstMessage);
    const cached = speechCache.get(this.key);
    if (cached) {
      this.frames.push(...cached);
      this.stopped = true;
      this.done = Promise.resolve();
      return;
    }
    const started = Date.now();
    this.done = new Promise<void>((resolve, reject) => {
      this.reject = reject;
      this.timer = setTimeout(
        () => this.cancel(new Error("Opening preparation timed out.")),
        8000,
      );
      this.timer.unref();
      try {
        this.synth = synthesize(
          agent.voiceId,
          (payload) => {
            if (this.stopped) return;
            this.bytes += payload.length * 2;
            if (this.bytes > 2 * 1024 * 1024) {
              this.cancel(
                new Error("Prepared opening exceeded the audio limit."),
              );
              return;
            }
            this.frames.push(payload);
            for (const listener of this.listeners) listener(payload);
          },
          agent.voice,
          undefined,
          {
            usage: this.usage,
            log: (event, detail = {}) => {
              if (this.trace)
                this.trace.log(event, { ...detail, preparedOpening: true });
              else if (this.logs.length < 30) this.logs.push([event, detail]);
            },
          },
        );
        void this.synth
          .push(agent.firstMessage)
          .then(() => this.synth!.end())
          .then(() => {
            if (this.stopped) return;
            if (!this.frames.length)
              throw new Error("Prepared opening has no audio.");
            speechCache.set(this.key, this.frames);
            this.trace?.log("opening.prepared", { ms: Date.now() - started });
            this.stopped = true;
            clearTimeout(this.timer);
            this.synth?.close();
            resolve();
          })
          .catch((error: unknown) =>
            this.cancel(
              error instanceof Error
                ? error
                : new Error("Opening preparation failed."),
            ),
          );
      } catch (error) {
        this.cancel(
          error instanceof Error
            ? error
            : new Error("Opening preparation failed."),
        );
      }
    });
    void this.done.catch(() => undefined);
  }

  get usable(): boolean {
    return !this.failed;
  }
  bind(trace: CallTrace): void {
    if (this.trace) return;
    this.trace = trace;
    const detach = trace.usage.include(this.usage);
    void this.done.then(detach, detach);
    for (const [event, detail] of this.logs.splice(0))
      trace.log(event, { ...detail, preparedOpening: true });
    trace.log("opening.bound", {
      bufferedFrames: this.frames.length,
      ready: this.stopped && !this.failed,
    });
  }
  subscribe(receive: (payload: string) => void): () => void {
    for (const frame of this.frames) receive(frame);
    this.listeners.add(receive);
    return () => this.listeners.delete(receive);
  }
  cancel(error = new Error("Opening preparation cancelled.")): void {
    if (this.stopped) return;
    this.stopped = true;
    this.failed = error;
    clearTimeout(this.timer);
    this.synth?.close();
    this.reject(error);
    this.listeners.clear();
  }
}

export class OpeningPreparation {
  private readonly pending = new Map<
    string,
    { audio: PreparedOpening; timer: NodeJS.Timeout; sid?: string }
  >();
  constructor(
    private readonly synthesize: SynthesizerFactory,
    private readonly capacity = 64,
  ) {}
  start(callId: string, agent: AgentConfig): void {
    if (
      agent.firstMessageMode !== "assistant-speaks-first" ||
      !agent.firstMessage.trim() ||
      !agent.voiceId ||
      this.pending.has(callId) ||
      this.pending.size >= this.capacity
    )
      return;
    const audio = new PreparedOpening(agent, this.synthesize);
    const timer = setTimeout(() => this.cancel(callId), 90_000);
    timer.unref();
    this.pending.set(callId, { audio, timer });
  }
  bind(callId: string, sid: string, trace: CallTrace): void {
    const entry = this.pending.get(callId);
    if (!entry || (entry.sid && entry.sid !== sid)) return;
    entry.sid = sid;
    entry.audio.bind(trace);
  }
  take(sid: string): PreparedOpening | undefined {
    for (const [id, entry] of this.pending) {
      if (entry.sid !== sid) continue;
      clearTimeout(entry.timer);
      this.pending.delete(id);
      return entry.audio.usable ? entry.audio : undefined;
    }
  }
  cancelCall(sid: string): void {
    for (const [id, entry] of this.pending)
      if (entry.sid === sid) this.cancel(id);
  }
  cancel(callId: string): void {
    const entry = this.pending.get(callId);
    if (!entry) return;
    entry.audio.cancel();
    clearTimeout(entry.timer);
    this.pending.delete(callId);
  }
  close(): void {
    for (const id of this.pending.keys()) this.cancel(id);
  }
}

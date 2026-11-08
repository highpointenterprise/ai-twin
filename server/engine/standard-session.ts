import { env } from "../../lib/env";
import { logError } from "../core/errors";
import type { ChatMessage, ConversationSession, EngineDeps, SessionInit, SpeechSynthesizer, Transcriber } from "../core/ports";
import { ConversationMemory } from "./memory";
import { buildSystemPrompt, SUMMARY_PROMPT } from "./prompt";

const FILLER = "Hmm, ";
const FILLER_DELAY_MS = 800;
const NUDGE = "Are you still there?";
const RECOVERY = "Sorry, I lost you for a second. Could you say that again?";
const SILENCE_MS = 8000;
const MAX_NUDGES = 2;
const MIN_BARGE_IN_WORDS = 2;
const SENTENCE_END = /[.!?…]+["')\]]*\s+/g;

const splitSentences = (text: string): { sentences: string[]; rest: string } => {
  const sentences: string[] = [];
  let cursor = 0;
  for (const match of text.matchAll(SENTENCE_END)) {
    const end = (match.index ?? 0) + match[0].length;
    sentences.push(text.slice(cursor, end));
    cursor = end;
  }
  return { sentences, rest: text.slice(cursor) };
};

interface Turn {
  readonly transcript: string;
  readonly abort: AbortController;
  readonly synth: SpeechSynthesizer;
  readonly confirmed: Promise<void>;
  readonly confirm: () => void;
  readonly startedAt: number;
  readonly eager: boolean;
  isConfirmed: boolean;
  confirmedAt: number | null;
  firstAudioAt: number | null;
  latencyMs: number | undefined;
  spoken: string;
  committed: boolean;
}

export class StandardSession implements ConversationSession {
  private readonly transcriber: Transcriber;
  private readonly memory: ConversationMemory;
  private readonly startedAt = Date.now();
  private turn: Turn | null = null;
  private playing = false;
  private nudges = 0;
  private markSeq = 0;
  private lastMark = "";
  private silenceTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly init: SessionInit,
    private readonly deps: EngineDeps,
  ) {
    const { agent, brief, trace } = init;
    this.memory = new ConversationMemory(buildSystemPrompt(agent, brief), (prior, turns) => this.summarize(prior, turns), trace);
    this.transcriber = deps.transcribe({
      onSpeechStart: () => this.clearSilenceTimer(),
      onPartial: (text) => this.handlePartial(text),
      onEagerEnd: (text) => {
        trace.log("stt.eager_end", { text });
        this.startTurn(text, false);
      },
      onResume: () => {
        trace.log("stt.turn_resumed");
        this.cancelTurn();
      },
      onEnd: (text) => {
        trace.log("stt.end_of_turn", { text });
        this.confirmTurn(text);
      },
      onError: (error) => trace.log("stt.error", { message: error.message }),
    });
    trace.log("session.started", { mode: "standard", agent: agent.name, voice: agent.voiceId, model: agent.model });
    void this.say(agent.greeting).catch(logError);
  }

  pushAudio(payload: string): void {
    this.transcriber.sendAudio(Buffer.from(payload, "base64"));
  }

  handleMark(name: string): void {
    if (name !== this.lastMark) return;
    this.playing = false;
    this.init.trace.log("playback.done");
    this.armSilenceTimer();
  }

  close(): void {
    this.clearSilenceTimer();
    this.cancelTurn();
    this.transcriber.close();
    this.init.trace.log("session.closed");
  }

  private async summarize(prior: string, turns: ChatMessage[]): Promise<string> {
    const text = turns.map((turn) => `${turn.role === "user" ? "Caller" : "Agent"}: ${turn.content}`).join("\n");
    return this.deps.model.complete({
      model: env.OPENAI_SUMMARY_MODEL,
      temperature: 0.2,
      messages: [
        { role: "system", content: SUMMARY_PROMPT },
        { role: "user", content: `Existing memory:\n${prior || "(none)"}\n\nNew conversation:\n${text}` },
      ],
    });
  }

  private handlePartial(text: string): void {
    this.clearSilenceTimer();
    const words = text.split(/\s+/).filter(Boolean).length;
    const agentIsSpeaking = this.playing || this.turn?.isConfirmed === true;
    if (agentIsSpeaking && words >= MIN_BARGE_IN_WORDS) {
      this.init.trace.log("barge_in", { words, text });
      this.cancelTurn(true);
      this.playing = false;
      this.init.send({ event: "clear", streamSid: this.init.streamSid });
    }
  }

  private confirmTurn(transcript: string): void {
    const text = transcript.trim();
    if (!text) return;
    this.init.trace.say("caller", text);
    this.nudges = 0;
    this.clearSilenceTimer();
    if (this.turn?.transcript === text && !this.turn.abort.signal.aborted) {
      this.turn.confirm();
      return;
    }
    this.startTurn(text, true);
  }

  private startTurn(transcript: string, confirmed: boolean): void {
    const text = transcript.trim();
    if (!text) return;
    const turn = this.createTurn(text, confirmed);
    this.init.trace.log("turn.start", { eager: !confirmed });
    void this.respond(turn).catch((error: unknown) => {
      if (turn.abort.signal.aborted) return;
      this.init.trace.log("turn.failed", { message: error instanceof Error ? error.message : "unknown" });
      void this.say(RECOVERY).catch(logError);
    });
  }

  private createTurn(transcript: string, alreadyConfirmed: boolean): Turn {
    this.cancelTurn();
    const { trace, send, streamSid, agent } = this.init;
    const abort = new AbortController();
    let release = (): void => undefined;
    const confirmed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const turn: Turn = {
      transcript,
      abort,
      confirmed,
      startedAt: Date.now(),
      eager: !alreadyConfirmed,
      confirm: () => {
        turn.isConfirmed = true;
        turn.confirmedAt = Date.now();
        release();
      },
      isConfirmed: false,
      confirmedAt: null,
      firstAudioAt: null,
      latencyMs: undefined,
      spoken: "",
      committed: false,
      synth: this.deps.synthesize(agent.voiceId, (payload) => {
        if (abort.signal.aborted) return;
        if (turn.firstAudioAt === null) {
          turn.firstAudioAt = Date.now();
          if (turn.confirmedAt !== null && turn.transcript) turn.latencyMs = turn.firstAudioAt - turn.confirmedAt;
          trace.log("tts.first_audio", {
            eot_to_audio_ms: turn.latencyMs ?? 0,
            pipeline_ms: turn.firstAudioAt - turn.startedAt,
            eager: turn.eager,
          });
        }
        this.playing = true;
        send({ event: "media", streamSid, media: { payload } });
      }),
    };
    if (alreadyConfirmed) turn.confirm();
    this.turn = turn;
    return turn;
  }

  private cancelTurn(interrupted = false): void {
    const turn = this.turn;
    if (!turn) return;
    this.turn = null;
    this.commit(turn, interrupted);
    turn.abort.abort();
    turn.synth.close();
  }

  private commit(turn: Turn, interrupted: boolean): void {
    if (turn.committed || !turn.isConfirmed || !turn.spoken.trim()) return;
    turn.committed = true;
    const spoken = turn.spoken.trim();
    if (turn.transcript) this.memory.add("user", turn.transcript);
    this.memory.add("assistant", spoken);
    this.init.trace.say("agent", interrupted ? `${spoken} [interrupted]` : spoken, turn.latencyMs);
  }

  private async say(text: string): Promise<void> {
    const turn = this.createTurn("", true);
    await this.speak(turn, text);
    await this.finish(turn);
  }

  private async respond(turn: Turn): Promise<void> {
    const { trace, agent } = this.init;
    let filler: NodeJS.Timeout | undefined;
    void turn.confirmed.then(() => {
      filler = setTimeout(() => {
        trace.log("filler.played");
        void this.speak(turn, FILLER).catch(() => undefined);
      }, FILLER_DELAY_MS);
    });

    try {
      const minutes = Math.floor((Date.now() - this.startedAt) / 60000);
      const messages: ChatMessage[] = [
        ...this.memory.messages(`Elapsed call time: ${minutes} minutes.`),
        { role: "user", content: turn.transcript },
      ];
      let pending = "";
      let first = true;
      for await (const piece of this.deps.model.stream({ messages, model: agent.model, temperature: agent.temperature }, turn.abort.signal)) {
        if (first) {
          first = false;
          trace.log("llm.first_token", { ms: Date.now() - turn.startedAt });
        }
        pending += piece;
        const { sentences, rest } = splitSentences(pending);
        pending = rest;
        for (const sentence of sentences) {
          clearTimeout(filler);
          await this.speak(turn, sentence);
        }
      }
      clearTimeout(filler);
      await this.speak(turn, pending);
      await this.finish(turn);
    } finally {
      clearTimeout(filler);
    }
  }

  private async speak(turn: Turn, text: string): Promise<void> {
    if (!text.trim()) return;
    await turn.confirmed;
    if (turn.abort.signal.aborted) return;
    turn.spoken += text;
    this.init.trace.log("tts.sentence", { text: text.trim() });
    await turn.synth.push(text);
  }

  private async finish(turn: Turn): Promise<void> {
    await turn.confirmed;
    if (turn.abort.signal.aborted) return;
    await turn.synth.end();
    if (turn.abort.signal.aborted) return;
    this.commit(turn, false);
    if (this.turn === turn) this.turn = null;
    this.lastMark = `turn-${++this.markSeq}`;
    this.init.send({ event: "mark", streamSid: this.init.streamSid, mark: { name: this.lastMark } });
    this.init.trace.log("turn.done", { total_ms: Date.now() - turn.startedAt });
  }

  private armSilenceTimer(): void {
    this.clearSilenceTimer();
    if (this.turn || this.nudges >= MAX_NUDGES) return;
    this.silenceTimer = setTimeout(() => {
      this.nudges += 1;
      this.init.trace.log("silence.nudge", { count: this.nudges });
      void this.say(NUDGE).catch(logError);
    }, SILENCE_MS);
  }

  private clearSilenceTimer(): void {
    clearTimeout(this.silenceTimer);
    this.silenceTimer = undefined;
  }
}

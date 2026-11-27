import {
  callHandlingSchema,
  screeningSchema,
  voicemailSchema,
} from "../../lib/config";
import { randomUUID } from "node:crypto";
import type {
  ChatMessage,
  ConversationSession,
  EngineDeps,
  SessionInit,
  ToolCall,
  Transcriber,
} from "../core/ports";
import { SpeechOutput, type SpeechStream } from "../speech/output";
import { audioRms } from "../speech/audio";
import { TurnGate } from "../speech/gate";
import { SpeechSegmenter } from "../speech/segmenter";
import { delay, normalizePhrase, shouldInterrupt } from "../speech/timing";
import { continuationHoldMs } from "./turn-policy";
import { CallHandling, type HandlingResult } from "../calls/detection";
import { BeepDetector } from "../calls/beep";
import { RingbackDetector } from "../calls/ringback";
import { errorDetail } from "../observability/diagnostics";

import {
  modelTools,
  phraseTransfer,
  transferInstructions,
} from "../tools/definitions";

import { buildSystemPrompt, IVR_RULES, isIvrMenu, TOOL_RULES } from "./prompt";

export class StandardSession implements ConversationSession {
  private readonly output: SpeechOutput;
  private readonly transcriber?: Transcriber;
  private readonly handling: CallHandling;
  private readonly beep: BeepDetector;
  private readonly ringback: RingbackDetector;
  private readonly handlingTimer: NodeJS.Timeout;
  private readonly began = Date.now();
  private menuPending = false;
  private readonly history: ChatMessage[] = [];
  private turn?: AbortController;
  private running: Promise<void> = Promise.resolve();
  private closed = false;
  private ending = false;
  private dtmfHandoff = false;
  private backoffUntil = 0;
  private voicedMs = 0;
  private waitingForScreener = false;
  private idleTimer?: NodeJS.Timeout;
  private readonly deadline: number;
  private readonly durationTimer: NodeJS.Timeout;
  private readonly executed = new Map<string, unknown>();
  private speculation?: {
    text: string;
    gate: TurnGate;
    controller: AbortController;
  };
  private pendingHold?: { text: string; timer: NodeJS.Timeout };
  private carry = "";
  private eotAt = 0;
  private firstAudioLatencyMs?: number;

  constructor(
    private readonly init: SessionInit,
    private readonly deps: EngineDeps,
  ) {
    init = {
      ...init,
      agent: {
        ...init.agent,
        callHandling: callHandlingSchema.parse(init.agent.callHandling ?? {}),
        callScreening: screeningSchema.parse(init.agent.callScreening ?? {}),
        voicemailDetection: voicemailSchema.parse(
          init.agent.voicemailDetection ?? {},
        ),
      },
    };
    const keypad = init.tools?.find((tool) => tool.type === "dtmf");
    if (keypad?.type === "dtmf" && keypad.navigation) {
      init = {
        ...init,
        agent: {
          ...init.agent,
          callHandling: { ...init.agent.callHandling, ...keypad.navigation },
        },
      };
    }
    this.init = init;
    init.trace.log("session.tools", {
      tools: JSON.stringify(
        (init.tools ?? []).map((t) => ({
          id: t.id,
          name: t.name,
          type: t.type,
        })),
      ),
      navigation: JSON.stringify(init.agent.callHandling),
    });
    init.trace.log("session.initializing", {
      agentId: init.agent.id,
      voiceId: init.agent.voiceId,
      model: init.agent.model,
      firstMessageMode: init.agent.firstMessageMode,
      purpose: init.purpose ?? "conversation",
      direction: init.direction ?? "unknown",
      inputFormat: init.inputAudioFormat?.encoding ?? "mulaw",
      outputFormat: init.outputAudioFormat?.encoding ?? "mulaw",
    });
    this.history.push(...structuredClone(init.history ?? []));
    for (const message of this.history) {
      if (message.role === "tool" && message.toolCallId) {
        try { this.executed.set(message.toolCallId, JSON.parse(message.content)); } catch {}
      }
    }
    this.deadline =
      init.deadline ?? Date.now() + init.agent.maxDurationSeconds * 1000;
    this.output = new SpeechOutput(init, deps.synthesize);
    this.handling = new CallHandling(
      init.agent,
      init.trace,
      init.direction === "outbound",
      (init.tools ?? []).some((tool) => tool.type === "dtmf"),
      Date.now(),
      !init.purpose || init.purpose === "conversation",
    );
    if (init.dtmfResume) this.handling.resume(init.dtmfResume.handling);
    this.beep = new BeepDetector(init.inputAudioFormat);
    this.ringback = new RingbackDetector(init.inputAudioFormat);
    this.handlingTimer = setInterval(
      () => { if (!this.dtmfHandoff) this.handleDecision(this.handling.tick()); },
      100,
    );
    this.handlingTimer.unref();
    this.durationTimer = setTimeout(
      () => void this.end("max-duration"),
      Math.max(0, this.deadline - Date.now()),
    );
    if (init.purpose !== "voicemail" && !init.endAfterFirstMessage) {
      this.transcriber = deps.transcribe(
        {
          onSpeechStart: () => {
            if (this.dtmfHandoff || this.closed) return;
            init.trace.log("stt.speech_started");
            this.handling.speechStart();
            if (this.menuPending) {
              this.interrupt("menu-speech-started");
              this.menuPending = false;
            }
            this.voicedMs = 0;
            this.resumeHeldTurn();
            if (this.speculating) this.cancelSpeculation();
            if (!this.turn) this.armIdle();
          },
          onPartial: (text) => {
            if (this.dtmfHandoff || this.closed) return;
            if (text.trim()) this.ringback.reset();
            const decision = this.handling.observe(text, false);
            this.handleDecision(decision);
            if (
              this.turn &&
              !this.speculating &&
              !this.handling.automated &&
              shouldInterrupt(text, init.agent.stopSpeakingPlan)
            )
              this.interrupt("partial-transcript");
          },
          onEagerEnd: (text) => this.maybeSpeculate(text),
          onResume: () => {
            if (this.dtmfHandoff || this.closed) return;
            init.trace.log("stt.turn_resumed");
            if (
              this.handling.state === "voicemail-speaking" ||
              this.handling.sendingDtmf
            )
              return;
            if (this.speculating) this.cancelSpeculation();
            else if (this.turn) this.interrupt("transcriber-turn-resumed");
          },
          onEnd: (text) => this.accept(text),
          onError: (error) => {
            if (this.dtmfHandoff || this.closed) return;
            init.trace.log("stt.error", { message: error.message });
            void this.end("transcriber-error");
          },
        },
        init.agent.transcriber,
        init.inputAudioFormat,
        init.trace,
      );
    }
    init.trace.log("session.started", {
      agent: init.agent.name,
      purpose: init.purpose ?? "conversation",
    });
    queueMicrotask(() => {
      if (this.closed || this.handling.automated) return;
      init.trace.log("session.opening", {
        mode: init.agent.firstMessageMode,
        characters: init.agent.firstMessage.length,
      });
      if (init.purpose === "voicemail")
        this.run(async (signal) => {
          await this.speak(init.agent.voicemailDetection.message, signal, true);
          await this.end("voicemail");
        });
      else if (init.agent.firstMessageMode === "assistant-waits-for-user")
        this.armIdle();
      else if (
        init.agent.firstMessageMode ===
        "assistant-speaks-first-with-model-generated-message"
      )
        this.run((signal) =>
          this.respond(signal, {
            opening:
              "Generate the opening of this call from the system prompt and call context. Do not invent a prior conversation. Use no tools for the opening.",
            allowTools: false,
          }),
        );
      else
        this.run(async (signal) => {
          await this.speak(init.agent.firstMessage, signal, true);
          if (init.endAfterFirstMessage)
            await this.end("warm-transfer-fallback-ended");
        });
    });
  }
  private get speculating(): boolean {
    return (
      !!this.speculation &&
      this.turn === this.speculation.controller &&
      !this.speculation.gate.isCommitted
    );
  }
  pushAudio(payload: string): void {
    if (this.closed || this.ending || this.dtmfHandoff || this.init.endAfterFirstMessage) return;
    const chunk = Buffer.from(payload, "base64");
    const format = this.init.inputAudioFormat ?? {
      encoding: "mulaw",
      sampleRate: 8000,
    };
    const voiced = audioRms(chunk, format.encoding) > 600;
    this.handling.audio(voiced);
    if (this.handling.canListenForRingback) {
      const ringing = this.ringback.push(chunk);
      if (ringing) this.handleDecision(this.handling.ringback(ringing));
    } else this.ringback.reset();
    if (
      this.init.direction === "outbound" &&
      this.init.agent.voicemailDetection.enabled &&
      (this.handling.awaitingBeep || this.handling.state === "unknown")
    ) {
      if (this.beep.push(chunk)) {
        this.init.trace.log("call.beep_detected");
        this.handleDecision(this.handling.beep());
      }
    } else this.beep.reset();
    if (voiced) {
      this.voicedMs +=
        (chunk.length * 1000) /
        (format.sampleRate * (format.encoding === "mulaw" ? 1 : 2));
      if (!this.turn) this.armIdle();
    } else this.voicedMs = 0;
    if (
      this.turn &&
      !this.speculating &&
      voiced &&
      !this.handling.automated &&
      this.init.agent.stopSpeakingPlan.numWords === 0 &&
      this.voicedMs >= this.init.agent.stopSpeakingPlan.voiceSeconds * 1000
    )
      this.interrupt("audio-voice-threshold");
    this.transcriber?.sendAudio(chunk);
  }
  handleMark(name: string): void {
    this.output.mark(name);
  }
  handleDtmf(digit: string): void {
    if (this.init.endAfterFirstMessage) return;
    if (!/^[0-9A-D*#]$/.test(digit)) return;
    this.init.trace.log("dtmf.received", { digit });
    this.accept(`[Caller pressed keypad ${digit}]`);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.idleTimer);
    clearTimeout(this.durationTimer);
    clearInterval(this.handlingTimer);
    this.handling.close();
    this.init.preparedOpening?.cancel();
    clearTimeout(this.pendingHold?.timer);
    this.turn?.abort();
    this.transcriber?.close();
    this.init.trace.log("session.closed");
    this.init.transportClose?.();
  }
  private interrupt(reason = "speech-detected"): void {
    if (!this.turn || this.ending || this.dtmfHandoff) return;
    this.init.trace.log("barge_in", {
      reason,
      state: this.handling.state,
      voicedMs: this.voicedMs,
      outputActive: this.output.active,
      menuPending: this.menuPending,
    });
    this.turn.abort();
    this.turn = undefined;
    this.output.clear();
    this.backoffUntil =
      Date.now() + this.init.agent.stopSpeakingPlan.backoffSeconds * 1000;
  }

  private lastAgentText(): string {
    return (
      this.history.findLast((m) => m.role === "assistant" && m.content)
        ?.content ?? ""
    );
  }

  private speculationBlocker(draft: string): string | undefined {
    const { agent } = this.init;
    if (!draft) return "empty";
    if (!this.handling.canSpeculate) return "answer-classification";
    if (this.closed || this.ending || this.dtmfHandoff) return "closed";
    if (this.turn) return "turn-active";
    if (this.output.active) return "audio-active";
    if (this.speculation) return "already-speculating";
    if (this.init.purpose && this.init.purpose !== "conversation")
      return "purpose";
    if (this.init.endAfterFirstMessage) return "fallback-session";
    if (
      (this.init.tools ?? []).some((t) => t.type === "dtmf") &&
      isIvrMenu(draft)
    )
      return "ivr-menu";
    if (Date.now() < this.backoffUntil) return "backoff";
    if (
      agent.stopSpeakingPlan.acknowledgementPhrases.some(
        (p) => normalizePhrase(p) === normalizePhrase(draft),
      )
    )
      return "acknowledgement";
    if (continuationHoldMs(draft, this.lastAgentText()) > 0)
      return "incomplete-utterance";
    return undefined;
  }

  private maybeSpeculate(text: string): void {
    const draft = text.trim();
    const blocker = this.speculationBlocker(draft);
    if (blocker) {
      this.init.trace.log("speculation.skipped", { reason: blocker });
      return;
    }
    const gate = new TurnGate();
    this.init.trace.log("speculation.started", { characters: draft.length });
    this.run((signal) => this.respond(signal, { draft, gate }));
    this.speculation = {
      text: normalizePhrase(draft),
      gate,
      controller: this.turn!,
    };
  }

  private cancelSpeculation(): void {
    const speculation = this.speculation;
    if (!speculation) return;
    this.speculation = undefined;
    this.init.trace.log("speculation.cancelled");
    speculation.controller.abort();
    if (this.turn === speculation.controller) this.turn = undefined;
  }

  private resumeHeldTurn(): void {
    if (!this.pendingHold) return;
    clearTimeout(this.pendingHold.timer);
    this.carry = this.pendingHold.text;
    this.pendingHold = undefined;
    this.init.trace.log("turn.continued");
  }

  private accept(transcript: string): void {
    const text = transcript.trim();
    if (!text || this.closed || this.ending || this.dtmfHandoff) return;
    this.ringback.reset();
    const wasAutomated = this.handling.automated;
    const decision = this.handling.observe(text, true);
    if (wasAutomated && decision.action === "conversation") this.interrupt("human-confirmed");
    if (decision.action !== "conversation") {
      this.init.trace.say("caller", text);
      this.handleDecision(decision, text);
      return;
    }
    // A final transcript can itself be a backchannel; don't cancel ongoing audio for it.
    if (
      !wasAutomated &&
      !this.speculating &&
      this.output.active &&
      !shouldInterrupt(text, this.init.agent.stopSpeakingPlan)
    )
      return;
    this.eotAt = Date.now();
    const merged = this.carry ? `${this.carry} ${text}` : text;
    const continued = merged !== text;
    this.carry = "";
    const hold = continued
      ? 0
      : continuationHoldMs(merged, this.lastAgentText());
    if (hold > 0) {
      this.init.trace.log("turn.hold", { ms: hold });
      this.pendingHold = {
        text: merged,
        timer: setTimeout(() => {
          this.pendingHold = undefined;
          this.waitingForScreener = false;
          this.menuPending = false;
          this.commit(merged);
        }, hold),
      };
      return;
    }
    this.waitingForScreener = false;
    this.menuPending = false;
    this.commit(merged);
  }

  private commit(text: string, logTranscript = true): void {
    if (this.closed || this.ending) return;
    const speculation = this.speculation;
    if (
      speculation &&
      speculation.text === normalizePhrase(text) &&
      this.turn === speculation.controller &&
      !speculation.controller.signal.aborted
    ) {
      this.speculation = undefined;
      this.init.trace.say("caller", text);
      this.history.push({ role: "user", content: text });
      this.init.trace.log("speculation.adopted");
      speculation.gate.commit();
      return;
    }
    if (speculation) this.cancelSpeculation();
    if (logTranscript) this.init.trace.say("caller", text);
    this.run(async (signal) => {
      this.history.push({ role: "user", content: text });
      if (Date.now() < this.backoffUntil)
        await delay(this.backoffUntil - Date.now(), signal);
      await this.respond(signal);
    });
  }

  private handleDecision(
    decision: HandlingResult,
    text = decision.text ?? "",
  ): void {
    if (this.closed || this.ending || this.dtmfHandoff || decision.action === "none") return;
    if (this.handling.screeningEncountered)
      this.deps.onScreening?.(this.init.callSid);
    if (decision.action === "hangup") {
      this.interrupt("call-ending");
      void this.end(decision.reason ?? "answer-detection-ended");
      return;
    }
    if (decision.action === "wait") {
      if (this.handling.sendingDtmf) return;
      if (this.speculating) this.cancelSpeculation();
      this.interrupt("automated-greeting");
      clearTimeout(this.pendingHold?.timer);
      this.pendingHold = undefined;
      this.carry = "";
      if (this.handling.automated) clearTimeout(this.idleTimer);
      return;
    }
    if (decision.action === "screen") {
      this.menuPending = false;
      this.run(async (signal) => {
        if (text) this.history.push({ role: "user", content: text });
        await this.speak(this.init.agent.callScreening.response, signal, true);
      }, true);
    } else if (decision.action === "leave-message") {
      this.menuPending = false;
      this.run(async (signal) => {
        await this.speak(
          this.init.agent.voicemailDetection.message,
          signal,
          true,
        );
        signal.throwIfAborted();
        await this.end("voicemail");
      });
    } else if (decision.action === "menu") {
      this.menuPending = true;
      this.init.trace.log("ivr.menu_ready", {
        elapsedMs: Date.now() - this.began,
      });
      this.commit(text, false);
    } else if (decision.action === "conversation" && text) {
      this.menuPending = false;
      this.waitingForScreener = false;
      this.commit(text);
    }
  }

  private run(
    action: (signal: AbortSignal) => Promise<void>,
    screening = false,
  ): void {
    this.turn?.abort();
    clearTimeout(this.idleTimer);
    const controller = new AbortController();
    this.turn = controller;
    this.running = this.running
      .then(async () => {
        controller.signal.throwIfAborted();
        await action(controller.signal);
      })
      .catch(async (error) => {
        if (controller.signal.aborted || this.closed) return;
        if (this.speculation?.controller === controller) {
          this.speculation = undefined;
          this.init.trace.log("speculation.failed", errorDetail(error));
          return;
        }
        this.init.trace.log("turn.failed", errorDetail(error));
        if (this.handling.automated) {
          if (this.handling.state === "voicemail-speaking")
            await this.end("speech-provider-error");
          return;
        }
        if (this.init.purpose === "warm-consultation") {
          await this.end("consultation-provider-error");
          return;
        }
        if (this.init.purpose === "meeting") {
          await this.end("meeting-provider-error");
          return;
        }
        if (this.init.endAfterFirstMessage) {
          await this.end("warm-transfer-fallback-error");
          return;
        }
        try {
          await this.speak(
            "Sorry, I couldn't complete that. Please try again.",
            controller.signal,
          );
        } catch (recoveryError) {
          this.init.trace.log(
            "speech.recovery_failed",
            errorDetail(recoveryError),
          );
          if (!controller.signal.aborted)
            await this.end("speech-provider-error");
        }
      })
      .finally(() => {
        if (this.speculation?.controller === controller)
          this.speculation = undefined;
        if (this.turn === controller) {
          this.turn = undefined;
          this.armIdle(screening);
        }
      });
  }

  private async speak(
    text: string,
    signal: AbortSignal,
    cache = false,
  ): Promise<void> {
    if (!text.trim()) return;
    signal.throwIfAborted();
    const began = Date.now();
    try {
      await this.output.speak(
        text,
        signal,
        this.init.agent.startSpeakingPlan.waitSeconds * 1000,
        cache,
      );
      signal.throwIfAborted();
      this.history.push({ role: "assistant", content: text });
      this.init.trace.say("agent", text);
      this.init.trace.log("playback.done", { ms: Date.now() - began });
    } catch (e) {
      if (signal.aborted) {
        this.history.push({
          role: "assistant",
          content: `${text} [interrupted; the caller may not have heard the full message]`,
        });
        this.init.trace.say("agent", `${text} [interrupted]`);
      }
      throw e;
    }
  }

  private markFirstAudio(at: number): void {
    if (!this.eotAt) return;
    this.firstAudioLatencyMs = at - this.eotAt;
    this.init.trace.log("turn.latency", {
      eot_to_first_audio_ms: this.firstAudioLatencyMs,
    });
    this.eotAt = 0;
  }

  private async finishSpeech(
    stream: SpeechStream,
    signal: AbortSignal,
    record: boolean,
  ): Promise<void> {
    const began = Date.now();
    try {
      const { spoken } = await stream.finish();
      if (!spoken || !record) return;
      this.history.push({ role: "assistant", content: spoken });
      this.init.trace.say("agent", spoken, this.firstAudioLatencyMs);
      this.firstAudioLatencyMs = undefined;
      this.init.trace.log("playback.done", { ms: Date.now() - began });
    } catch (error) {
      if (signal.aborted && record) this.recordInterrupted(stream);
      throw error;
    }
  }

  private readonly recorded = new WeakSet<SpeechStream>();

  private recordInterrupted(stream: SpeechStream): void {
    if (this.recorded.has(stream)) return;
    this.recorded.add(stream);
    const heard = stream.heardText();
    if (!heard) return;
    this.history.push({
      role: "assistant",
      content: `${heard} [interrupted; the caller heard only this much]`,
    });
    this.init.trace.say("agent", `${heard} [interrupted]`);
  }

  private systemContent(ivrRule: string): string {
    const tools = this.init.tools ?? [];
    return (
      buildSystemPrompt(this.init.agent, this.init.brief) +
      "\n" +
      TOOL_RULES +
      "\n" +
      transferInstructions(tools) +
      ivrRule
    );
  }

  private async respond(
    signal: AbortSignal,
    options: {
      opening?: string;
      allowTools?: boolean;
      draft?: string;
      gate?: TurnGate;
    } = {},
  ): Promise<void> {
    const { opening, draft, gate: turnGate } = options;
    const allowTools = options.allowTools ?? true;
    const { agent } = this.init;

    const tools = this.init.tools ?? [];
    const buffered =
      allowTools &&
      tools.some(
        (t) => t.type === "transferCall" && t.routingMode === "phrase",
      );
    for (let round = 0; round < 6; round++) {
      signal.throwIfAborted();
      this.trimHistory();
      const gate = round === 0 && turnGate ? turnGate : TurnGate.open();

      const hasDtmf = tools.some((t) => t.type === "dtmf");
      const ivrTurn =
        allowTools && hasDtmf && this.handling.state.startsWith("ivr");
      const ivrRule = hasDtmf
        ? "\n" +
          IVR_RULES +
          (ivrTurn
            ? `\nThe latest message is an automated phone menu. Call ${tools.find((t) => t.type === "dtmf")!.name} now. Do not speak.`
            : "")
        : "";

      const messages: ChatMessage[] = [
        {
          role: "system",
          content: this.systemContent(ivrRule),
        },
        ...this.history,
        ...(round === 0 && draft
          ? [{ role: "user" as const, content: draft }]
          : []),
      ];
      if (opening) messages.push({ role: "system", content: opening });
      let text = "";
      const calls: ToolCall[] = [];
      const began = Date.now();
      let first = true;
      const streaming = !buffered && !ivrTurn;
      const segmenter = new SpeechSegmenter();
      const stream = this.output.open(signal, {
        preconnect: !ivrTurn,
        gate,
        floorMs: agent.startSpeakingPlan.waitSeconds * 1000,
        onFirstAudio: (at) => this.markFirstAudio(at),
      });
      let toolRound = false;
      try {
        this.init.trace.log("llm.requested", {
          model: agent.model,
          round,
          opening: !!opening,
          speculative: !gate.isCommitted,
          messageCount: messages.length,
          toolCount: allowTools ? tools.length : 0,
          toolNames: allowTools ? tools.map((t) => t.name).join(",") : "",
          state: this.handling.state,
          forcedTool: ivrTurn ? tools.find((t) => t.type === "dtmf")!.name : "",
        });
        for await (const delta of this.deps.model.stream(
          {
            messages,
            model: agent.model,
            temperature: agent.temperature,
            tools: allowTools
              ? modelTools(
                  ivrTurn ? tools.filter((t) => t.type === "dtmf") : tools,
                )
              : [],
            toolChoice: ivrTurn
              ? tools.find((t) => t.type === "dtmf")!.name
              : undefined,
            trace: this.init.trace,
          },
          signal,
        )) {
          signal.throwIfAborted();
          if (first) {
            first = false;
            this.init.trace.log("llm.first_token", { ms: Date.now() - began });
          }
          if (delta.type === "text") {
            text += delta.text;
            if (streaming)
              for (const segment of segmenter.push(delta.text))
                stream.write(segment);
          } else calls.push(delta.call);
        }
        signal.throwIfAborted();
        if (streaming)
          for (const segment of segmenter.flush()) stream.write(segment);
        this.init.trace.log("llm.completed", {
          ms: Date.now() - began,
          characters: text.length,
          toolCalls: calls.length,
        });
        if (!calls.length) {
          if (!text.trim())
            throw new Error("OpenAI returned no speech text or tool calls.");
          if (ivrTurn) {
            this.init.trace.log("ivr.speech_suppressed", {
              characters: text.length,
            });
            return;
          }
          const route = allowTools ? phraseTransfer(tools, text) : undefined;
          if (!route) {
            if (!streaming) stream.write(text);
            await this.finishSpeech(stream, signal, true);
            return;
          }
          stream.write(route.spoken);
          await gate.until(signal);
          await this.finishSpeech(stream, signal, true);
          const call: ToolCall = {
            id: randomUUID(),
            name: route.tool.name,
            arguments: JSON.stringify({ destinationId: route.destinationId }),
          };
          this.history.push({
            role: "assistant",
            content: "",
            toolCalls: [call],
          });
          await this.execute(call, signal, true, route.tool.id);
          return;
        }

        if (!allowTools)
          throw new Error("Tools cannot execute during the opening.");
        toolRound = true;
        await gate.until(signal);
        this.history.push({
          role: "assistant",
          content: text,
          toolCalls: calls,
        });
        if (calls.length > 1) {
          for (const call of calls)
            this.history.push({
              role: "tool",
              toolCallId: call.id,
              content: JSON.stringify({ error: "Request one tool at a time." }),
            });
          await this.finishSpeech(stream, signal, false);
          continue;
        }
        const [call] = calls;
        const concurrent =
          tools.find((t) => t.name === call.name)?.type === "function";
        let outcome: { terminal?: boolean; waitForUser?: boolean };
        if (concurrent) {
          const [, result] = await Promise.all([
            this.finishSpeech(stream, signal, false),
            this.execute(call, signal),
          ]);
          outcome = result;
        } else {
          await this.finishSpeech(stream, signal, false);
          outcome = await this.execute(call, signal);
        }
        if (outcome.terminal || outcome.waitForUser) return;
      } catch (error) {
        if (this.dtmfHandoff && this.closed) return;
        this.init.trace.log(signal.aborted ? "llm.cancelled" : "llm.failed", {
          round,
          ms: Date.now() - began,
          state: this.handling.state,
          toolCalls: calls.length,
          message: signal.aborted
            ? "Turn interrupted"
            : error instanceof Error
              ? error.message
              : "Model failed",
        });
        if (signal.aborted && !toolRound) this.recordInterrupted(stream);
        throw error;
      } finally {
        stream.dispose();
      }
    }
    throw new Error("Tool execution round limit reached.");
  }

  private async execute(
    call: ToolCall,
    signal: AbortSignal,
    announced = false,
    explicitId?: string,
  ): Promise<{ terminal?: boolean; waitForUser?: boolean }> {
    const tool = (this.init.tools ?? []).find((t) =>
      explicitId ? t.id === explicitId : t.name === call.name,
    );
    let outcome: { result: unknown; terminal?: boolean; waitForUser?: boolean };
    try {
      signal.throwIfAborted();
      if (!tool || !this.deps.executeTool)
        throw new Error("Tool is not attached to this assistant.");
      if (tool.type === "dtmf" && !this.executed.has(call.id)) {
        const args = JSON.parse(call.arguments);
        if (
          !args ||
          typeof args.keys !== "string" ||
          !/^[0-9A-D*#wW]{1,32}$/.test(args.keys) ||
          !/[0-9A-D*#]/.test(args.keys)
        )
          throw new Error("Invalid DTMF sequence.");
        this.init.trace.log("dtmf.requested", {
          tool: tool.name,
          toolCallId: call.id,
          digitCount: args.keys.length,
          selection: args.keys.length === 1 ? args.keys : "[redacted sequence]",
          state: this.handling.state,
        });
        const denied = this.handling.beginDtmf();
        if (denied) {
          this.init.trace.log("ivr.selection_blocked", { reason: denied });
          if (denied === "IVR selection limit reached.")
            await this.end("ivr-navigation-limit");
          this.history.push({
            role: "tool",
            toolCallId: call.id,
            content: JSON.stringify({ error: denied }),
          });
          return { waitForUser: true };
        }
        this.menuPending = false;
        this.init.trace.log("dtmf.sending", {
          toolCallId: call.id,
          ...(tool.transport === "audio" ? { toneDurationMs: tool.toneDurationMs, gapMs: tool.gapMs } : { timing: "provider-managed" }),
          transport: this.init.sendDtmf ? "out-of-band" : tool.transport === "audio" ? "in-band-audio" : "provider",
        });
      }
      if (this.executed.has(call.id))
        outcome = {
          result: this.executed.get(call.id),
          ...(tool.type === "dtmf" ? { waitForUser: true } : {}),
        };
      else {
        this.init.trace.log("tool.started", {
          tool: tool.name,
          type: tool.type,
          toolCallId: call.id,
        });
        outcome = await this.deps.executeTool(tool, call, {
          callSid: this.init.callSid,
          trace: this.init.trace,
          snapshot: {
            mediaContextId: this.init.mediaContextId,
            handling: this.handling.checkpoint(),
            agent: this.init.agent,
            tools: this.init.tools ?? [],
            brief: this.init.brief,
            history: structuredClone(this.history),
            direction: this.init.direction ?? "inbound",
            deadline: this.deadline,
          },
          signal,
          handoff: (pending) => {
            this.dtmfHandoff = pending;
            this.init.holdMediaLease?.(pending);
          },
          speak: async (text) => {
            if (announced) return;
            await this.output.speak(text, signal);
            if (text) this.init.trace.say("agent", text);
          },
          playAudio: (audio) => this.output.play(audio, signal),
          sendDtmf: this.init.sendDtmf
            ? (keys, duration, gap) =>
                this.init.sendDtmf!(keys, duration, gap, signal)
            : undefined,
        });
        this.executed.set(call.id, outcome.result);
      }
      if (tool.type === "dtmf" && !outcome.terminal)
        this.init.trace.log("dtmf.tool_returned", {
          toolCallId: call.id,
          status: typeof outcome.result === "object" && outcome.result && "error" in outcome.result ? "failed" : "transport-completed",
          remoteRecognition: "unconfirmed",
        });
      this.init.trace.log("tool.completed", {
        tool: tool.name,
        toolCallId: call.id,
      });
    } catch (error) {
      outcome = {
        ...(tool?.type === "dtmf" ? { waitForUser: true } : {}),
        result: {
          error: signal.aborted
            ? "Interrupted; the operation may already have reached the remote service. Do not retry automatically."
            : error instanceof Error
              ? error.message
              : "Tool failed",
        },
      };
      this.init.trace.log("tool.failed", {
        aborted: signal.aborted,
        message: error instanceof Error ? error.message : "Tool failed",
        tool: call.name,
        toolCallId: call.id,
      });
    }
    if (tool?.type === "dtmf") this.handling.dtmfCompleted();
    this.history.push({
      role: "tool",
      toolCallId: call.id,
      content: JSON.stringify(outcome.result),
    });
    if (outcome.terminal) {
      this.ending = true;
      clearTimeout(this.idleTimer);
    }
    signal.throwIfAborted();
    return outcome;
  }
  private trimHistory(): void {
    // Trim complete conversational groups, preserving assistant/tool-result adjacency.
    if (this.history.length < 80) return;
    const boundary = this.history.findIndex(
      (m, i) => i > 30 && m.role === "user",
    );
    if (boundary > 0) this.history.splice(0, boundary);
  }
  private armIdle(screening = this.waitingForScreener): void {
    this.waitingForScreener = screening;
    clearTimeout(this.idleTimer);
    if (this.closed || this.ending || this.handling.automated) return;
    const seconds = screening
      ? this.init.agent.callScreening.waitSeconds
      : this.init.agent.silenceTimeoutSeconds;
    this.idleTimer = setTimeout(
      () => void this.end(screening ? "screening-timeout" : "silence-timeout"),
      seconds * 1000,
    );
  }
  private async end(reason: string): Promise<void> {
    if (this.closed || this.ending) return;
    this.ending = true;
    this.init.trace.log("call.ending", { reason });
    try {
      await this.deps.endCall?.(this.init.callSid, reason);
    } catch (error) {
      this.init.trace.log("call.end_failed", {
        message: error instanceof Error ? error.message : "unknown",
      });
    } finally {
      this.close();
    }
  }
}

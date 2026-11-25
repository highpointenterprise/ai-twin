import type { AgentConfig } from "../../lib/types";
import type { ProviderTrace } from "../core/ports";

export type CallKind = "unknown" | "human" | "voicemail" | "screening" | "ivr";
export type HandlingState =
  CallKind | "screening-wait" | "ivr-wait" | "voicemail-speaking" | "ended";
export type HandlingAction =
  | "none"
  | "conversation"
  | "wait"
  | "screen"
  | "menu"
  | "leave-message"
  | "hangup";
export interface Decision {
  kind: CallKind;
  confidence: number;
  evidence: string;
}
export interface HandlingResult {
  action: HandlingAction;
  reason?: string;
  text?: string;
}

const menuCue =
  /\b(?:press|dial|enter|select)\s+(?:\d|zero|one|two|three|four|five|six|seven|eight|nine|pound|star|hash|your (?:extension|account|pin))\b/gi;
const screenCue =
  /(?:state|say|tell|record|provide|leave).{0,40}(?:your name|name and).{0,65}(?:reason|purpose|why|after (?:the )?(?:tone|beep))|(?:call screening|screening (?:this|the|your) call)|(?:name and (?:the )?reason)|(?:if you tell me).{0,50}(?:name|calling)/i;
const holdCue =
  /\b(?:please (?:hold|wait)|one moment|try to connect|connect(?:ing)? you|let.{0,20}know|stay on the line|please stand by|all (?:our )?(?:agents|representatives).{0,20}busy)\b/i;
const humanCue =
  /^(?:(?:well|yes|okay)[,.! ]+)?(?:hello|hi|hey|yes\??$|how (?:can|may) I help|who(?:'s| is) (?:this|calling)|what.{0,15}calling|(?:this is |it's |it is )?[\p{L} '-]{1,35} speaking\b|I (?:need|want|can|am|was|would|don't|do not)|can (?:you|I)|sorry|thanks|thank you for (?:waiting|holding))/iu;

export function classifyAnswer(text: string, screening = false): Decision {
  const value = text.slice(-4000).trim();
  if (!value) return { kind: "unknown", confidence: 0, evidence: "empty" };
  const menus = value.match(menuCue)?.length ?? 0;
  if (
    screenCue.test(value) ||
    (screening && /who(?:'s| is) calling/i.test(value))
  )
    return {
      kind: "screening",
      confidence: 0.98,
      evidence: "identity-and-purpose-prompt",
    };
  if (menus && !/^(?:can|could|would) you\b/i.test(value))
    return {
      kind: "ivr",
      confidence: menus > 1 ? 0.98 : 0.91,
      evidence: "keypad-menu",
    };
  const message =
    /\b(?:please |you (?:can|may) )?(?:leave|record) (?:me |us |your |a |the )?(?:short |brief |voice )?message\b/i.test(
      value,
    );
  const tone = /\b(?:after|at) (?:the )?(?:tone|beep)\b/i.test(value);
  const mailbox =
    /\b(?:you(?:'ve| have) reached.{0,70}(?:voicemail|mailbox)|(?:mailbox|voicemail).{0,25}(?:full|not (?:set up|available))|(?:your|the) call has been (?:forwarded|sent).{0,45}(?:voicemail|voice message|messaging system))\b/i.test(
      value,
    );
  const unavailable =
    /\b(?:not available|(?:cannot|can't|unable to) (?:take|answer).{0,15}call|not here|away from (?:my|the) phone)\b/i.test(
      value,
    );
  const quoted =
    /\b(?:said|says|say|heard|mentioned|discuss|talk about).{0,15}(?:voicemail|leave.{0,5}message)\b/i.test(
      value,
    );
  if (mailbox || (message && (tone || unavailable) && !quoted))
    return {
      kind: "voicemail",
      confidence: 0.98,
      evidence: mailbox
        ? "mailbox-announcement"
        : "message-invitation-and-greeting",
    };
  if (
    message &&
    !quoted &&
    !/\b(?:would you|could you|can you|did you)\b/i.test(value)
  )
    return {
      kind: "voicemail",
      confidence: 0.78,
      evidence: "message-invitation",
    };
  if (holdCue.test(value))
    return { kind: "unknown", confidence: 0.8, evidence: "connection-hold" };
  if (
    tone ||
    unavailable ||
    /\b(?:thank you for calling|you have reached|welcome to|automated|recorded message)\b/i.test(
      value,
    )
  )
    return {
      kind: "unknown",
      confidence: 0.65,
      evidence: "incomplete-automated-greeting",
    };
  if (humanCue.test(value))
    return {
      kind: "human",
      confidence: 0.94,
      evidence: "conversational-greeting",
    };
  return { kind: "human", confidence: 0.7, evidence: "conversational-speech" };
}

export class CallHandling {
  state: HandlingState = "unknown";
  screeningEncountered = false;
  private stateSince: number;
  private readonly started: number;
  private initialResolved = false;
  private replies = 0;
  private selections = 0;
  private readonly menus = new Map<string, number>();
  private menuText = "";
  private menuPrefix = "";
  private menuFinalAt?: number;
  private lastVoiceAt = -Infinity;
  private speaking = false;
  private dtmfInFlight = false;
  private lastUnknown = "";
  private lastBeepAt = -Infinity;
  private lastDecision = "";

  constructor(
    private readonly agent: AgentConfig,
    private readonly trace: ProviderTrace,
    private readonly outbound: boolean,
    private readonly hasDtmf: boolean,
    now = Date.now(),
    private readonly enabled = true,
  ) {
    this.started = this.stateSince = now;
  }
  get sendingDtmf(): boolean {
    return this.dtmfInFlight;
  }
  get automated(): boolean {
    return !["unknown", "human"].includes(this.state);
  }
  get canSpeculate(): boolean {
    return (
      !this.enabled ||
      this.state === "human" ||
      (!this.outbound && !this.automated)
    );
  }
  get awaitingBeep(): boolean {
    return this.state === "voicemail";
  }
  speechStart(now = Date.now()): void {
    this.speaking = true;
    this.lastVoiceAt = now;
    this.menuFinalAt = undefined;
  }
  audio(voiced: boolean, now = Date.now()): void {
    if (voiced) this.lastVoiceAt = now;
  }
  beep(now = Date.now()): HandlingResult {
    this.lastBeepAt = now;
    if (this.state !== "voicemail") return { action: "none" };
    this.transition(
      "voicemail-speaking",
      {
        kind: "voicemail",
        confidence: 0.99,
        evidence: "confirmed-greeting-and-beep",
      },
      now,
    );
    return { action: "leave-message" };
  }
  observe(text: string, final: boolean, now = Date.now()): HandlingResult {
    if (!text.trim()) return { action: "none" };
    if (!this.enabled) return { action: final ? "conversation" : "none" };
    if (this.state === "ended") return { action: "wait" };
    if (final) this.speaking = false;
    let decision = classifyAnswer(
      text,
      this.screeningEncountered && this.state.startsWith("screening"),
    );
    if (
      this.state === "ivr" &&
      this.menuPrefix &&
      (decision.kind === "ivr" ||
        (decision.kind === "human" && decision.confidence < 0.9))
    ) {
      text = `${this.menuPrefix} ${text}`.slice(-4000);
      decision = classifyAnswer(text);
    }
    const fingerprint = `${decision.kind}:${decision.evidence}:${final}`;
    if (fingerprint !== this.lastDecision) {
      this.trace.log("call.detection", {
        ...decision,
        final,
        elapsedMs: now - this.started,
        scoreType: "rule-evidence",
      });
      this.lastDecision = fingerprint;
    }
    if (
      decision.kind === "screening" &&
      this.outbound &&
      this.agent.callScreening.enabled &&
      decision.confidence >= this.agent.callScreening.confidenceThreshold
    ) {
      this.screeningEncountered = true;
      this.initialResolved = true;
      this.transition("screening", decision, now);
      if (!final) return { action: "wait" };
      this.transition("screening-wait", decision, now);
      if (this.replies++ >= this.agent.callScreening.maxResponses)
        return this.finish("screening-timeout", now);
      return { action: "screen" };
    }
    if (
      decision.kind === "ivr" &&
      decision.confidence >= this.agent.callHandling.ivrConfidenceThreshold
    ) {
      this.initialResolved = true;
      this.menuText = text;
      if (final) this.menuPrefix = text;
      this.transition("ivr", decision, now);
      this.menuFinalAt = final ? now : undefined;
      return { action: "wait" };
    }
    if (
      decision.kind === "voicemail" &&
      this.outbound &&
      this.agent.voicemailDetection.enabled &&
      decision.confidence >= this.agent.voicemailDetection.confidenceThreshold
    ) {
      this.initialResolved = true;
      if (this.state === "voicemail-speaking") return { action: "none" };
      this.transition("voicemail", decision, now);
      if (this.agent.voicemailDetection.action === "hangup")
        return this.finish("voicemail", now);
      if (now - this.lastBeepAt < 1500) return this.beep(now);
      return { action: "wait" };
    }
    if (decision.kind === "human" && final) {
      if (this.automated && decision.confidence < 0.9)
        return {
          action: this.state === "voicemail-speaking" ? "none" : "wait",
        };
      this.initialResolved = true;
      this.transition("human", decision, now);
      this.menuFinalAt = undefined;
      return { action: "conversation" };
    }
    if (
      (decision.kind === "unknown" ||
        (decision.kind === "voicemail" &&
          this.agent.voicemailDetection.enabled) ||
        (decision.kind === "screening" && this.agent.callScreening.enabled) ||
        decision.kind === "ivr") &&
      this.outbound
    ) {
      if (this.state === "voicemail-speaking") return { action: "none" };
      if (final) this.lastUnknown = text;
      if (this.state === "human" && decision.evidence !== "connection-hold")
        return { action: final ? "conversation" : "none" };
      return { action: "wait" };
    }
    return { action: final && !this.automated ? "conversation" : "none" };
  }
  tick(now = Date.now()): HandlingResult {
    if (!this.enabled) return { action: "none" };
    if (
      this.hasDtmf &&
      this.state === "ivr" &&
      this.menuFinalAt !== undefined &&
      !this.speaking &&
      now - Math.max(this.lastVoiceAt, this.menuFinalAt) >=
        this.agent.callHandling.menuSilenceMs
    ) {
      this.menuFinalAt = undefined;
      this.stateSince = now;
      return { action: "menu", text: this.menuText };
    }
    if (
      this.state === "voicemail" &&
      now - this.stateSince >=
        this.agent.voicemailDetection.beepWaitSeconds * 1000
    ) {
      if (
        this.agent.voicemailDetection.beepTimeoutAction === "leave-message" &&
        !this.speaking &&
        now - this.lastVoiceAt >= this.agent.callHandling.menuSilenceMs
      ) {
        this.transition(
          "voicemail-speaking",
          {
            kind: "voicemail",
            confidence: 0.85,
            evidence: "configured-beep-timeout-fallback",
          },
          now,
        );
        return { action: "leave-message" };
      }
      return this.finish("voicemail-beep-timeout", now);
    }
    if (
      this.state.startsWith("screening") &&
      now - this.stateSince >= this.agent.callScreening.waitSeconds * 1000
    )
      return this.finish("screening-timeout", now);
    if (
      this.state.startsWith("ivr") &&
      !this.dtmfInFlight &&
      now - this.stateSince >= this.agent.callHandling.ivrWaitSeconds * 1000
    )
      return this.finish("ivr-timeout", now);
    if (
      this.outbound &&
      !this.initialResolved &&
      now - this.started >=
        this.agent.voicemailDetection.detectionTimeoutSeconds * 1000
    ) {
      this.initialResolved = true;
      if (
        this.agent.voicemailDetection.enabled &&
        this.agent.voicemailDetection.unknownAction === "hangup"
      )
        return this.finish("answer-detection-ended", now);
      const text = this.lastUnknown;
      this.lastUnknown = "";
      this.trace.log("call.detection_fallback", {
        action: "continue",
        elapsedMs: now - this.started,
      });
      return text ? { action: "conversation", text } : { action: "none" };
    }
    return { action: "none" };
  }
  beginDtmf(now = Date.now()): string | undefined {
    if (
      this.state !== "ivr" ||
      this.speaking ||
      now - this.lastVoiceAt < this.agent.callHandling.menuSilenceMs
    )
      return "Wait for a complete, quiet phone menu before sending keypad tones.";
    const key = this.menuText
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    const repeats = this.menus.get(key) ?? 0;
    if (
      this.selections >= this.agent.callHandling.maxMenuSelections ||
      repeats >= this.agent.callHandling.maxRepeatedMenuSelections
    )
      return "IVR selection limit reached.";
    this.menuPrefix = "";
    this.dtmfInFlight = true;
    this.selections++;
    this.menus.set(key, repeats + 1);
    this.transition(
      "ivr-wait",
      { kind: "ivr", confidence: 1, evidence: "keypad-selection-sent" },
      now,
    );
    return undefined;
  }
  dtmfCompleted(now = Date.now()): void {
    if (!this.dtmfInFlight) return;
    this.dtmfInFlight = false;
    if (this.state === "ivr-wait") this.stateSince = now;
  }
  close(): void {
    this.state = "ended";
  }
  private finish(reason: string, now: number): HandlingResult {
    this.trace.log("call.handling_ended", {
      reason,
      state: this.state,
      stateAgeMs: now - this.stateSince,
      selections: this.selections,
      speaking: this.speaking,
      quietMs: now - this.lastVoiceAt,
      dtmfInFlight: this.dtmfInFlight,
    });
    this.transition(
      "ended",
      { kind: "unknown", confidence: 0, evidence: reason },
      now,
    );
    return { action: "hangup", reason };
  }
  private transition(
    state: HandlingState,
    decision: Decision,
    now: number,
  ): void {
    if (state === this.state) return;
    const previous = this.state;
    this.state = state;
    this.stateSince = now;
    this.trace.log("call.state", {
      previous,
      state,
      ...decision,
      elapsedMs: now - this.started,
    });
  }
}

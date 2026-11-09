import type { AgentConfig } from "../../lib/types";
export type ScreeningDecision = "respond" | "wait" | "conversation";
// Explicit English device prompts only. This is not a guarantee against every screener.
export class ScreeningGate {
  encountered = false;
  private replies = 0;
  private active = false;
  constructor(private readonly plan: AgentConfig["callScreening"]) {}
  inspect(text: string): ScreeningDecision {
    if (!this.plan.enabled) return "conversation";
    const request =
      /(?:state|say|tell|record|provide).{0,35}(?:your name|name and|reason for|purpose of)|(?:call screening|screening (?:this|the) call)|who(?:'s| is) calling and/i.test(
        text,
      );
    if (request) {
      this.encountered = true;
      this.active = true;
      if (this.replies++ < 2) return "respond";
      return "wait";
    }
    if (
      this.active &&
      /(?:please (?:hold|wait)|one moment|try to connect|connect(?:ing)? you|let.{0,15}know|stay on the line)/i.test(
        text,
      )
    )
      return "wait";
    this.active = false;
    return "conversation";
  }
}

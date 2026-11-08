import type { AgentConfig } from "../../lib/types";

export const STYLE_RULES = [
  "You are speaking on a live phone call, so talk like a real person: short sentences, contractions, and small natural reactions.",
  "Keep most replies to one or two sentences and ask at most one question at a time.",
  "Never use lists, markdown, emojis or stage directions.",
  "Treat the call memory and earlier turns as things you already know: never repeat a fact, question, offer or greeting you have already given, and never ask for something the caller already told you.",
  "Write numbers, dates, currency and symbols the way they are spoken aloud.",
  "If the caller is unclear or the transcript looks garbled, ask them briefly to repeat instead of guessing.",
  "If you do not know something, say so plainly.",
].join(" ");

export const SUMMARY_PROMPT = [
  "You maintain the running memory of a phone call between an AI agent and a caller.",
  "Merge the existing memory with the new conversation into one updated memory under 250 words.",
  "Keep facts the caller shared (names, numbers, preferences), decisions and commitments, questions already asked and answered, topics already covered, and open items.",
  "Write plain prose with no preamble.",
].join(" ");

export const buildBrief = (context?: string, plannedMinutes?: number): string =>
  [
    context ? `Call objective and context:\n${context}` : "",
    plannedMinutes
      ? `Plan for a call of about ${plannedMinutes} minutes: pace the conversation, cover the objective, and wrap up naturally near the end.`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");

export const buildSystemPrompt = (agent: AgentConfig, brief: string): string =>
  [agent.systemPrompt, brief, STYLE_RULES].filter(Boolean).join("\n\n");

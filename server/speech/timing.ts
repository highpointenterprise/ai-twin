import type { AgentConfig } from "../../lib/types";
export const normalizePhrase = (s: string): string =>
  s
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
export const containsPhrase = (text: string, phrase: string): boolean =>
  ` ${normalizePhrase(text)} `.includes(` ${normalizePhrase(phrase)} `);
export const shouldInterrupt = (
  text: string,
  plan: AgentConfig["stopSpeakingPlan"],
): boolean => {
  if (plan.interruptionPhrases.some((p) => containsPhrase(text, p)))
    return true;
  if (
    plan.acknowledgementPhrases.some(
      (p) => normalizePhrase(p) === normalizePhrase(text),
    )
  )
    return false;
  return (
    plan.numWords > 0 &&
    normalizePhrase(text).split(/\s+/).filter(Boolean).length >= plan.numWords
  );
};
export function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const cancel = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", cancel);
      resolve();
    }, ms);
    signal.addEventListener("abort", cancel, { once: true });
  });
}

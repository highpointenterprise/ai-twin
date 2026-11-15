const MAX_HOLD_MS = 900;

const DANGLING_TAIL =
  /\b(?:and|but|or|so|because|if|that|which|who|with|to|for|of|the|a|an|my|our|your|at|in|on|about|then|also|plus|like|um+|uh+|er+|hmm+)[\s,.…-]*$/i;
const TRAILING_FILLER = /\b(?:um+|uh+|er+|hmm+)[\s,.…-]*$/i;
const ELLIPSIS_TAIL = /(?:\.{3}|…|,|-)\s*$/;
const NUMBER_REQUEST =
  /\b(?:phone|number|digits?|account|zip|postal|code|card|pin|extension)\b/i;
const DIGIT_WORDS =
  /\b(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)\b/gi;

const spokenDigitCount = (text: string): number =>
  (text.match(/\d/g)?.length ?? 0) + (text.match(DIGIT_WORDS)?.length ?? 0);

const isComplete = (text: string): boolean => /[?!]\s*$/.test(text);

export const continuationHoldMs = (
  transcript: string,
  lastAgentText: string,
): number => {
  const text = transcript.trim();
  if (!text || isComplete(text)) return 0;
  if (TRAILING_FILLER.test(text)) return MAX_HOLD_MS;
  if (DANGLING_TAIL.test(text)) return 700;
  if (ELLIPSIS_TAIL.test(text)) return 600;
  const digits = spokenDigitCount(text);
  if (digits > 0 && digits < 7 && NUMBER_REQUEST.test(lastAgentText)) return 800;
  return 0;
};

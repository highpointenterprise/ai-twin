export interface SegmenterOptions {
  readonly firstChunkMinWords: number;
  readonly minWords: number;
  readonly maxChars: number;
}

const DEFAULT_OPTIONS: SegmenterOptions = {
  firstChunkMinWords: 3,
  minWords: 4,
  maxChars: 160,
};

const FIRST_SENTENCE_MIN_WORDS = 2;
const BOUNDARY = /([.!?…]+["'”’)\]]*|[,;:—–])\s/g;
const ABBREVIATIONS = new Set([
  "mr",
  "mrs",
  "ms",
  "dr",
  "st",
  "vs",
  "inc",
  "ltd",
  "no",
  "etc",
  "approx",
  "e.g",
  "i.e",
  "a.m",
  "p.m",
]);

const countWords = (text: string): number =>
  text.split(/\s+/).filter(Boolean).length;

const endsWithAbbreviation = (head: string): boolean => {
  const token = head.match(/([\p{L}.]+)\.$/u)?.[1]?.toLocaleLowerCase();
  if (!token) return false;
  return ABBREVIATIONS.has(token) || /^\p{L}$/u.test(token);
};

export const toSpokenText = (text: string): string =>
  text
    .replace(/[*_`#~]+/g, "")
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/^\s*[-•]\s+/gm, "")
    .replace(/\s+/g, " ");

export class SpeechSegmenter {
  private buffer = "";
  private emitted = 0;

  constructor(private readonly options: SegmenterOptions = DEFAULT_OPTIONS) {}

  push(delta: string): string[] {
    this.buffer += delta;
    const segments: string[] = [];
    for (let cut = this.nextCut(); cut > 0; cut = this.nextCut()) {
      this.take(cut, segments);
    }
    return segments;
  }

  flush(): string[] {
    const remainder = toSpokenText(this.buffer).trim();
    this.buffer = "";
    if (!remainder) return [];
    this.emitted++;
    return [remainder];
  }

  private take(cut: number, into: string[]): void {
    const segment = toSpokenText(this.buffer.slice(0, cut)).trim();
    this.buffer = this.buffer.slice(cut);
    if (!segment) return;
    this.emitted++;
    into.push(segment);
  }

  private nextCut(): number {
    const first = this.emitted === 0;
    const sentenceMinimum = first ? FIRST_SENTENCE_MIN_WORDS : this.options.minWords;
    const oversized = this.buffer.length > this.options.maxChars;
    for (const match of this.buffer.matchAll(BOUNDARY)) {
      const end = (match.index ?? 0) + match[0].length;
      const head = this.buffer.slice(0, end - 1);
      const sentence = /[.!?…]/.test(match[1][0]);
      if (sentence && endsWithAbbreviation(head)) continue;
      const words = countWords(head);
      if (sentence) {
        if (words >= sentenceMinimum) return end;
        continue;
      }
      if ((first || oversized) && words >= this.options.firstChunkMinWords)
        return end;
    }
    if (this.buffer.length > this.options.maxChars * 1.5) {
      const space = this.buffer.lastIndexOf(" ", this.options.maxChars);
      return space > 0 ? space + 1 : -1;
    }
    return -1;
  }
}

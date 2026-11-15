import type { ToolConfig } from "../../lib/config";
import type { ModelTool } from "../core/ports";

type TransferTool = Extract<ToolConfig, { type: "transferCall" }>;

export interface PhraseRoute {
  tool: TransferTool;
  destinationId: string;
  spoken: string;
}

const WORD = /[\p{L}\p{N}]+/gu;

const isTransfer = (t: ToolConfig): t is TransferTool =>
  t.type === "transferCall";

export function modelTools(tools: ToolConfig[]): ModelTool[] {
  return tools
    .filter((t) => !isTransfer(t) || t.routingMode === "description")
    .map((t) => ({
      name: t.name,
      description:
        t.description +
        (isTransfer(t)
          ? " Destinations: " +
            t.destinations.map((d) => `${d.id}: ${d.description}`).join("; ")
          : t.type === "dtmf"
            ? " Press keypad digits on an automated phone menu. Use it only after the full menu has been heard; never speak to the menu instead."
            : ""),
      parameters:
        t.type === "function"
          ? t.parameters
          : t.type === "dtmf"
            ? {
                type: "object",
                properties: {
                  keys: {
                    type: "string",
                    description:
                      "Digits 0-9, *, #, A-D. w pauses 0.5s; W pauses 1s. Wait for the complete IVR menu; do not speak over tones.",
                  },
                },
                required: ["keys"],
                additionalProperties: false,
              }
            : {
                type: "object",
                properties: {
                  destinationId: {
                    type: "string",
                    enum: t.destinations.map((d) => d.id),
                  },
                },
                required: ["destinationId"],
                additionalProperties: false,
              },
    }));
}

export function transferInstructions(tools: ToolConfig[]): string {
  const transfers = tools.filter(isTransfer);
  if (!transfers.length)
    return "You cannot transfer calls. Never say you are transferring or ask the caller to hold.";
  const rules: string[] = [];
  if (transfers.some((t) => t.routingMode === "description"))
    rules.push(
      "When the caller asks to be transferred, connected, or to speak with a person or department, call the transfer tool immediately with the best matching destinationId. Never say you are transferring or ask the caller to hold unless you call the tool in that same turn. The tool speaks the transfer message itself.",
    );
  const phrased = transfers.filter((t) => t.routingMode === "phrase");
  if (phrased.length) {
    const routes = phrased.flatMap((t) =>
      t.destinations.map(
        (d) =>
          `- Say "${d.transferPhrase}"${d.description ? ` when: ${d.description}` : ""}`,
      ),
    );
    rules.push(
      [
        "To transfer the caller, say the exact transfer phrase for the destination, word for word. Saying the phrase transfers the call immediately and ends your turn, so say nothing after it.",
        "Say a phrase only when you actually intend to transfer. Never say you are transferring or ask the caller to hold without saying the phrase.",
        ...routes,
      ].join("\n"),
    );
  }
  return rules.join("\n");
}

function findPhraseEnd(text: string, phrase: string): number | undefined {
  const target = [...phrase.matchAll(WORD)].map((m) =>
    m[0].toLocaleLowerCase(),
  );
  if (!target.length) return undefined;
  const found = [...text.matchAll(WORD)].map((m) => ({
    word: m[0].toLocaleLowerCase(),
    end: (m.index ?? 0) + m[0].length,
  }));
  for (let i = 0; i + target.length <= found.length; i++)
    if (target.every((word, k) => found[i + k]?.word === word))
      return found[i + target.length - 1]?.end;
  return undefined;
}

export function phraseTransfer(
  tools: ToolConfig[],
  agentText: string,
): PhraseRoute | undefined {
  let best: { tool: TransferTool; destinationId: string; end: number } | undefined;
  for (const tool of tools.filter(isTransfer)) {
    if (tool.routingMode !== "phrase") continue;
    for (const d of tool.destinations) {
      if (!d.transferPhrase) continue;
      const end = findPhraseEnd(agentText, d.transferPhrase);
      if (end !== undefined && (!best || end < best.end))
        best = { tool, destinationId: d.id, end };
    }
  }
  if (!best) return undefined;
  const trailing = agentText.slice(best.end).match(/^[.!?,;:]+/)?.[0] ?? "";
  return {
    tool: best.tool,
    destinationId: best.destinationId,
    spoken: agentText.slice(0, best.end) + trailing,
  };
}
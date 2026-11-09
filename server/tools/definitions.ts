import type { ToolConfig } from "../../lib/config";
import type { ModelTool } from "../core/ports";
import { containsPhrase } from "../speech/timing";
export function modelTools(tools: ToolConfig[]): ModelTool[] {
  return tools
    .filter((t) => t.type !== "transferCall" || t.routingMode === "description")
    .map((t) => ({
      name: t.name,
      description:
        t.description +
        (t.type === "transferCall"
          ? " Destinations: " +
            t.destinations.map((d) => `${d.id}: ${d.description}`).join("; ")
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
export function phraseTransfer(
  tools: ToolConfig[],
  text: string,
): { tool: ToolConfig; destinationId: string } | undefined {
  for (const tool of tools)
    if (tool.type === "transferCall" && tool.routingMode === "phrase") {
      const d = tool.destinations.find((d) =>
        containsPhrase(text, d.transferPhrase),
      );
      if (d) return { tool, destinationId: d.id };
    }
}

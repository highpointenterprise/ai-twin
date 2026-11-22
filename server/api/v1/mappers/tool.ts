import { toolSchema, type ToolConfig, type ToolInput } from "../../../../lib/config";
import { badRequest } from "../http/errors";
import { deepMerge } from "../schemas/common";
import { toolBodySchema, type ToolBody } from "../schemas/tool";

export type ToolDocument = ToolConfig & { createdAt: string; updatedAt: string };

const isBlind = (mode: string): boolean => mode === "blind-transfer";

export const toToolInput = (body: ToolBody): ToolInput => {
  switch (body.type) {
    case "function":
      return toolSchema.parse({
        type: "function",
        name: body.function.name,
        description: body.function.description,
        parameters: body.function.parameters,
        server: body.server,
      });
    case "dtmf":
      return toolSchema.parse({
        type: "dtmf",
        name: body.function?.name ?? "dtmf",
        description: body.function?.description ?? "Press keypad digits on an automated phone menu.",
      });
    case "transferCall": {
      const modes = new Set(body.destinations.map((entry) => isBlind(entry.transferPlan?.mode ?? "blind-transfer")));
      if (modes.size > 1)
        throw badRequest("destinations: all destinations must use either blind or warm transfer");
      const first = body.destinations[0];
      const warm = !isBlind(first.transferPlan?.mode ?? "blind-transfer");
      return toolSchema.parse({
        type: "transferCall",
        name: body.function?.name ?? "transfer_call",
        description: body.function?.description ?? "Transfer the call to another number.",
        transferMode: warm ? "warm" : "blind",
        timeoutSeconds: first.transferPlan?.timeout,
        warmTransfer: {
          firstMessage: first.transferPlan?.message,
          holdAudioUrl: first.transferPlan?.holdAudioUrl,
        },
        routingMode: "description",
        destinations: body.destinations.map((entry, index) => ({
          id: entry.name ?? `destination_${index + 1}`,
          number: entry.number,
          description: entry.description || `Transfer to ${entry.number}`,
          message: entry.message,
          extension: entry.extension,
        })),
      });
    }
  }
};

export const toApiToolBody = (tool: ToolConfig): ToolBody => {
  switch (tool.type) {
    case "function":
      return {
        type: "function",
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
        server: tool.server,
      };
    case "dtmf":
      return { type: "dtmf", function: { name: tool.name, description: tool.description } };
    case "transferCall":
      return {
        type: "transferCall",
        function: { name: tool.name, description: tool.description },
        destinations: tool.destinations.map((entry) => ({
          type: "number",
          number: entry.number,
          name: entry.id,
          description: entry.description,
          message: entry.message,
          ...(entry.extension ? { extension: entry.extension } : {}),
          transferPlan: {
            mode: tool.transferMode === "warm" ? "warm-transfer-say-message" : "blind-transfer",
            timeout: tool.timeoutSeconds,
            ...(tool.transferMode === "warm" && tool.warmTransfer.firstMessage
              ? { message: tool.warmTransfer.firstMessage }
              : {}),
            ...(tool.warmTransfer.holdAudioUrl ? { holdAudioUrl: tool.warmTransfer.holdAudioUrl } : {}),
          },
        })),
      };
  }
};

export const toApiTool = (document: ToolDocument, orgId: string): Record<string, unknown> => ({
  id: document.id,
  orgId,
  createdAt: document.createdAt,
  updatedAt: document.updatedAt,
  ...toApiToolBody(document),
});

export const mergeTool = (current: ToolConfig, patch: unknown): ToolBody =>
  toolBodySchema.parse(deepMerge(toApiToolBody(current), patch));

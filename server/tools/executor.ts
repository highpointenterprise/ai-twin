import type { WarmTransferCoordinator } from "../transfers/coordinator";
import type { ToolConfig } from "../../lib/config";
import { env } from "../../lib/env";
import type {
  Telephony,
  ToolCall,
  ToolContext,
  ToolOutcome,
} from "../core/ports";
import { dtmfAudio } from "../speech/audio";
import { jsonValidator } from "./registry";
export class ToolExecutor {
  constructor(
    private readonly telephony: Telephony,
    private readonly request: typeof fetch = fetch,
    private readonly warmTransfers?: WarmTransferCoordinator,
  ) {}
  async execute(
    tool: ToolConfig,
    call: ToolCall,
    context: ToolContext,
  ): Promise<ToolOutcome> {
    context.signal.throwIfAborted();
    const args = JSON.parse(call.arguments) as Record<string, unknown>;
    if (!args || typeof args !== "object" || Array.isArray(args))
      throw new Error("Expected tool arguments object.");
    if (tool.type === "transferCall") {
      const d = tool.destinations.find((d) => d.id === args.destinationId);
      if (!d) throw new Error("Unknown transfer destination.");
      await context.speak(d.message);
      context.signal.throwIfAborted();
      if (tool.transferMode === "warm") {
        if (!this.warmTransfers || !context.snapshot)
          throw new Error("Warm transfer service is not available.");
        const transferId = this.warmTransfers.start(
          context.callSid,
          tool,
          d,
          context.snapshot,
        );
        return {
          terminal: true,
          result: {
            status: "warm-transfer-started",
            transferId,
            destinationId: d.id,
          },
        };
      }
      await this.telephony.transferCall(
        context.callSid,
        d,
        tool.timeoutSeconds,
        `${env.PUBLIC_BASE_URL}/twilio/transfer-status`,
      );
      return {
        terminal: true,
        result: { status: "transfer-initiated", destinationId: d.id },
      };
    }
    if (tool.type === "dtmf") {
      if (typeof args.keys !== "string")
        throw new Error("DTMF keys are required.");
      await context.playAudio(
        dtmfAudio(args.keys, tool.toneDurationMs, tool.gapMs),
      );
      return {
        waitForUser: true,
        result: { status: "tones-played", keys: args.keys },
      };
    }
    const validate = jsonValidator.compile(tool.parameters);
    if (!validate(args))
      throw new Error(
        `Invalid function arguments: ${jsonValidator.errorsText(validate.errors)}`,
      );
    const url = new URL(tool.server.url);
    const allowed = env.FUNCTION_ALLOWED_HOSTS.split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean);
    if (!allowed.includes(url.hostname.toLowerCase()))
      throw new Error(
        `Function host ${url.hostname} is not in FUNCTION_ALLOWED_HOSTS.`,
      );
    const secret = tool.server.secretEnv
      ? process.env[tool.server.secretEnv]
      : undefined;
    if (tool.server.secretEnv && !secret)
      throw new Error("The tool's credential binding is missing.");
    const signal = AbortSignal.any([
      context.signal,
      AbortSignal.timeout(tool.server.timeoutSeconds * 1000),
    ]);
    const r = await this.request(url, {
      method: "POST",
      redirect: "error",
      signal,
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": `${context.callSid}:${call.id}`,
        ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
      },
      body: JSON.stringify({
        message: {
          type: "tool-calls",
          timestamp: Date.now(),
          call: { id: context.callSid },
          toolCallList: [
            {
              id: call.id,
              type: "function",
              function: { name: tool.name, arguments: args },
            },
          ],
        },
      }),
    });
    if (!r.ok) {
      await r.body?.cancel();
      throw new Error(`Function server returned HTTP ${r.status}.`);
    }
    const reader = r.body?.getReader();
    if (!reader) throw new Error("Function response was empty.");
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 65536) {
        await reader.cancel();
        throw new Error("Function response exceeds 64 KB.");
      }
      chunks.push(part.value);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString()) as {
      results?: { toolCallId: string; result: unknown }[];
    };
    const result = body.results?.find((r) => r.toolCallId === call.id);
    if (!result || !("result" in result))
      throw new Error(
        "Function response must contain results[{toolCallId, result}].",
      );
    return { result: result.result };
  }
}

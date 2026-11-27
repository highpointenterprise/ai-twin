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
    private readonly dtmf?: import("../dtmf/service").DtmfService,
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
      if (!/^[0-9A-D*#wW]{1,32}$/.test(args.keys) || !/[0-9A-D*#]/.test(args.keys))
        throw new Error("Invalid DTMF sequence.");
      if (!context.sendDtmf && tool.transport !== "audio") {
        if (!this.dtmf) throw new Error("Provider keypad delivery is unavailable.");
        return this.dtmf.send(call.id, args.keys, context);
      }
      const audio = dtmfAudio(args.keys, tool.toneDurationMs, tool.gapMs);
      const transport = context.sendDtmf ? "out-of-band" : "in-band-audio";
      const began = Date.now();
      context.trace?.log("dtmf.playback_requested", {
        operationId: call.id, transport,
        selection: args.keys.length === 1 ? args.keys : "[redacted sequence]",
        digitCount: args.keys.replace(/[wW]/g, "").length,
        toneDurationMs: tool.toneDurationMs, gapMs: tool.gapMs,
        audioDurationMs: context.sendDtmf ? 0 : audio.length / 8,
        audibleTones: !context.sendDtmf,
      });
      try {
        if (context.sendDtmf) await context.sendDtmf(args.keys, tool.toneDurationMs, tool.gapMs);
        else await context.playAudio(audio);
        context.trace?.log("dtmf.playback_completed", { operationId: call.id, transport, ms: Date.now() - began, remoteRecognition: "unconfirmed" });
      } catch (error) {
        context.trace?.log("dtmf.playback_failed", { operationId: call.id, transport, ms: Date.now() - began, cancelled: context.signal.aborted });
        throw error;
      }
      return {
        waitForUser: true,
        result: { status: "tones-played", remoteRecognition: "unconfirmed" },
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
    const usageId = context.usage?.startRequest("api", tool.id, "api", "requests");
    if (usageId) context.usage?.addRequestUnits(usageId, 1);
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
    }).catch((error) => {
      if (usageId) context.usage?.updateRequest(usageId, { status: "failed", endedAt: new Date().toISOString() });
      throw error;
    });
    if (usageId) context.usage?.updateRequest(usageId, { status: r.ok ? "completed" : "failed", endedAt: new Date().toISOString() });
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

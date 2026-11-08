import "dotenv/config";
import { createServer } from "node:http";
import { join } from "node:path";
import { env, missingCallConfiguration } from "../lib/env";
import { assistantSchema } from "../lib/config";
import type { EngineDeps } from "./core/ports";
import { SessionPool } from "./engine/pool";
import { StandardSession } from "./engine/standard-session";
import { attachMediaServer } from "./http/media";
import { createAdminApp, createPublicApp, type HttpDeps } from "./http/routes";
import { logEvent, TraceStore } from "./observability/trace";
import { createDeepgramTranscriber } from "./providers/deepgram";
import {
  createElevenLabsSynthesizer,
  listElevenLabsVoices,
} from "./providers/elevenlabs";
import { createOpenAiModel } from "./providers/openai";
import { WarmTransferCoordinator } from "./transfers/coordinator";
import { createConsultationSession } from "./transfers/consultation";
import {
  createTwilioWarmTelephony,
  createTwilioTelephony,
} from "./providers/twilio";
import { AgentStore } from "./store/agents";
import { CallRegistry } from "./store/calls";
import { ContextStore } from "./store/contexts";
import { ToolRegistry } from "./tools/registry";
import { ToolExecutor } from "./tools/executor";
const store = new AgentStore(
  assistantSchema.parse({
    name: "Luna",
    firstMessage: "Hello, this is Luna. How can I help you today?",
    systemPrompt:
      "You are Luna, a helpful voice assistant. Keep replies concise and conversational.",
    voiceId: env.ELEVENLABS_VOICE_ID,
    model: env.OPENAI_MODEL,
  }),
  join(env.DATA_DIR, "assistants.json"),
);
const registry = new CallRegistry(join(env.DATA_DIR, "calls.json"));
const tools = new ToolRegistry(join(env.DATA_DIR, "tools.json"));
const pool = new SessionPool(env.MAX_CONCURRENT_CALLS),
  traces = new TraceStore(),
  contexts = new ContextStore();
const telephony = createTwilioTelephony();
const warmTransfers = new WarmTransferCoordinator({
  telephony: createTwilioWarmTelephony(),
  contexts,
  registry,
  traces,
  path: join(env.DATA_DIR, "warm-transfers.json"),
});
const executor = new ToolExecutor(telephony, fetch, warmTransfers);
const engine: EngineDeps = {
  transcribe: createDeepgramTranscriber,
  synthesize: createElevenLabsSynthesizer,
  model: createOpenAiModel(),
  executeTool: async (tool, call, ctx) => {
    const result = await executor.execute(tool, call, ctx);
    if (
      result.terminal &&
      (tool.type !== "transferCall" || tool.transferMode !== "warm")
    )
      registry.patch(ctx.callSid, { transferStatus: "initiated" });
    return result;
  },
  endCall: async (sid, reason) => {
    await telephony.endCall(sid);
    registry.patch(sid, { endedReason: reason });
    registry.update(sid, "completed");
  },
  onScreening: (sid) => registry.patch(sid, { screeningEncountered: true }),
};
const deps: HttpDeps = {
  store,
  registry,
  tools,
  pool,
  traces,
  contexts,
  telephony,
  listVoices: listElevenLabsVoices,
  pendingCalls: 0,
  warmTransfers,
};
const publicServer = createServer(createPublicApp(deps));
const media = attachMediaServer(publicServer, {
  factory: (init) =>
    init.purpose === "warm-consultation"
      ? createConsultationSession(init, engine, warmTransfers)
      : new StandardSession(init, engine),
  onResumed: (id, sid) => warmTransfers.resumed(id, sid),
  pool,
  registry,
  traces,
  contexts,
});
publicServer.listen(env.PORT, () =>
  logEvent("server.public_listening", { port: env.PORT }),
);
const admin = createAdminApp(deps).listen(env.ADMIN_PORT, "127.0.0.1", () =>
  logEvent("server.admin_listening", { port: env.ADMIN_PORT }),
);
logEvent("configuration", {
  calling_ready: !missingCallConfiguration().length,
  missing: missingCallConfiguration().join(", "),
});
void warmTransfers.recoverAfterRestart();
const shutdown = () => {
  warmTransfers.shutdown();
  pool.closeAll();
  for (const client of media.clients) client.terminate();
  media.close();
  publicServer.close();
  admin.close();
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

import "dotenv/config";
import { createServer } from "node:http";
import { env } from "../lib/env";
import type { ConversationMode } from "../lib/types";
import type { EngineDeps, SessionFactory } from "./core/ports";
import { SessionPool } from "./engine/pool";
import { createRealtimeSessionFactory } from "./engine/realtime-session";
import { StandardSession } from "./engine/standard-session";
import { attachMediaServer } from "./http/media";
import { createAdminApp, createPublicApp, type HttpDeps } from "./http/routes";
import { logEvent, TraceStore } from "./observability/trace";
import { createDeepgramTranscriber } from "./providers/deepgram";
import { createElevenLabsSynthesizer, listElevenLabsVoices } from "./providers/elevenlabs";
import { createOpenAiModel } from "./providers/openai";
import { createOpenAiRealtime } from "./providers/openai-realtime";
import { createTwilioTelephony } from "./providers/twilio";
import { AgentStore } from "./store/agents";
import { CallRegistry } from "./store/calls";
import { ContextStore } from "./store/contexts";

const engine: EngineDeps = {
  transcribe: createDeepgramTranscriber,
  synthesize: createElevenLabsSynthesizer,
  model: createOpenAiModel(),
};

const factories: Record<ConversationMode, SessionFactory> = {
  standard: (init) => new StandardSession(init, engine),
  "full-duplex": createRealtimeSessionFactory(createOpenAiRealtime),
};

const store = new AgentStore({
  name: "Luna",
  greeting: "Hey, it's Luna. Can you hear me okay?",
  systemPrompt: "You are Luna, a warm, quick-witted assistant. Help the caller with whatever they need.",
  mode: "standard",
  voiceId: env.ELEVENLABS_VOICE_ID,
  realtimeVoice: "marin",
  model: env.OPENAI_MODEL,
  temperature: 0.8,
});

const registry = new CallRegistry();
const pool = new SessionPool(env.MAX_CONCURRENT_CALLS);
const traces = new TraceStore();
const contexts = new ContextStore();
const deps: HttpDeps = {
  store,
  registry,
  pool,
  traces,
  contexts,
  telephony: createTwilioTelephony(),
  listVoices: listElevenLabsVoices,
};

const publicServer = createServer(createPublicApp(deps));
attachMediaServer(publicServer, { factories, store, registry, pool, traces, contexts });
publicServer.listen(env.PORT, () => logEvent("server.public_listening", { port: env.PORT }));

const adminServer = createAdminApp(deps).listen(env.ADMIN_PORT, "127.0.0.1", () =>
  logEvent("server.admin_listening", { port: env.ADMIN_PORT }),
);

const shutdown = (): void => {
  logEvent("server.shutdown");
  pool.closeAll();
  publicServer.close();
  adminServer.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

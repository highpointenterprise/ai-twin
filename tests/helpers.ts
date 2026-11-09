import { randomUUID } from "node:crypto";
import { assistantSchema } from "../lib/config";
import type { AgentConfig } from "../lib/types";
import type {
  EngineDeps,
  SessionInit,
  Telephony,
  TranscriberEvents,
} from "../server/core/ports";
import { CallTrace } from "../server/observability/trace";
import { StandardSession } from "../server/engine/standard-session";
export const agent = (
  overrides: Record<string, unknown> = {},
): AgentConfig => ({
  ...assistantSchema.parse({
    name: "Test agent",
    systemPrompt: "Help the caller.",
    voiceId: "test-voice",
    firstMessageMode: "assistant-waits-for-user",
    startSpeakingPlan: { waitSeconds: 0 },
    stopSpeakingPlan: { backoffSeconds: 0 },
    ...overrides,
  }),
  id: randomUUID(),
});
export const telephony = (): Telephony => ({
  listNumbers: async () => [],
  routeInbound: async () => {},
  placeCall: async () => "CA-test",
  transferCall: async () => {},
  endCall: async () => {},
  validateWebhook: () => true,
  streamTwiml: (u, p) => `<Stream url="${u}" params='${JSON.stringify(p)}'/>`,
  rejectTwiml: (m) => m,
});
export const tick = () => new Promise<void>((r) => setTimeout(r, 10));
export async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await tick();
  }
  throw new Error("Timed out waiting for test condition");
}
export function harness(
  options: Partial<SessionInit> = {},
  depsOverride: Partial<EngineDeps> = {},
) {
  let events!: TranscriberEvents, session!: StandardSession;
  const spoken: string[] = [],
    sent: object[] = [],
    ended: string[] = [];
  let autoMark = true;
  const deps: EngineDeps = {
    transcribe: (e) => {
      events = e;
      return { sendAudio: () => {}, close: () => {} };
    },
    synthesize: (_v, onAudio) => ({
      push: async (text) => {
        spoken.push(text);
        onAudio(Buffer.alloc(160, 255).toString("base64"));
      },
      end: async () => {},
      close: () => {},
    }),
    model: {
      async *stream() {
        yield { type: "text", text: "How can I help?" };
      },
      complete: async () => "",
    },
    endCall: async (_sid, reason) => {
      ended.push(reason);
    },
    ...depsOverride,
  };
  session = new StandardSession(
    {
      agent: agent(),
      callSid: "CA-test",
      streamSid: "MZ-test",
      brief: "",
      trace: new CallTrace("CA-test"),
      send: (m) => {
        sent.push(m);
        const msg = m as { event?: string; mark?: { name: string } };
        if (autoMark && msg.event === "mark")
          queueMicrotask(() => session.handleMark(msg.mark!.name));
      },
      ...options,
    },
    deps,
  );
  return {
    session,
    get events() {
      return events;
    },
    spoken,
    sent,
    ended,
    deps,
    setAutoMark: (v: boolean) => {
      autoMark = v;
    },
  };
}

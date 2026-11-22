import { env } from "../../lib/env";
import { signStreamToken } from "../../lib/token";
import type { Telephony } from "../core/ports";
import type { CallRequestDocument } from "../api/v1/repositories/call-requests";
import type { TraceStore } from "../observability/trace";
import type { MongoCallRepository } from "../storage/calls";
import type { CallRegistry } from "../store/calls";
import type { ContextStore } from "../store/contexts";

export interface LauncherDependencies {
  telephony: Telephony;
  contexts: ContextStore;
  registry: CallRegistry;
  traces: TraceStore;
  calls: MongoCallRepository;
}

export class CallLauncher {
  constructor(private readonly deps: LauncherDependencies) {}

  async launch(request: CallRequestDocument): Promise<string> {
    const { telephony, contexts, registry, traces, calls } = this.deps;
    const callId = request.id;
    await contexts.deleteAsync(callId);
    await contexts.setAsync(callId, {
      agent: request.agent,
      tools: request.tools,
      brief: request.brief,
      direction: "outbound",
      purpose: "conversation",
      from: request.from,
      to: request.customer.number,
      requestId: callId,
    });
    try {
      const query = new URLSearchParams({
        callId,
        agentId: request.agent.id,
        token: signStreamToken(request.agent.id, callId),
      });
      const sid = await telephony.placeCall({
        to: request.customer.number,
        from: request.from,
        url: `${env.PUBLIC_BASE_URL}/twilio/voice/outbound?${query}`,
        statusUrl: `${env.PUBLIC_BASE_URL}/twilio/status?callId=${callId}`,
        voicemail: request.agent.voicemailDetection,
      });
      await contexts.bindAsync(callId, sid);
      if (!registry.get(sid))
        registry.create({
          sid,
          agentId: request.agent.id,
          assistant: structuredClone(request.agent),
          tools: structuredClone(request.tools),
          direction: "outbound",
          from: request.from,
          to: request.customer.number,
          status: "initiating",
          requestId: callId,
        });
      traces.for(sid).log("call.placed", { agent: request.agent.name, callId, attempt: request.attempts });
      await registry.flush();
      await traces.flush();
      await calls.attachRequest(sid, callId);
      return sid;
    } catch (error) {
      await contexts.deleteAsync(callId);
      throw error;
    }
  }
}

import { env } from "../../lib/env";
import type { AgentConfig } from "../../lib/types";
// An empty per-assistant voice means inherit the server default, including
// assistants saved before credentials/voice were configured.
export function effectiveAssistant(agent: AgentConfig): AgentConfig {
  return {
    ...structuredClone(agent),
    voiceId: agent.voiceId || env.ELEVENLABS_VOICE_ID,
  };
}

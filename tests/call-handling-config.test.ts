import { test } from "node:test";
import assert from "node:assert/strict";
import type twilio from "twilio";
import { assistantSchema } from "../lib/config";
import { assistantBodySchema } from "../server/api/v1/schemas/assistant";
import { mergeAssistant, toAgentInput, toApiAssistant } from "../server/api/v1/mappers/assistant";
import { createTwilioTelephony } from "../server/providers/twilio";
import { agent } from "./helpers";

test("legacy assistants use the built-in detector and public updates preserve handling settings", () => {
  const a = agent({ voicemailDetection: { provider: "twilio", enabled: true, action: "leave-message", message: "Call me", confidenceThreshold: 0.93 }, callHandling: { menuSilenceMs: 900 }, callScreening: { enabled: true, response: "Alex about your appointment" } });
  assert.equal(a.voicemailDetection.provider, "builtin");
  const api = toApiAssistant({ ...a, orgId: "owner", createdAt: "now", updatedAt: "now" });
  const { id, orgId, createdAt, updatedAt, ...body } = api;
  const updated = toAgentInput(mergeAssistant(assistantBodySchema.parse(body), { name: "Renamed" }));
  assert.equal(updated.callHandling.menuSilenceMs, 900);
  assert.equal(updated.callScreening.response, a.callScreening.response);
  assert.equal(updated.voicemailDetection.confidenceThreshold, 0.93);
  assert.equal(assistantSchema.safeParse({ ...a, callHandling: { menuSilenceMs: -1 } }).success, false);
});

test("outbound dial never enables provider AMD even for a legacy-enabled assistant", async () => {
  let parameters: Record<string, unknown> | undefined;
  const phone = createTwilioTelephony(() => ({ accountSid: "AC" + "a".repeat(32), authToken: "test" }), () => ({ calls: { create: async (params: Record<string, unknown>) => { parameters = params; return { sid: "CA-test" }; } } }) as unknown as twilio.Twilio);
  await phone.placeCall({ to: "+14155550123", from: "+14155550124", url: "https://example.com/voice", statusUrl: "https://example.com/status", voicemail: agent({ voicemailDetection: { provider: "twilio", enabled: true } }).voicemailDetection });
  assert.equal(parameters?.machineDetection, undefined);
  assert.equal(parameters?.asyncAmd, undefined);
  assert.equal(parameters?.machineDetectionTimeout, undefined);
  assert.deepEqual(parameters?.statusCallbackEvent, ["initiated", "ringing", "answered", "completed"]);
});

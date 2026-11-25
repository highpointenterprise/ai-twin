import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { renderCallAgent } from "../server/calls/variables";
import { simpleCallSchema } from "../server/api/v1/schemas/create-call";
import { CallService } from "../server/api/v1/services/calls";
import { agent } from "./helpers";

test("name aliases and custom variables render per call without modifying the assistant", () => {
  const original = agent({ systemPrompt: "Call {{full_name}} about {{ product }} at {{email}}", firstMessage: "Hello {{firstname}} / {{firstName}} / {{first_name}}", voicemailDetection: { message: "Call back {{first_name}}" }, callScreening: { response: "Calling {{fullname}}" } });
  const first = renderCallAgent(original, { full_name: "Jane Doe", email: "jane@example.com", product: "Wellness" });
  const second = renderCallAgent(original, { full_name: "Sam Smith", email: "sam@example.com", product: "Support" });
  assert.equal(first.firstMessage, "Hello Jane / Jane / Jane");
  assert.equal(first.voicemailDetection.message, "Call back Jane");
  assert.equal(first.callScreening.response, "Calling Jane Doe");
  assert.equal(second.firstMessage, "Hello Sam / Sam / Sam");
  assert.match(original.firstMessage, /\{\{firstname\}\}/);
});
test("missing values, inherited properties and nested template injection cannot reach speech", () => {
  const template = agent({ systemPrompt: "Hi {{name}}", firstMessage: "Balance {{balance}}, enabled {{enabled}}" });
  assert.throws(() => renderCallAgent(template, {}), /Missing call variables/);
  assert.throws(() => renderCallAgent(template, Object.create({ name: "Jane" })), /Missing call variables/);
  assert.throws(() => renderCallAgent(template, { name: "{{secret}}", balance: 0, enabled: false }), /unresolved/);
  assert.equal(renderCallAgent(template, { name: "Jane", balance: 0, enabled: false }).firstMessage, "Balance 0, enabled false");
});
test("customData cannot change account or routing fields", () => {
  const base = { clientId: randomUUID(), agentId: randomUUID(), toNumber: "+14155550123" };
  assert.equal(simpleCallSchema.safeParse({ ...base, customData: { clientId: randomUUID() } }).success, false);
  assert.equal(simpleCallSchema.safeParse({ ...base, customData: { nested: { a: 1 } } }).success, false);
  assert.equal(simpleCallSchema.safeParse({ ...base, appointmentDate: "2026-12-01", customData: { product: "Support" } }).success, true);
});
test("simple calls enforce workspace and origin ownership then use the existing call service", async () => {
  const owner = randomUUID(), assistantId = randomUUID(), numberId = randomUUID();
  const service = new CallService({ orgId: owner, phoneNumbers: { byNumbers: async () => new Map([["+14155550100", { id: numberId }]]) } } as any);
  let admitted: any;
  service.create = async (body, key) => { admitted = { body, key }; return { id: "call" }; };
  const input = simpleCallSchema.parse({ clientId: owner, agentId: assistantId, toNumber: "+14155550123", fromNumber: "+14155550100", full_name: "Jane Doe", customData: { appointmentDate: "2026-12-01" } });
  await assert.rejects(service.createSimple(simpleCallSchema.parse({ ...input, clientId: randomUUID() })), /authenticated workspace/);
  await assert.rejects(service.createSimple(simpleCallSchema.parse({ ...input, fromNumber: "+14155550999" })), /not found/);
  assert.equal(Boolean(admitted), false);
  await service.createSimple(input, "request-123");
  assert.equal(admitted.body.assistantId, assistantId);
  assert.equal(admitted.body.phoneNumberId, numberId);
  assert.equal(admitted.body.assistantOverrides.variableValues.firstname, "Jane");
  assert.equal(admitted.body.assistantOverrides.variableValues.appointmentDate, "2026-12-01");
  assert.equal(admitted.key, "request-123");
});

test("public create-call rejects client IDs without authentication before resolving a workspace", async t => {
  const { createWorkspaceGateway } = await import("../server/workspaces/gateway");
  let resolved = false;
  const apps = createWorkspaceGateway({ allowAttempt: async () => ({ allowed: true }) } as any, "test-secret-with-at-least-32-characters", { get: async () => { resolved = true; throw new Error("Must not resolve"); } });
  const server = apps.publicApp.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())));
  const address = server.address() as { port: number };
  const response = await fetch(`http://127.0.0.1:${address.port}/create-call`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clientId: randomUUID(), agentId: randomUUID(), toNumber: "+14155550123" }) });
  assert.equal(response.status, 401);
  assert.equal(resolved, false);
});

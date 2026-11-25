import { assistantSchema } from "../../lib/config";
import type { AgentConfig } from "../../lib/types";
import { HttpError } from "../core/errors";
const badRequest = (message: string) => new HttpError(400, message);

export function normalizeVariables(values: Record<string, unknown>): Record<string, unknown> {
  const result = Object.assign(Object.create(null), values) as Record<string, unknown>;
  const first = ["first_name", "firstname", "firstName"].map(k => result[k]).find(v => typeof v === "string" && v.trim());
  const full = ["full_name", "fullname", "fullName", "name", "customer.name"].map(k => result[k]).find(v => typeof v === "string" && v.trim());
  for (const key of ["full_name", "fullname", "fullName", "name"]) if (result[key] == null && full) result[key] = full;
  for (const key of ["first_name", "firstname", "firstName"]) if (result[key] == null && (first || full)) result[key] = first || String(full).trim().split(/\s+/)[0];
  return result;
}

export function renderCallAgent(agent: AgentConfig, supplied: Record<string, unknown>): AgentConfig {
  const variables = normalizeVariables(supplied);
  const missing = new Set<string>();
  const render = (text: string) => text.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_match, key: string) => {
    const value = Object.hasOwn(variables, key) ? variables[key] : undefined;
    if (value == null) { missing.add(key); return ""; }
    if (!["string", "number", "boolean"].includes(typeof value)) throw badRequest(`Variable ${key} must be text, a number, or a boolean.`);
    const result = String(value);
    if (/\{\{|\}\}/.test(result)) throw badRequest(`Variable ${key} contains unresolved template syntax.`);
    return result;
  });
  const rendered = { ...agent, systemPrompt: render(agent.systemPrompt), firstMessage: render(agent.firstMessage), voicemailDetection: { ...agent.voicemailDetection, message: render(agent.voicemailDetection.message) }, callScreening: { ...agent.callScreening, response: render(agent.callScreening.response) } };
  if (missing.size) throw badRequest(`Missing call variables: ${[...missing].sort().join(", ")}`);
  return { ...assistantSchema.parse(rendered), id: agent.id };
}

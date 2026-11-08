import { randomUUID } from "node:crypto";
import type { AgentConfig, AgentInput } from "../../lib/types";
import { HttpError } from "../core/errors";

export class AgentStore {
  private readonly agents = new Map<string, AgentConfig>();
  private readonly numberToAgent = new Map<string, string>();

  constructor(seed: AgentInput) {
    this.create(seed);
  }

  create(input: AgentInput): AgentConfig {
    const agent: AgentConfig = { ...input, id: randomUUID() };
    this.agents.set(agent.id, agent);
    return agent;
  }

  update(id: string, input: AgentInput): AgentConfig {
    this.get(id);
    const agent: AgentConfig = { ...input, id };
    this.agents.set(id, agent);
    return agent;
  }

  get(id: string): AgentConfig {
    const agent = this.agents.get(id);
    if (!agent) throw new HttpError(404, "Agent not found.");
    return agent;
  }

  find(id: string): AgentConfig | undefined {
    return this.agents.get(id);
  }

  list(): AgentConfig[] {
    return [...this.agents.values()];
  }

  assign(phoneNumber: string, agentId: string): void {
    this.numberToAgent.set(phoneNumber, agentId);
  }

  agentForNumber(phoneNumber: string): AgentConfig | undefined {
    const id = this.numberToAgent.get(phoneNumber);
    return id ? this.agents.get(id) : undefined;
  }

  numberForAgent(agentId: string): string | undefined {
    for (const [phoneNumber, id] of this.numberToAgent) if (id === agentId) return phoneNumber;
    return undefined;
  }
}

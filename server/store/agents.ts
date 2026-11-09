import { randomUUID } from "node:crypto";
import type { AgentConfig, AgentInput } from "../../lib/types";
import { assistantSchema } from "../../lib/config";
import { JsonFile } from "./persistence";
import { HttpError } from "../core/errors";

export class AgentStore {
  private readonly agents = new Map<string, AgentConfig>();
  private readonly numberToAgent = new Map<string, string>();

  private readonly file: JsonFile<{
    agents: AgentConfig[];
    assignments: [string, string][];
  }>;
  constructor(seed: AgentInput, path?: string) {
    this.file = new JsonFile(path);
    const saved = this.file.load({ agents: [], assignments: [] });
    for (const agent of saved.agents)
      this.agents.set(agent.id, {
        ...assistantSchema.parse(agent),
        id: agent.id,
      });
    for (const [number, id] of saved.assignments)
      this.numberToAgent.set(number, id);
    if (!this.agents.size) this.create(seed);
  }
  private persist(): void {
    this.file.save({
      agents: this.list(),
      assignments: [...this.numberToAgent],
    });
  }

  create(input: AgentInput): AgentConfig {
    const agent: AgentConfig = { ...input, id: randomUUID() };
    this.agents.set(agent.id, agent);
    this.persist();
    return agent;
  }

  update(id: string, input: AgentInput): AgentConfig {
    this.get(id);
    const agent: AgentConfig = { ...input, id };
    this.agents.set(id, agent);
    this.persist();
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
    this.get(agentId);
    this.numberToAgent.set(phoneNumber, agentId);
    this.persist();
  }

  agentForNumber(phoneNumber: string): AgentConfig | undefined {
    const id = this.numberToAgent.get(phoneNumber);
    return id ? this.agents.get(id) : undefined;
  }

  numberForAgent(agentId: string): string | undefined {
    for (const [phoneNumber, id] of this.numberToAgent)
      if (id === agentId) return phoneNumber;
    return undefined;
  }
}

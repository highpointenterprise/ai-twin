import { randomUUID } from "node:crypto";
import { MongoServerError, type Collection, type Db } from "mongodb";
import { assistantSchema, e164, type ToolConfig, type ToolInput } from "../../lib/config";
import type { AgentConfig, AgentInput } from "../../lib/types";
import { HttpError } from "../core/errors";
import type { AgentRepository, ConfigPage } from "../store/agents";
import { validatedTool, type ToolRepository } from "../tools/registry";

type Metadata = { _id: string; orgId: string; createdAt: string; updatedAt: string };
type AssistantDocument = AgentConfig & Metadata;
type ToolDocument = ToolConfig & Metadata;
type PhoneDocument = Metadata & { id: string; number: string; assistantId: string | null; available?: boolean };
const DEFAULT_ASSISTANT_ID = "00000000-0000-4000-8000-000000000001";

export function configPageLimit(page: ConfigPage = {}): number {
  const limit = page.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
    throw new HttpError(400, "Page limit must be an integer between 1 and 1000.");
  return limit;
}
type PublicDocument<T> = T extends Metadata ? Omit<T, "_id" | "orgId"> : never;
const publicFields = <T extends Metadata>(record: T): PublicDocument<T> => {
  const { _id, orgId, ...fields } = record;
  return fields as PublicDocument<T>;
};

/** Each write is acknowledged by MongoDB; no local cache can serve stale configuration. */
export class MongoAgentStore implements AgentRepository {
  private readonly assistants: Collection<AssistantDocument>;
  private readonly numbers: Collection<PhoneDocument>;
  constructor(db: Db, private readonly orgId = "default") {
    this.assistants = db.collection<AssistantDocument>("assistants");
    this.numbers = db.collection<PhoneDocument>("phone_numbers");
  }

  async initialize(seed?: AgentInput): Promise<void> {
    await Promise.all([
      this.assistants.createIndex({ orgId: 1, id: 1 }, { unique: true }),
      this.assistants.createIndex({ orgId: 1, toolIds: 1 }),
      this.numbers.createIndex({ orgId: 1, number: 1 }, { unique: true }),
      this.numbers.createIndex({ orgId: 1, assistantId: 1 }),
    ]);
    if (seed && !(await this.assistants.findOne({ orgId: this.orgId }, { projection: { _id: 1 } }))) {
      const now = new Date().toISOString();
      // A stable seed ID prevents two replicas from creating duplicate default assistants.
      await this.assistants.updateOne(
        { _id: `${this.orgId}:${DEFAULT_ASSISTANT_ID}` },
        { $setOnInsert: { ...assistantSchema.parse(seed), id: DEFAULT_ASSISTANT_ID, orgId: this.orgId, createdAt: now, updatedAt: now } },
        { upsert: true },
      );
    }
  }

  async create(input: AgentInput): Promise<AgentConfig> {
    const id = randomUUID(), now = new Date().toISOString();
    const document = { ...assistantSchema.parse(input), id, _id: `${this.orgId}:${id}`, orgId: this.orgId, createdAt: now, updatedAt: now };
    await this.assistants.insertOne(document);
    return publicFields(document);
  }

  async update(id: string, input: AgentInput): Promise<AgentConfig> {
    const updated = await this.assistants.findOneAndUpdate(
      { orgId: this.orgId, id },
      { $set: { ...assistantSchema.parse(input), updatedAt: new Date().toISOString() } },
      { returnDocument: "after" },
    );
    if (!updated) throw new HttpError(404, "Agent not found.");
    return publicFields(updated);
  }

  async get(id: string): Promise<AgentConfig> {
    const agent = await this.find(id);
    if (!agent) throw new HttpError(404, "Agent not found.");
    return agent;
  }

  async find(id: string): Promise<AgentConfig | undefined> {
    const document = await this.assistants.findOne({ orgId: this.orgId, id });
    return document ? publicFields(document) : undefined;
  }

  async list(page: ConfigPage = {}): Promise<AgentConfig[]> {
    const documents = await this.assistants.find({ orgId: this.orgId, ...(page.after ? { id: { $gt: page.after } } : {}) })
      .sort({ id: 1 }).limit(configPageLimit(page)).toArray();
    return documents.map(publicFields);
  }

  async usesTool(toolId: string): Promise<boolean> {
    return !!await this.assistants.findOne({ orgId: this.orgId, toolIds: toolId }, { projection: { _id: 1 } });
  }

  async assign(phoneNumber: string, agentId: string): Promise<void> {
    e164.parse(phoneNumber);
    await this.get(agentId);
    const now = new Date().toISOString();
    await this.numbers.updateOne(
      { orgId: this.orgId, number: phoneNumber },
      { $set: { assistantId: agentId, updatedAt: now }, $setOnInsert: { _id: `${this.orgId}:${phoneNumber}`, id: randomUUID(), orgId: this.orgId, number: phoneNumber, createdAt: now } },
      { upsert: true },
    );
  }

  async agentForNumber(phoneNumber: string): Promise<AgentConfig | undefined> {
    const number = await this.numbers.findOne({ orgId: this.orgId, number: phoneNumber, available: { $ne: false } });
    return number?.assistantId ? this.find(number.assistantId) : undefined;
  }

  async numberForAgent(agentId: string): Promise<string | undefined> {
    const number = await this.numbers.findOne({ orgId: this.orgId, assistantId: agentId, available: { $ne: false } }, { sort: { number: 1 } });
    return number?.number;
  }
}

export class MongoToolRegistry implements ToolRepository {
  private readonly tools: Collection<ToolDocument>;
  constructor(db: Db, private readonly orgId = "default") {
    this.tools = db.collection<ToolDocument>("tools");
  }

  async initialize(): Promise<void> {
    await Promise.all([
      this.tools.createIndex({ orgId: 1, id: 1 }, { unique: true }),
      this.tools.createIndex({ orgId: 1, name: 1 }, { unique: true }),
    ]);
  }

  async list(page: ConfigPage = {}): Promise<ToolConfig[]> {
    const documents = await this.tools.find({ orgId: this.orgId, ...(page.after ? { id: { $gt: page.after } } : {}) })
      .sort({ id: 1 }).limit(configPageLimit(page)).toArray();
    return documents.map(publicFields) as ToolConfig[];
  }

  async get(id: string): Promise<ToolConfig> {
    const document = await this.tools.findOne({ orgId: this.orgId, id });
    if (!document) throw new HttpError(404, "Tool not found.");
    return publicFields(document) as ToolConfig;
  }

  async resolve(ids: string[]): Promise<ToolConfig[]> {
    if (!ids.length) return [];
    const documents = await this.tools.find({ orgId: this.orgId, id: { $in: ids } }).toArray();
    const byId = new Map(documents.map((document) => [document.id, publicFields(document) as ToolConfig]));
    return ids.map((id) => {
      const tool = byId.get(id);
      if (!tool) throw new HttpError(404, "Tool not found.");
      return tool;
    });
  }

  async save(input: ToolInput, id: string = randomUUID()): Promise<ToolConfig> {
    const parsed = validatedTool(input), now = new Date().toISOString();
    try {
      // Replace the definition so switching tool type cannot leave obsolete fields behind.
      const existing = await this.tools.findOne({ orgId: this.orgId, id }, { projection: { createdAt: 1 } });
      const document = { ...parsed, id, _id: `${this.orgId}:${id}`, orgId: this.orgId, createdAt: existing?.createdAt ?? now, updatedAt: now };
      await this.tools.replaceOne({ orgId: this.orgId, id }, document, { upsert: true });
      return publicFields(document) as ToolConfig;
    } catch (error) {
      if (error instanceof MongoServerError && error.code === 11000)
        throw new HttpError(409, "Tool names must be unique.");
      throw error;
    }
  }

  async delete(id: string): Promise<void> {
    const result = await this.tools.deleteOne({ orgId: this.orgId, id });
    if (!result.deletedCount) throw new HttpError(404, "Tool not found.");
  }
}

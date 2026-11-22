import { randomUUID } from "node:crypto";
import { MongoServerError, type Collection, type Db, type Filter } from "mongodb";
import type { AssistantInput } from "../../../../lib/config";
import type { AssistantDocument } from "../mappers/assistant";
import type { ToolDocument } from "../mappers/tool";
import { conflict } from "../http/errors";
import { timeFilters, type TimeRange } from "../schemas/common";
import type { PhoneNumberPageQuery } from "../schemas/phone-number";

type Stored<T> = T & { _id: string };
const strip = <T extends { _id: string }>(document: T): Omit<T, "_id"> => {
  const { _id: _removed, ...rest } = document;
  return rest;
};
const isDuplicateKey = (error: unknown): boolean => error instanceof MongoServerError && error.code === 11000;
const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export class AssistantApiRepository {
  private readonly assistants: Collection<Stored<AssistantDocument>>;
  private readonly numbers: Collection<Stored<PhoneNumberDocument>>;

  constructor(db: Db, private readonly orgId = "default") {
    this.assistants = db.collection("assistants");
    this.numbers = db.collection("phone_numbers");
  }

  async initialize(): Promise<void> {
    await this.assistants.createIndex({ orgId: 1, createdAt: -1, id: -1 });
  }

  async list(range: TimeRange, limit: number): Promise<AssistantDocument[]> {
    const filter: Filter<Stored<AssistantDocument>> = { orgId: this.orgId, ...timeFilters(range) };
    const documents = await this.assistants.find(filter).sort({ createdAt: -1, id: -1 }).limit(limit).toArray();
    return documents.map(strip) as AssistantDocument[];
  }

  async get(id: string): Promise<AssistantDocument | undefined> {
    const document = await this.assistants.findOne({ orgId: this.orgId, id });
    return document ? (strip(document) as AssistantDocument) : undefined;
  }

  async create(input: AssistantInput, metadata?: Record<string, unknown>): Promise<AssistantDocument> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const document: Stored<AssistantDocument> = {
      ...input,
      id,
      _id: `${this.orgId}:${id}`,
      orgId: this.orgId,
      createdAt: now,
      updatedAt: now,
      ...(metadata ? { metadata } : {}),
    };
    await this.assistants.insertOne(document);
    return strip(document) as AssistantDocument;
  }

  async update(id: string, input: AssistantInput, metadata?: Record<string, unknown>): Promise<AssistantDocument | undefined> {
    const updated = await this.assistants.findOneAndUpdate(
      { orgId: this.orgId, id },
      {
        $set: { ...input, updatedAt: new Date().toISOString(), ...(metadata ? { metadata } : {}) },
        ...(metadata ? {} : { $unset: { metadata: "" } }),
      },
      { returnDocument: "after" },
    );
    return updated ? (strip(updated) as AssistantDocument) : undefined;
  }

  async usesTool(toolId: string): Promise<boolean> {
    return (await this.assistants.countDocuments({ orgId: this.orgId, toolIds: toolId }, { limit: 1 })) > 0;
  }

  async delete(id: string): Promise<AssistantDocument | undefined> {
    const removed = await this.assistants.findOneAndDelete({ orgId: this.orgId, id });
    if (!removed) return undefined;
    await this.numbers.updateMany(
      { orgId: this.orgId, assistantId: id },
      { $set: { assistantId: null, updatedAt: new Date().toISOString() } },
    );
    return strip(removed) as AssistantDocument;
  }
}

export class ToolApiRepository {
  private readonly tools: Collection<Stored<ToolDocument>>;

  constructor(db: Db, private readonly orgId = "default") {
    this.tools = db.collection("tools");
  }

  async initialize(): Promise<void> {
    await this.tools.createIndex({ orgId: 1, createdAt: -1, id: -1 });
  }

  async list(range: TimeRange, limit: number): Promise<ToolDocument[]> {
    const filter: Filter<Stored<ToolDocument>> = { orgId: this.orgId, ...timeFilters(range) };
    const documents = await this.tools.find(filter).sort({ createdAt: -1, id: -1 }).limit(limit).toArray();
    return documents.map((document) => {
      const { _id: _removed, orgId: _org, ...rest } = document as Stored<ToolDocument> & { orgId?: string };
      return rest as ToolDocument;
    });
  }
}

export interface PhoneNumberDocument {
  id: string;
  orgId: string;
  number: string;
  assistantId: string | null;
  name?: string;
  provider?: "twilio";
  twilioNumberSid?: string;
  twilioAccountSid?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PhoneNumberPage {
  results: PhoneNumberDocument[];
  totalItems: number;
  nextCursor?: string;
}

const encodeCursor = (createdAt: string, id: string): string => Buffer.from(JSON.stringify([createdAt, id])).toString("base64url");
const decodeCursor = (cursor: string): [string, string] | undefined => {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    return Array.isArray(value) && value.length === 2 && value.every((item) => typeof item === "string")
      ? [value[0], value[1]]
      : undefined;
  } catch {
    return undefined;
  }
};

export class PhoneNumberApiRepository {
  private readonly numbers: Collection<Stored<PhoneNumberDocument>>;

  constructor(db: Db, private readonly orgId = "default") {
    this.numbers = db.collection("phone_numbers");
  }

  async initialize(): Promise<void> {
    await Promise.all([
      this.numbers.createIndex({ orgId: 1, id: 1 }, { unique: true }),
      this.numbers.createIndex({ orgId: 1, createdAt: -1, id: -1 }),
    ]);
  }

  async list(range: TimeRange, limit: number): Promise<PhoneNumberDocument[]> {
    const documents = await this.numbers
      .find({ orgId: this.orgId, ...timeFilters(range) })
      .sort({ createdAt: -1, id: -1 })
      .limit(limit)
      .toArray();
    return documents.map(strip) as PhoneNumberDocument[];
  }

  async page(query: PhoneNumberPageQuery): Promise<PhoneNumberPage> {
    const direction = query.sortOrder === "ASC" ? 1 : -1;
    const clauses: Filter<Stored<PhoneNumberDocument>>[] = [{ orgId: this.orgId }, timeFilters(query)];
    if (query.search) {
      const pattern = new RegExp(escapeRegex(query.search), "i");
      clauses.push({ $or: [{ name: pattern }, { number: pattern }] });
    }
    const base: Filter<Stored<PhoneNumberDocument>> = { $and: clauses };
    const totalItems = await this.numbers.countDocuments(base);
    const decoded = query.cursor ? decodeCursor(query.cursor) : undefined;
    const keyset: Filter<Stored<PhoneNumberDocument>> = decoded
      ? {
          $or: [
            { createdAt: { [direction === 1 ? "$gt" : "$lt"]: decoded[0] } },
            { createdAt: decoded[0], id: { [direction === 1 ? "$gt" : "$lt"]: decoded[1] } },
          ],
        }
      : {};
    const cursor = this.numbers
      .find(decoded ? { $and: [base, keyset] } : base)
      .sort({ createdAt: direction, id: direction });
    const documents = await (decoded ? cursor : cursor.skip((query.page - 1) * query.limit))
      .limit(query.limit + 1)
      .toArray();
    const results = documents.slice(0, query.limit).map(strip) as PhoneNumberDocument[];
    const last = results.at(-1);
    return {
      results,
      totalItems,
      ...(documents.length > query.limit && last ? { nextCursor: encodeCursor(last.createdAt, last.id) } : {}),
    };
  }

  async get(id: string): Promise<PhoneNumberDocument | undefined> {
    const document = await this.numbers.findOne({ orgId: this.orgId, id });
    return document ? (strip(document) as PhoneNumberDocument) : undefined;
  }

  async byAssistant(assistantId: string): Promise<PhoneNumberDocument | undefined> {
    const document = await this.numbers.findOne({ orgId: this.orgId, assistantId }, { sort: { createdAt: 1 } });
    return document ? (strip(document) as PhoneNumberDocument) : undefined;
  }

  async byNumbers(numbers: string[]): Promise<Map<string, PhoneNumberDocument>> {
    if (!numbers.length) return new Map();
    const documents = await this.numbers.find({ orgId: this.orgId, number: { $in: numbers } }).toArray();
    return new Map(documents.map((document) => [document.number, strip(document) as PhoneNumberDocument]));
  }

  async create(input: Omit<PhoneNumberDocument, "id" | "orgId" | "createdAt" | "updatedAt">): Promise<PhoneNumberDocument> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const document: Stored<PhoneNumberDocument> = {
      ...input,
      id,
      _id: `${this.orgId}:${input.number}`,
      orgId: this.orgId,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await this.numbers.insertOne(document);
    } catch (error) {
      if (isDuplicateKey(error)) throw conflict("Phone number already exists.");
      throw error;
    }
    return strip(document) as PhoneNumberDocument;
  }

  async update(id: string, fields: Partial<Pick<PhoneNumberDocument, "name" | "assistantId">>): Promise<PhoneNumberDocument | undefined> {
    const updated = await this.numbers.findOneAndUpdate(
      { orgId: this.orgId, id },
      { $set: { ...fields, updatedAt: new Date().toISOString() } },
      { returnDocument: "after" },
    );
    return updated ? (strip(updated) as PhoneNumberDocument) : undefined;
  }

  async delete(id: string): Promise<PhoneNumberDocument | undefined> {
    const removed = await this.numbers.findOneAndDelete({ orgId: this.orgId, id });
    return removed ? (strip(removed) as PhoneNumberDocument) : undefined;
  }
}

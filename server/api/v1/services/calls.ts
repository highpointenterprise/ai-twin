import { renderCallAgent, normalizeVariables } from "../../../calls/variables";
import type { SimpleCallBody } from "../schemas/create-call";
import { createHash, randomUUID } from "node:crypto";
import type { Document, Filter } from "mongodb";
import { env } from "../../../../lib/env";
import type { ToolConfig } from "../../../../lib/config";
import type { AgentConfig, TranscriptLine } from "../../../../lib/types";
import { HttpError } from "../../../core/errors";
import type { CallDispatcher, Readiness } from "../../../calls/dispatcher";
import { effectiveAssistant } from "../../../engine/settings";
import { callsAdmitted } from "../../../observability/metrics";
import type { ArtifactKind, MongoCallRepository, StoredCall } from "../../../storage/calls";
import type { CallQueue } from "../../../storage/call-queue";
import type { ObjectStore } from "../../../storage/objects";
import type { ToolRepository } from "../../../tools/registry";
import { ApiError, badRequest, conflict, notFound } from "../http/errors";
import { editableAssistant, mergeAssistant, toAgentInput } from "../mappers/assistant";
import { toApiCall } from "../mappers/call";
import type { CallRequestDocument, CallRequestRepository } from "../repositories/call-requests";
import type { AssistantApiRepository, PhoneNumberApiRepository, PhoneNumberDocument } from "../repositories/resources";
import type { AssistantBody } from "../schemas/assistant";
import type { CallListQuery, CreateCallBody, CustomerBody } from "../schemas/call";
import { timeFilters } from "../schemas/common";

export interface CallServiceDependencies {
  orgId: string;
  baseUrl: string;
  requests: CallRequestRepository;
  assistants: AssistantApiRepository;
  phoneNumbers: PhoneNumberApiRepository;
  tools: Pick<ToolRepository, "resolve">;
  calls: MongoCallRepository;
  objects: ObjectStore;
  queue: CallQueue;
  dispatcher: () => CallDispatcher;
  readiness: () => Readiness;
  defaultFrom?: string;
  accountSid?: () => string | undefined;
}

export const ARTIFACT_ROUTES = {
  "mono-recording": "monoRecording",
  "stereo-recording": "recording",
  "customer-recording": "customerRecording",
  "assistant-recording": "assistantRecording",
  "call-logs": "logs",
} as const satisfies Record<string, ArtifactKind>;
export type ArtifactRoute = keyof typeof ARTIFACT_ROUTES;

const BATCH_PARALLELISM = 10;
const SIGNED_URL_SECONDS = 300;

const builtinVariables = (customer: CustomerBody): Record<string, unknown> => {
  const now = new Date();
  return {
    now: now.toUTCString(),
    date: now.toISOString().slice(0, 10),
    time: now.toISOString().slice(11, 16),
    "customer.number": customer.number,
    ...(customer.email ? { "customer.email": customer.email } : {}),
    ...(customer.externalId ? { "customer.externalId": customer.externalId } : {}),
    ...(customer.name ? { "customer.name": customer.name } : {}),
  };
};

export interface BatchFailure {
  customer: CustomerBody;
  error: string;
}

export class CallService {
  constructor(private readonly deps: CallServiceDependencies) {}

  private view(
    request: CallRequestDocument | undefined,
    call: StoredCall | undefined,
    phoneNumbers: ReadonlyMap<string, PhoneNumberDocument>,
    transcript?: TranscriptLine[],
  ): Record<string, unknown> {
    return toApiCall({ orgId: this.deps.orgId, baseUrl: this.deps.baseUrl, request, call, phoneNumbers, transcript });
  }

  private async numberMap(numbers: string[]) {
    return this.deps.phoneNumbers.byNumbers([...new Set(numbers)]);
  }

  private assertCanAdmit(): void {
    const readiness = this.deps.readiness();
    if (readiness.state === "updating")
      throw conflict("Twilio credentials are being updated. Try again when the connection finishes.");
    if (readiness.state === "misconfigured") throw new ApiError(503, `Live calling is not configured: ${readiness.message}`);
  }

  async createSimple(body: SimpleCallBody, key?: string): Promise<Record<string, unknown>> {
    if (body.clientId !== this.deps.orgId) throw new ApiError(403, "clientId does not match the authenticated workspace.");
    const { clientId, agentId, fromNumber, toNumber, customData, ...custom } = body;
    const variables = normalizeVariables({ ...custom, ...customData, clientId, agentId, fromNumber, toNumber });
    const number = fromNumber ? (await this.deps.phoneNumbers.byNumbers([fromNumber])).get(fromNumber) : undefined;
    if (fromNumber && !number) throw badRequest("fromNumber: phone number not found in your workspace");
    const name = variables.full_name;
    const { createCallSchema } = await import("../schemas/call");
    return this.create(createCallSchema.parse({ assistantId: agentId, phoneNumberId: number?.id,
      customer: { number: toNumber, ...(name ? { name } : {}), email: variables.email, externalId: variables.contactId },
      assistantOverrides: { variableValues: variables },
    }), key);
  }

  async create(body: CreateCallBody, idempotencyKey?: string): Promise<Record<string, unknown>> {
    this.assertCanAdmit();
    if ((await this.deps.queue.depth()) >= env.MAX_QUEUED_CALLS)
      throw new ApiError(429, "Call queue is full. Retry later.", { "retry-after": "5" });
    const base = await this.baseAssistant(body);
    if (body.customer) return this.admit(body, body.customer, base, idempotencyKey);
    const customers = body.customers ?? [];
    const results: Record<string, unknown>[] = [];
    const errors: BatchFailure[] = [];
    for (let offset = 0; offset < customers.length; offset += BATCH_PARALLELISM) {
      const chunk = customers.slice(offset, offset + BATCH_PARALLELISM);
      const settled = await Promise.allSettled(
        chunk.map((customer, index) =>
          this.admit(body, customer, base, idempotencyKey ? `${idempotencyKey}:${offset + index}` : undefined),
        ),
      );
      settled.forEach((outcome, index) => {
        if (outcome.status === "fulfilled") results.push(outcome.value);
        else {
          const error = outcome.reason instanceof ApiError ? outcome.reason : new ApiError(500, "Internal server error");
          errors.push({ customer: chunk[index], error: Array.isArray(error.detail) ? error.detail.join("; ") : error.detail });
        }
      });
    }
    return {
      results,
      errors,
      subscriptionLimits: {
        concurrencyBlocked: false,
        concurrencyLimit: env.MAX_CONCURRENT_CALLS,
        remainingConcurrentCalls: Math.max(0, env.MAX_CONCURRENT_CALLS - (await this.deps.queue.activeLeases())),
      },
    };
  }

  private async baseAssistant(body: CreateCallBody): Promise<{ body: AssistantBody; assistantId?: string }> {
    if (body.assistant) return { body: body.assistant };
    const document = await this.deps.assistants.get(body.assistantId!);
    if (!document) throw badRequest("assistantId: assistant not found");
    return { body: editableAssistant(document), assistantId: document.id };
  }

  private async admit(
    body: CreateCallBody,
    customer: CustomerBody,
    base: { body: AssistantBody; assistantId?: string },
    idempotencyKey?: string,
  ): Promise<Record<string, unknown>> {
    const id = randomUUID();
    const { variableValues: _bodyVariables, ...callOverrides } = body.assistantOverrides ?? {};
    const { variableValues: _customerVariables, ...customerOverrides } = customer.assistantOverrides ?? {};
    const overrides = mergeAssistant(callOverrides, customerOverrides);
    const variableValues = { ...(body.assistantOverrides?.variableValues ?? {}), ...(customer.assistantOverrides?.variableValues ?? {}) };
    const merged = Object.keys(overrides).length ? mergeAssistant(base.body, overrides) : base.body;
    const origin = await this.resolveOrigin(body.phoneNumberId, base.assistantId);
    const agent: AgentConfig = renderCallAgent(effectiveAssistant({ ...toAgentInput(merged), id: base.assistantId ?? id }), { ...builtinVariables(customer), email: customer.email, contactId: customer.externalId, toNumber: customer.number, ...variableValues, fromNumber: origin.number, callId: id });
    if (!agent.voiceId) throw new ApiError(503, "Live calling is not configured: Assistant voice ID");
    const tools = await this.resolveTools(agent.toolIds);
    const now = Date.now();
    const earliest = body.schedulePlan ? Date.parse(body.schedulePlan.earliestAt) : now;
    const scheduled = earliest > now + 1000;
    const timestamp = new Date(now).toISOString();
    const { document, replayed } = await this.deps.requests.insert({
      id,
      phase: scheduled ? "scheduled" : "queued",
      ...(body.name ? { name: body.name } : {}),
      ...(base.assistantId ? { assistantId: base.assistantId } : { transientAssistant: base.body }),
      ...(body.assistantOverrides ? { assistantOverrides: body.assistantOverrides } : {}),
      phoneNumberId: origin.id,
      customer,
      ...(body.transport ? { transport: body.transport } : {}),
      from: origin.number,
      agent,
      tools,
      brief: "",
      ...(body.schedulePlan ? { schedulePlan: body.schedulePlan } : {}),
      attempts: 0,
      runAt: Math.max(now, earliest),
      ...(idempotencyKey ? { idempotencyKey, requestHash: createHash("sha256").update(JSON.stringify({ ...body, customers: undefined, customer })).digest("hex") } : {}),
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    if (!replayed) {
      try {
        await this.deps.queue.enqueue(document.id, document.runAt);
      } catch {
        await this.deps.requests.delete(document.id);
        throw new ApiError(503, "Call queue is unavailable. Retry shortly.");
      }
      callsAdmitted.inc({ scheduled: String(scheduled) });
      this.deps.dispatcher().kick();
    }
    const call = document.providerCallSid ? await this.deps.calls.get(document.providerCallSid) : undefined;
    return this.view(document, call, await this.numberMap([document.from]));
  }

  private async resolveTools(ids: string[]): Promise<ToolConfig[]> {
    try {
      return await this.deps.tools.resolve(ids);
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) throw badRequest("model.toolIds: tool not found");
      throw error;
    }
  }

  private async resolveOrigin(phoneNumberId: string | undefined, assistantId: string | undefined): Promise<{ id?: string; number: string }> {
    if (phoneNumberId) {
      const record = await this.deps.phoneNumbers.get(phoneNumberId);
      if (!record) throw badRequest("phoneNumberId: phone number not found");
      this.validateOrigin(record);
      return { id: record.id, number: record.number };
    }
    const assigned = assistantId ? await this.deps.phoneNumbers.byAssistant(assistantId) : undefined;
    if (assigned) { this.validateOrigin(assigned); return { id: assigned.id, number: assigned.number }; }
    if (this.deps.defaultFrom) return { number: this.deps.defaultFrom };
    throw badRequest("phoneNumberId: provide a phone number or assign one to the assistant");
  }

  private validateOrigin(record: PhoneNumberDocument) {
    if (record.configuration?.capabilities?.voice === false) throw badRequest("phoneNumberId: this number does not support voice calls");
    if (this.deps.accountSid && record.twilioAccountSid && record.twilioAccountSid !== this.deps.accountSid()) throw badRequest("phoneNumberId: phone number is not connected to your current Twilio account");
  }

  private async load(id: string): Promise<{ request?: CallRequestDocument; call?: StoredCall } | undefined> {
    const { requests, calls } = this.deps;
    const request = (await requests.get(id)) ?? (await requests.getBySid(id));
    if (request) return { request, call: request.providerCallSid ? await calls.get(request.providerCallSid) : undefined };
    const call = await calls.get(id);
    if (!call) return undefined;
    const linked = call.requestId ? await requests.get(call.requestId) : undefined;
    return { request: linked, call };
  }

  async get(id: string): Promise<Record<string, unknown>> {
    const loaded = await this.load(id);
    if (!loaded) throw notFound("Call not found");
    const { request, call } = loaded;
    const own = request?.from ?? (call?.direction === "outbound" ? call.from : call?.to);
    const transcript = call ? await this.deps.calls.transcript(call.sid) : undefined;
    return this.view(request, call, await this.numberMap(own ? [own] : []), transcript);
  }

  async list(query: CallListQuery): Promise<Record<string, unknown>[]> {
    const { requests, calls, phoneNumbers } = this.deps;
    if (query.limit < 1) return [];
    let numberFilter: string | undefined;
    if (query.phoneNumberId) {
      const record = await phoneNumbers.get(query.phoneNumberId);
      if (!record) return [];
      numberFilter = record.number;
    }
    const range = {
      createdAtGt: query.createdAtGt, createdAtLt: query.createdAtLt, createdAtGe: query.createdAtGe, createdAtLe: query.createdAtLe,
      updatedAtGt: query.updatedAtGt, updatedAtLt: query.updatedAtLt, updatedAtGe: query.updatedAtGe, updatedAtLe: query.updatedAtLe,
    };
    const [requestRows, legacyRows] = await Promise.all([
      requests.list({ id: query.id, assistantId: query.assistantId, phoneNumberId: query.phoneNumberId, range, limit: query.limit }),
      calls.findMany(
        {
          requestId: { $exists: false },
          ...timeFilters(range, { createdAt: "iso", updatedAt: "epoch" }),
          ...(query.id ? { _id: query.id } : {}),
          ...(query.assistantId ? { assistantId: query.assistantId } : {}),
          ...(numberFilter ? { $or: [{ from: numberFilter }, { to: numberFilter }] } : {}),
        } as Filter<Document>,
        query.limit,
      ),
    ]);
    const linked = await calls.getMany(requestRows.flatMap((row) => (row.providerCallSid ? [row.providerCallSid] : [])));
    const numbers = await this.numberMap([
      ...requestRows.map((row) => row.from),
      ...legacyRows.map((row) => (row.direction === "outbound" ? row.from : row.to)),
    ]);
    const merged = [
      ...requestRows.map((request) => ({ at: request.createdAt, id: request.id, view: this.view(request, request.providerCallSid ? linked.get(request.providerCallSid) : undefined, numbers) })),
      ...legacyRows.map((call) => ({ at: call.createdAt, id: call.id, view: this.view(undefined, call, numbers) })),
    ];
    return merged
      .sort((left, right) => (left.at === right.at ? (left.id < right.id ? 1 : -1) : left.at < right.at ? 1 : -1))
      .slice(0, query.limit)
      .map((entry) => entry.view);
  }

  async update(id: string, patch: { name?: string }): Promise<Record<string, unknown>> {
    const loaded = await this.load(id);
    if (!loaded) throw notFound("Call not found");
    if (!loaded.request) throw conflict("This call was not created through the API and cannot be renamed.");
    if (patch.name === undefined) return this.get(id);
    const updated = await this.deps.requests.rename(loaded.request.id, patch.name);
    if (!updated) throw notFound("Call not found");
    return this.get(updated.id);
  }

  async remove(id: string): Promise<Record<string, unknown>> {
    const loaded = await this.load(id);
    if (!loaded) throw notFound("Call not found");
    const { request, call } = loaded;
    const snapshot = await this.get(id);
    if (request && (request.phase === "queued" || request.phase === "scheduled")) {
      if (!(await this.deps.requests.cancel(request.id))) throw conflict("Call is already being placed.");
      await this.deps.queue.remove(request.id);
      return snapshot;
    }
    if (request?.phase === "failed" && !call) {
      await this.deps.requests.delete(request.id);
      return snapshot;
    }
    if (request?.phase === "dialing" || !call) throw conflict("Call is in progress and cannot be deleted.");
    if (call.status !== "completed" && call.status !== "failed") throw conflict("Call is in progress and cannot be deleted.");
    if (call.storagePending) throw conflict("Call is still being archived. Retry shortly.");
    await this.deps.calls.purge(call.sid, this.deps.objects);
    if (request) await this.deps.requests.delete(request.id);
    return snapshot;
  }

  async artifactUrl(id: string, route: ArtifactRoute): Promise<string> {
    const loaded = await this.load(id);
    if (!loaded) throw notFound("Call not found");
    const stored = loaded.call?.artifact?.[ARTIFACT_ROUTES[route]];
    if (!stored) throw notFound("Artifact not found");
    return this.deps.objects.signedUrl(stored.key, SIGNED_URL_SECONDS, route === "call-logs" ? "attachment" : "inline");
  }
}

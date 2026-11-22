import { createHash, randomUUID } from "node:crypto";
import { MongoServerError, type Db, type Collection } from "mongodb";
import type { StoredObject } from "../storage/objects";
import type { ServerEventType } from "./end-of-call-report";
import { DeliveryError } from "./transport";

export interface Delivery {
  _id: string;
  userId: string;
  callId: string;
  event: ServerEventType;
  url: string;
  timeoutSeconds: number;
  payload: StoredObject;
  state: "pending" | "delivering" | "delivered" | "failed";
  attempts: number;
  dueAt: Date;
  createdAt: Date;
  deliveredAt?: Date;
  leaseUntil?: Date;
  claim?: string;
  statusCode?: number;
  lastError?: string;
}
export const MAX_DELIVERY_ATTEMPTS = 10;
export class ServerEventOutbox {
  private readonly collection: Collection<Delivery>;
  constructor(
    db: Db,
    private readonly userId: string,
  ) {
    this.collection = db.collection("server_event_deliveries");
  }
  async initialize() {
    await this.collection.createIndex({
      userId: 1,
      state: 1,
      dueAt: 1,
      leaseUntil: 1,
    });
    await this.collection.createIndex(
      { userId: 1, callId: 1, event: 1 },
      { unique: true },
    );
  }
  id(callId: string, event: ServerEventType) {
    return createHash("sha256")
      .update(`${this.userId}\0${callId}\0${event}`)
      .digest("hex");
  }
  async exists(callId: string, event: ServerEventType) {
    return !!(await this.collection.findOne(
      { _id: this.id(callId, event), userId: this.userId },
      { projection: { _id: 1 } },
    ));
  }
  async enqueue(
    input: Pick<
      Delivery,
      "callId" | "event" | "url" | "timeoutSeconds" | "payload"
    >,
  ) {
    const now = new Date();
    try {
      await this.collection.updateOne(
        { _id: this.id(input.callId, input.event), userId: this.userId },
        {
          $setOnInsert: {
            ...input,
            userId: this.userId,
            state: "pending",
            attempts: 0,
            dueAt: now,
            createdAt: now,
          },
        },
        { upsert: true },
      );
    } catch (error) {
      if (!(error instanceof MongoServerError && error.code === 11000))
        throw error;
    }
  }
  async claim(now = new Date()): Promise<Delivery | null> {
    return this.collection.findOneAndUpdate(
      {
        userId: this.userId,
        $or: [
          { state: "pending", dueAt: { $lte: now } },
          { state: "delivering", leaseUntil: { $lte: now } },
        ],
      },
      {
        $set: {
          state: "delivering",
          claim: randomUUID(),
          leaseUntil: new Date(now.getTime() + 360_000),
        },
        $inc: { attempts: 1 },
      },
      { sort: { dueAt: 1 }, returnDocument: "after" },
    );
  }
  async renew(delivery: Delivery): Promise<boolean> {
    const result = await this.collection.updateOne(
      {
        _id: delivery._id,
        userId: this.userId,
        claim: delivery.claim,
        state: "delivering",
      },
      { $set: { leaseUntil: new Date(Date.now() + 360_000) } },
    );
    return result.matchedCount === 1;
  }
  async success(delivery: Delivery, statusCode: number) {
    await this.collection.updateOne(
      {
        _id: delivery._id,
        userId: this.userId,
        claim: delivery.claim,
        state: "delivering",
      },
      {
        $set: { state: "delivered", deliveredAt: new Date(), statusCode },
        $unset: { claim: "", leaseUntil: "", lastError: "" },
      },
    );
  }
  async failure(delivery: Delivery, error: DeliveryError, now = new Date()) {
    const state =
      error.retryable && delivery.attempts < MAX_DELIVERY_ATTEMPTS
        ? "pending"
        : "failed";
    const backoff = Math.min(300_000, 5000 * 2 ** (delivery.attempts - 1));
    await this.collection.updateOne(
      {
        _id: delivery._id,
        userId: this.userId,
        claim: delivery.claim,
        state: "delivering",
      },
      {
        $set: {
          state,
          dueAt: new Date(
            now.getTime() + Math.max(backoff, error.retryAfterMs ?? 0),
          ),
          lastError: error.message,
          ...(error.status ? { statusCode: error.status } : {}),
        },
        $unset: { claim: "", leaseUntil: "" },
      },
    );
    return state;
  }
  async list(callId: string) {
    return this.collection
      .find(
        { userId: this.userId, callId },
        {
          projection: {
            _id: 0,
            event: 1,
            state: 1,
            attempts: 1,
            dueAt: 1,
            deliveredAt: 1,
            statusCode: 1,
            lastError: 1,
          },
        },
      )
      .toArray();
  }
  async retryFailed(callId: string) {
    await this.collection.updateMany(
      { userId: this.userId, callId, state: "failed" },
      {
        $set: { state: "pending", attempts: 0, dueAt: new Date() },
        $unset: { lastError: "", statusCode: "" },
      },
    );
  }
  async pending() {
    return !!(await this.collection.findOne(
      { userId: this.userId, state: { $in: ["pending", "delivering"] } },
      { projection: { _id: 1 } },
    ));
  }
}

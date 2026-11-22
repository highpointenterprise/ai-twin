import { randomUUID } from "node:crypto";
import { MongoServerError, type Db } from "mongodb";
import type { TelephonyNumber } from "../core/ports";
import type { PhoneNumberDocument } from "../api/v1/repositories/resources";
import { HttpError } from "../core/errors";

export class NumberRepository {
  constructor(
    private readonly db: Db,
    private readonly owner: string,
  ) {}
  private get numbers() {
    return this.db.collection<PhoneNumberDocument & { _id: string }>(
      "phone_numbers",
    );
  }
  async sync(account: string, numbers: TelephonyNumber[]) {
    for (const n of numbers) await this.save(account, n);
    await this.numbers.updateMany(
      {
        orgId: this.owner,
        $or: [
          { twilioAccountSid: { $ne: account } },
          { twilioNumberSid: { $nin: numbers.map((n) => n.sid) } },
        ],
      },
      {
        $set: {
          available: false,
          assistantId: null,
          updatedAt: new Date().toISOString(),
        },
      },
    );
  }
  async save(account: string, number: TelephonyNumber) {
    const now = new Date().toISOString();
    const prior = await this.numbers.findOne({
      orgId: this.owner,
      number: number.phoneNumber,
    });
    const reset =
      prior &&
      ((prior.twilioAccountSid && prior.twilioAccountSid !== account) ||
        prior.available === false);
    await this.numbers.updateOne(
      { orgId: this.owner, number: number.phoneNumber },
      {
        $set: {
          name: number.label,
          provider: "twilio",
          twilioAccountSid: account,
          twilioNumberSid: number.sid,
          available: true,
          configuration: number,
          updatedAt: now,
          ...(reset ? { assistantId: null } : {}),
        },
        $setOnInsert: {
          _id: `${this.owner}:${number.phoneNumber}`,
          id: randomUUID(),
          orgId: this.owner,
          number: number.phoneNumber,
          createdAt: now,
          ...(!reset ? { assistantId: null } : {}),
        },
      },
      { upsert: true },
    );
    return (await this.numbers.findOne({
      orgId: this.owner,
      number: number.phoneNumber,
    }))!;
  }
  async find(account: string, number: string) {
    return this.numbers.findOne({
      orgId: this.owner,
      twilioAccountSid: account,
      number,
      available: true,
    });
  }
  async legacy(number: string) {
    return this.numbers.findOne({
      orgId: this.owner,
      number,
      twilioAccountSid: { $exists: false },
      available: { $ne: false },
    });
  }
  async assign(account: string, sid: string, assistantId: string | null) {
    const updated = await this.numbers.findOneAndUpdate(
      {
        orgId: this.owner,
        twilioAccountSid: account,
        twilioNumberSid: sid,
        available: true,
      },
      { $set: { assistantId, updatedAt: new Date().toISOString() } },
      { returnDocument: "after" },
    );
    if (!updated)
      throw new HttpError(404, "Phone number not found in your account.");
    return updated;
  }
  async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const locks = this.db.collection<{
      _id: string;
      token: string;
      expires: Date;
    }>("phone_number_locks");
    const token = randomUUID();
    const expires = () => new Date(Date.now() + 120_000);
    try {
      await locks.updateOne(
        { _id: this.owner, expires: { $lte: new Date() } },
        { $set: { token, expires: expires() } },
        { upsert: true },
      );
    } catch (error) {
      if (error instanceof MongoServerError && error.code === 11000)
        throw new HttpError(
          409,
          "A phone number or Twilio connection update is in progress. Try again shortly.",
        );
      throw error;
    }
    const timer = setInterval(() => {
      void locks
        .updateOne({ _id: this.owner, token }, { $set: { expires: expires() } })
        .catch(() => {});
    }, 30_000);
    timer.unref();
    try {
      return await operation();
    } finally {
      clearInterval(timer);
      await locks.deleteOne({ _id: this.owner, token });
    }
  }
  async beginPurchase(account: string, number: string) {
    const purchases = this.db.collection<{ _id: string; state: string }>(
      "phone_number_purchases",
    );
    const id = `${this.owner}:${account}:${number}`;
    try {
      await purchases.insertOne({ _id: id, state: "pending" });
    } catch (error) {
      if (error instanceof MongoServerError && error.code === 11000)
        throw new HttpError(
          409,
          "A purchase for this number was already submitted. Refresh your numbers to reconcile it; check Twilio before trying another purchase.",
        );
      throw error;
    }
  }
  async cancelPurchase(account: string, number: string) {
    await this.db
      .collection<{ _id: string }>("phone_number_purchases")
      .deleteOne({ _id: `${this.owner}:${account}:${number}` });
  }
  async completePurchase(account: string, number: TelephonyNumber) {
    await this.db
      .collection<{
        _id: string;
        state: string;
        numberSid?: string;
        completedAt?: Date;
      }>("phone_number_purchases")
      .updateOne(
        { _id: `${this.owner}:${account}:${number.phoneNumber}` },
        {
          $set: {
            state: "completed",
            numberSid: number.sid,
            completedAt: new Date(),
          },
        },
      );
  }
}

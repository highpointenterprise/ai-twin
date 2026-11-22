import { createHash } from "node:crypto";
import type { Db } from "mongodb";
export const apiKeyDigest = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export const validApiKey = (token: string) =>
  /^twk_[A-Za-z0-9_-]{43}$/.test(token);
export class ApiKeyDirectory {
  constructor(private readonly db: Db) {}
  private get keys() {
    return this.db.collection<{ _id: string; userId: string; keyId: string }>(
      "api_key_directory",
    );
  }
  async register(hash: string, userId: string, keyId: string) {
    await this.keys.updateOne(
      { _id: hash, userId },
      { $setOnInsert: { userId, keyId } },
      { upsert: true },
    );
  }
  async remove(hash: string, userId: string) {
    await this.keys.deleteOne({ _id: hash, userId });
  }
  async owner(token: string): Promise<string | undefined> {
    if (!validApiKey(token)) return;
    const record = await this.keys.findOne({ _id: apiKeyDigest(token) });
    if (!record) return;
    const user = await this.db
      .collection<{ _id: string }>("users")
      .findOne({ _id: record.userId }, { projection: { _id: 1 } });
    return user?._id;
  }
}

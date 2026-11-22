import { createHash, randomBytes, randomUUID } from "node:crypto";
import { MongoServerError, type Collection, type Db } from "mongodb";
import { SESSION_MAX_AGE, type AuthSession, type AuthUser } from "../../lib/auth";
import { hashPassword, verifyPassword } from "./password";

interface UserDocument {
  _id: string;
  name: string;
  email: string;
  passwordHash: string;
  createdAt: Date;
}

interface SessionDocument {
  _id: string;
  userId: string;
  expiresAt: Date;
}

interface AttemptDocument {
  _id: string;
  count: number;
  expiresAt: Date;
}

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const publicUser = (user: UserDocument): AuthUser => ({ id: user._id, name: user.name, email: user.email });

export class DuplicateEmailError extends Error {}

export class AuthStore {
  private readonly users: Collection<UserDocument>;
  private readonly sessions: Collection<SessionDocument>;
  private readonly attempts: Collection<AttemptDocument>;

  constructor(db: Db) {
    this.users = db.collection("users");
    this.sessions = db.collection("user_sessions");
    this.attempts = db.collection("auth_attempts");
  }

  async initialize(): Promise<void> {
    await Promise.all([
      this.users.createIndex({ email: 1 }, { unique: true }),
      this.sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      this.sessions.createIndex({ userId: 1 }),
      this.attempts.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    ]);
  }

  async signup(input: { name: string; email: string; password: string }): Promise<AuthUser> {
    const user: UserDocument = {
      _id: randomUUID(),
      name: input.name,
      email: input.email,
      passwordHash: await hashPassword(input.password),
      createdAt: new Date(),
    };
    try {
      await this.users.insertOne(user);
    } catch (error) {
      if (error instanceof MongoServerError && error.code === 11000) throw new DuplicateEmailError();
      throw error;
    }
    return publicUser(user);
  }

  async login(email: string, password: string): Promise<AuthSession | null> {
    const user = await this.users.findOne({ email });
    const verified = await verifyPassword(password, user?.passwordHash);
    if (!user || !verified) return null;
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + SESSION_MAX_AGE * 1000);
    await this.sessions.insertOne({ _id: digest(token), userId: user._id, expiresAt });
    return { user: publicUser(user), token, expiresAt: expiresAt.toISOString() };
  }

  async userForSession(token: string): Promise<AuthUser | null> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const session = await this.sessions.findOne({ _id: digest(token), expiresAt: { $gt: new Date() } });
    if (!session) return null;
    const user = await this.users.findOne({ _id: session.userId });
    return user ? publicUser(user) : null;
  }

  async revokeSession(token: string): Promise<void> {
    await this.sessions.deleteOne({ _id: digest(token) });
  }

  async allowAttempt(key: string, limit: number, windowMs: number): Promise<{ allowed: boolean; retryAfter: number }> {
    const now = Date.now();
    const bucket = Math.floor(now / windowMs);
    const expiresAt = new Date((bucket + 1) * windowMs);
    const id = digest(`${key}:${bucket}`);
    const update = { $inc: { count: 1 }, $setOnInsert: { expiresAt } };
    let attempt: AttemptDocument | null;
    try {
      attempt = await this.attempts.findOneAndUpdate({ _id: id }, update, { upsert: true, returnDocument: "after" });
    } catch (error) {
      if (!(error instanceof MongoServerError) || error.code !== 11000) throw error;
      attempt = await this.attempts.findOneAndUpdate({ _id: id }, update, { returnDocument: "after" });
    }
    return { allowed: !!attempt && attempt.count <= limit, retryAfter: Math.ceil((expiresAt.getTime() - now) / 1000) };
  }
}

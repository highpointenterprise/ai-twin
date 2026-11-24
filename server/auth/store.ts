import { randomBytes, randomUUID } from "node:crypto";
import { MongoServerError, type Collection, type Db, type Filter } from "mongodb";
import { SESSION_IDLE_MS, SESSION_MAX_AGE, type AuthSession, type AuthUser } from "../../lib/auth";
import { hashPassword, verifyPassword } from "./password";
import { digest, newTotpSecret, opaqueToken, seal, totpStep, unseal } from "./crypto";
type Action = "verify" | "reset" | "email";
interface Link { hash: string; expiresAt: Date; email?: string }
interface UserDocument {
  _id: string; name: string; email: string; passwordHash: string; createdAt: Date;
  emailVerifiedAt?: Date; disabledAt?: Date; authVersion?: number;
  verify?: Link; reset?: Link; emailChange?: Link;
  mfaSecret?: string; mfaLastStep?: number; recoveryHashes?: string[];
  mfaPending?: { secret: string; expiresAt: Date };
}
interface SessionDocument { _id: string; id: string; userId: string; authVersion: number; expiresAt: Date; createdAt: Date; lastSeenAt: Date; userAgent: string }
interface AttemptDocument { _id: string; count: number; expiresAt: Date }
const publicUser = (u: UserDocument): AuthUser => ({ id: u._id, name: u.name, email: u.email, emailVerified: !!u.emailVerifiedAt, mfaEnabled: !!u.mfaSecret });
const versionFilter = (u: UserDocument): Filter<UserDocument> => ({ _id: u._id, ...(u.authVersion === undefined ? { authVersion: { $exists: false } } : { authVersion: u.authVersion }), disabledAt: { $exists: false } });
export class DuplicateEmailError extends Error {}
export class AuthError extends Error {
  retryAfter?: number;
  constructor(readonly status: number, message: string, readonly code?: string) { super(message); }
}
export class AuthStore {
  private readonly users: Collection<UserDocument>;
  private readonly sessions: Collection<SessionDocument>;
  private readonly attempts: Collection<AttemptDocument>;
  constructor(private readonly db: Db, private readonly encryptionKey = process.env.CREDENTIAL_ENCRYPTION_KEY || "") {
    this.users = db.collection("users"); this.sessions = db.collection("user_sessions"); this.attempts = db.collection("auth_attempts");
  }
  async initialize() {
    await Promise.all([
      this.users.createIndex({ email: 1 }, { unique: true }),
      this.sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      this.sessions.createIndex({ userId: 1, createdAt: -1 }),
      this.attempts.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      this.db.collection("security_events").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      this.db.collection("security_events").createIndex({ userId: 1, createdAt: -1 }),
    ]);
  }
  async audit(userId: string, action: string) { await this.db.collection("security_events").insertOne({ userId, action, createdAt: new Date(), expiresAt: new Date(Date.now() + 90 * 86400000) }); }
  async signup(input: { name: string; email: string; password: string }): Promise<AuthUser> {
    const u: UserDocument = { _id: randomUUID(), name: input.name, email: input.email, passwordHash: await hashPassword(input.password), createdAt: new Date(), authVersion: 0 };
    try { await this.users.insertOne(u); } catch (e) { if (e instanceof MongoServerError && e.code === 11000) throw new DuplicateEmailError(); throw e; }
    await this.audit(u._id, "account.created"); return publicUser(u);
  }
  private async secondFactor(u: UserDocument, code?: string) {
    if (!u.mfaSecret) return;
    if (!code) throw new AuthError(401, "Enter an authenticator or recovery code.", "MfaRequired");
    const step = totpStep(unseal(u.mfaSecret, this.encryptionKey, `mfa:${u._id}`), code), filter = versionFilter(u);
    const r = step !== undefined
      ? await this.users.updateOne({ ...filter, mfaSecret: u.mfaSecret, $or: [{ mfaLastStep: { $lt: step } }, { mfaLastStep: { $exists: false } }] }, { $set: { mfaLastStep: step } })
      : await this.users.updateOne({ ...filter, mfaSecret: u.mfaSecret, recoveryHashes: digest(code.replaceAll("-", "").toLowerCase()) }, { $pull: { recoveryHashes: digest(code.replaceAll("-", "").toLowerCase()) } });
    if (!r.modifiedCount) throw new AuthError(401, "Invalid or already used security code.", "MfaInvalid");
  }
  async login(email: string, password: string, code?: string, userAgent = ""): Promise<AuthSession | null> {
    const u = await this.users.findOne({ email }), valid = await verifyPassword(password, u?.passwordHash);
    if (!u || !valid || u.disabledAt) { if (u) await this.audit(u._id, "login.failed"); return null; }
    if (!u.emailVerifiedAt) throw new AuthError(403, "Verify your email before signing in.", "EmailNotVerified");
    try { await this.secondFactor(u, code); } catch (e) { await this.audit(u._id, "login.mfa_failed"); throw e; }
    const token = opaqueToken(), now = new Date(), expiresAt = new Date(now.getTime() + SESSION_MAX_AGE * 1000);
    await this.sessions.insertOne({ _id: digest(token), id: randomUUID(), userId: u._id, authVersion: u.authVersion || 0, expiresAt, createdAt: now, lastSeenAt: now, userAgent: userAgent.slice(0, 200) });
    const excess = await this.sessions.find({ userId: u._id }).sort({ createdAt: -1 }).skip(20).project<{ _id: string }>({ _id: 1 }).toArray();
    if (excess.length) await this.sessions.deleteMany({ _id: { $in: excess.map(s => s._id) } });
    await this.audit(u._id, "login.succeeded"); return { user: publicUser(u), token, expiresAt: expiresAt.toISOString() };
  }
  async userForSession(token: string): Promise<AuthUser | null> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const s = await this.sessions.findOne({ _id: digest(token), expiresAt: { $gt: new Date() }, lastSeenAt: { $gt: new Date(Date.now() - SESSION_IDLE_MS) } });
    if (!s) return null;
    const u = await this.users.findOne({ _id: s.userId, disabledAt: { $exists: false }, emailVerifiedAt: { $type: "date" } });
    if (!u || s.authVersion !== (u.authVersion || 0)) return null;
    if (s.lastSeenAt.getTime() < Date.now() - 60000) await this.sessions.updateOne({ _id: s._id }, { $set: { lastSeenAt: new Date() } });
    return publicUser(u);
  }
  async revokeSession(token: string) { await this.sessions.deleteOne({ _id: digest(token) }); }
  async listSessions(userId: string, token: string) {
    const u = await this.users.findOne({ _id: userId });
    const rows = await this.sessions.find({ userId, authVersion: u?.authVersion || 0, expiresAt: { $gt: new Date() }, lastSeenAt: { $gt: new Date(Date.now() - SESSION_IDLE_MS) } }).sort({ createdAt: -1 }).limit(20).toArray();
    return rows.map(s => ({ id: s.id, current: s._id === digest(token), createdAt: s.createdAt.toISOString(), lastSeenAt: s.lastSeenAt.toISOString(), expiresAt: s.expiresAt.toISOString(), userAgent: s.userAgent }));
  }
  async revokeById(userId: string, id: string) { const r = await this.sessions.deleteOne({ userId, id }); if (r.deletedCount) await this.audit(userId, "session.revoked"); return !!r.deletedCount; }
  async revokeOthers(userId: string, token: string) { await this.sessions.deleteMany({ userId, _id: { $ne: digest(token) } }); await this.audit(userId, "sessions.others_revoked"); }
  async activity(userId: string) { return (await this.db.collection("security_events").find({ userId }).sort({ createdAt: -1 }).limit(50).toArray()).map(e => ({ id: String(e._id), action: e.action as string, createdAt: (e.createdAt as Date).toISOString() })); }
  async updateProfile(userId: string, name: string) { const u = await this.users.findOneAndUpdate({ _id: userId }, { $set: { name } }, { returnDocument: "after" }); await this.audit(userId, "profile.updated"); return publicUser(u!); }
  async issueLink(email: string, action: "verify" | "reset") {
    const u = await this.users.findOne({ email, disabledAt: { $exists: false } });
    if (!u || (action === "verify" && u.emailVerifiedAt)) return null;
    const token = opaqueToken();
    const r = await this.users.updateOne(versionFilter(u), { $set: { [action]: { hash: digest(token), expiresAt: new Date(Date.now() + (action === "reset" ? 30 : 1440) * 60000) } } });
    return r.matchedCount ? { userId: u._id, email: u.email, token } : null;
  }
  async consumeLink(action: Action, token: string, password?: string) {
    const field = action === "email" ? "emailChange" : action;
    const filter: Filter<UserDocument> = { [`${field}.hash`]: digest(token), [`${field}.expiresAt`]: { $gt: new Date() }, disabledAt: { $exists: false } };
    const u = await this.users.findOne(filter);
    if (!u) throw new AuthError(400, "This link is invalid or expired. Request a new one.");
    const set: Partial<UserDocument> = { emailVerifiedAt: new Date() };
    if (action === "reset") set.passwordHash = await hashPassword(password!);
    if (action === "email") set.email = u.emailChange!.email!;
    try {
      const r = await this.users.updateOne({ ...filter, ...versionFilter(u) }, { $set: set, $unset: { verify: "", reset: "", emailChange: "", mfaPending: "" }, $inc: { authVersion: 1 } });
      if (!r.modifiedCount) throw new AuthError(400, "This link is invalid or expired. Request a new one.");
    } catch (e) { if (e instanceof MongoServerError && e.code === 11000) throw new AuthError(400, "This email change cannot be completed."); throw e; }
    await this.sessions.deleteMany({ userId: u._id });
    await this.audit(u._id, action === "reset" ? "password.reset" : action === "email" ? "email.changed" : "email.verified");
  }
  private async proof(userId: string, password: string, code?: string) {
    const u = await this.users.findOne({ _id: userId, disabledAt: { $exists: false }, emailVerifiedAt: { $type: "date" } });
    if (!await verifyPassword(password, u?.passwordHash) || !u) throw new AuthError(401, "Your current password is incorrect.");
    await this.secondFactor(u, code); return u;
  }
  async changePassword(userId: string, current: string, password: string, code?: string) {
    const u = await this.proof(userId, current, code), passwordHash = await hashPassword(password);
    const r = await this.users.updateOne(versionFilter(u), { $set: { passwordHash }, $inc: { authVersion: 1 }, $unset: { reset: "", emailChange: "", mfaPending: "" } });
    if (!r.modifiedCount) throw new AuthError(409, "Account changed. Sign in again.");
    await this.sessions.deleteMany({ userId }); await this.audit(userId, "password.changed");
  }
  async changeEmail(userId: string, email: string, current: string, code?: string) {
    const u = await this.proof(userId, current, code);
    if (email === u.email) throw new AuthError(400, "Enter a different email address.");
    if (await this.users.findOne({ email })) throw new AuthError(400, "This email change cannot be completed.");
    const token = opaqueToken();
    const r = await this.users.updateOne(versionFilter(u), { $set: { emailChange: { email, hash: digest(token), expiresAt: new Date(Date.now() + 30 * 60000) } } });
    if (!r.modifiedCount) throw new AuthError(409, "Account changed. Sign in again.");
    await this.audit(userId, "email.change_requested"); return { userId, email, token };
  }
  async setupMfa(userId: string, current: string, code?: string) {
    const u = await this.proof(userId, current, code);
    if (u.mfaSecret) throw new AuthError(409, "Two-factor authentication is already enabled.");
    const secret = newTotpSecret();
    const r = await this.users.updateOne(versionFilter(u), { $set: { mfaPending: { secret: seal(secret, this.encryptionKey, `mfa:${userId}`), expiresAt: new Date(Date.now() + 600000) } } });
    if (!r.matchedCount) throw new AuthError(409, "Account changed. Sign in again.");
    return { secret, uri: `otpauth://totp/${encodeURIComponent(`AI Twin:${u.email}`)}?secret=${secret}&issuer=AI%20Twin&algorithm=SHA1&digits=6&period=30` };
  }
  async enableMfa(userId: string, code: string) {
    const u = await this.users.findOne({ _id: userId, "mfaPending.expiresAt": { $gt: new Date() }, mfaSecret: { $exists: false } });
    if (!u?.mfaPending) throw new AuthError(400, "Start authenticator setup again.");
    const step = totpStep(unseal(u.mfaPending.secret, this.encryptionKey, `mfa:${userId}`), code);
    if (step === undefined) throw new AuthError(400, "Invalid authenticator code.");
    const recoveryCodes = Array.from({ length: 10 }, () => randomBytes(10).toString("hex"));
    const r = await this.users.updateOne({ ...versionFilter(u), "mfaPending.secret": u.mfaPending.secret }, { $set: { mfaSecret: u.mfaPending.secret, mfaLastStep: step, recoveryHashes: recoveryCodes.map(digest) }, $unset: { mfaPending: "" }, $inc: { authVersion: 1 } });
    if (!r.modifiedCount) throw new AuthError(409, "Account changed. Start setup again.");
    await this.sessions.deleteMany({ userId }); await this.audit(userId, "mfa.enabled"); return { recoveryCodes };
  }
  async disableMfa(userId: string, current: string, code?: string) {
    const u = await this.proof(userId, current, code);
    const r = await this.users.updateOne(versionFilter(u), { $unset: { mfaSecret: "", mfaPending: "", mfaLastStep: "", recoveryHashes: "" }, $inc: { authVersion: 1 } });
    if (!r.modifiedCount) throw new AuthError(409, "Account changed. Sign in again.");
    await this.sessions.deleteMany({ userId }); await this.audit(userId, "mfa.disabled");
  }
  async allowAttempt(key: string, limit: number, windowMs: number) {
    const now = Date.now(), bucket = Math.floor(now / windowMs), expiresAt = new Date((bucket + 1) * windowMs), id = digest(`${key}:${bucket}`);
    const update = { $inc: { count: 1 }, $setOnInsert: { expiresAt } };
    let attempt: AttemptDocument | null;
    try { attempt = await this.attempts.findOneAndUpdate({ _id: id }, update, { upsert: true, returnDocument: "after" }); }
    catch (e) { if (!(e instanceof MongoServerError && e.code === 11000)) throw e; attempt = await this.attempts.findOneAndUpdate({ _id: id }, update, { returnDocument: "after" }); }
    return { allowed: !!attempt && attempt.count <= limit, retryAfter: Math.max(1, Math.ceil((expiresAt.getTime() - now) / 1000)) };
  }
}

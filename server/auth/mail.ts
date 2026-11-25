import { randomUUID } from "node:crypto";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import type { Db } from "mongodb";
import { seal, unseal } from "./crypto";

export interface AuthMail { email: string; token: string; action: "verify" | "reset" | "email" }
export interface MailQueue { configured: boolean; enqueue(mail: AuthMail): Promise<void> }
interface MailJob { _id: string; encrypted?: string; state: "pending" | "sent" | "failed"; attempts: number; dueAt: Date; expiresAt: Date; leaseUntil?: Date }
interface MailOptions { from: string; appUrl: string; region: string; encryptionKey: string }
export class AuthMailQueue implements MailQueue {
  readonly configured: boolean;
  private readonly client: SESv2Client;
  private active?: Promise<void>;
  private readonly jobs;
  constructor(db: Db, private readonly options: MailOptions, private readonly send?: (email: string, subject: string, body: string) => Promise<void>) {
    this.jobs = db.collection<MailJob>("auth_mail_outbox");
    this.configured = !!(options.from && options.appUrl && options.encryptionKey);
    if (options.appUrl) {
      const url = new URL(options.appUrl);
      if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
        (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)))) throw new Error("NEXTAUTH_URL (or legacy AUTH_APP_URL) must be an HTTPS origin or local development origin.");
    }
    if (options.from && !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(options.from)) throw new Error("AUTH_EMAIL_FROM must be a sender email address.");
    this.client = new SESv2Client({ region: options.region, maxAttempts: 2 });
  }
  async initialize() {
    await Promise.all([this.jobs.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }), this.jobs.createIndex({ state: 1, dueAt: 1 })]);
  }
  async enqueue(mail: AuthMail) {
    if (!this.configured) throw new Error("Account email delivery is not configured.");
    const id = randomUUID();
    await this.jobs.insertOne({ _id: id, encrypted: seal(JSON.stringify(mail), this.options.encryptionKey, `auth-mail:${id}`), state: "pending", attempts: 0, dueAt: new Date(), expiresAt: new Date(Date.now() + (mail.action === "verify" ? 1440 : 30) * 60000) });
  }
  drain(): Promise<void> {
    if (!this.configured) return Promise.resolve();
    return this.active ??= this.deliver().finally(() => { this.active = undefined; });
  }
  private async deliver() {
    for (let i = 0; i < 10; i++) {
      const lease = new Date(Date.now() + 60000);
      const job = await this.jobs.findOneAndUpdate({ state: "pending", attempts: { $lt: 6 }, dueAt: { $lte: new Date() }, expiresAt: { $gt: new Date() }, $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: { $lt: new Date() } }] }, { $set: { leaseUntil: lease }, $inc: { attempts: 1 } }, { returnDocument: "after", sort: { dueAt: 1 } });
      if (!job) return;
      try {
        const mail = JSON.parse(unseal(job.encrypted!, this.options.encryptionKey, `auth-mail:${job._id}`)) as AuthMail;
        const path = { verify: "/verify-email", reset: "/reset-password", email: "/confirm-email" }[mail.action];
        const url = new URL(path, this.options.appUrl);
        url.hash = `token=${mail.token}`;
        const subject = { verify: "Verify your email", reset: "Reset your password", email: "Confirm your new email" }[mail.action];
        const body = `${subject}\n\nOpen this link and confirm your request:\n${url.href}\n\nThis link expires in ${mail.action === "verify" ? "24 hours" : "30 minutes"} and can be used only once. If you did not request this, ignore this email.\n`;
        if (this.send) await this.send(mail.email, subject, body);
        else await this.client.send(new SendEmailCommand({ FromEmailAddress: this.options.from, Destination: { ToAddresses: [mail.email] }, Content: { Simple: { Subject: { Data: subject, Charset: "UTF-8" }, Body: { Text: { Data: body, Charset: "UTF-8" } } } } }), { abortSignal: AbortSignal.timeout(20000) });
        await this.jobs.updateOne({ _id: job._id, leaseUntil: lease }, { $set: { state: "sent" }, $unset: { encrypted: "", leaseUntil: "" } });
      } catch {
        await this.jobs.updateOne({ _id: job._id, leaseUntil: lease }, { $set: { state: job.attempts >= 6 ? "failed" : "pending", dueAt: new Date(Date.now() + Math.min(3600000, 30000 * 2 ** job.attempts)) }, $unset: { leaseUntil: "" } });
        console.error("auth.mail_delivery_deferred", { id: job._id, attempt: job.attempts });
      }
    }
  }
  async close() { await this.active; this.client.destroy(); }
}

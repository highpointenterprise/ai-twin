import { createHash, timingSafeEqual } from "node:crypto";
import express, { Router, type ErrorRequestHandler, type RequestHandler } from "express";
import { z, ZodError } from "zod";
import { actionTokenSchema, changeEmailSchema, changePasswordSchema, emailRequestSchema, loginSchema, profileSchema, proofSchema, resetPasswordSchema, signupSchema } from "../../lib/auth";
import type { MailQueue } from "./mail";
import { AuthError, AuthStore, DuplicateEmailError } from "./store";

const bearer = (header?: string): string | undefined => /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(header ?? "")?.[1];

export function requireUser(store: AuthStore, workspaceUserId?: string): RequestHandler {
  return async (req, res, next) => {
    res.set("Cache-Control", "no-store");
    try {
      const token = bearer(req.get("authorization"));
      const user = token ? await store.userForSession(token) : null;
      if (!user || (workspaceUserId && user.id !== workspaceUserId)) {
        res.set("WWW-Authenticate", "Bearer").status(401).json({ error: "Sign in to continue." });
        return;
      }
      res.locals.user = user;
      res.locals.sessionToken = token;
      next();
    } catch {
      res.status(503).json({ error: "Authentication is temporarily unavailable." });
    }
  };
}

export function createAuthRouter(store: AuthStore, clientSecret: string, mail?: MailQueue): Router {
  if (clientSecret.length < 32) throw new Error("AUTH_API_SECRET must contain at least 32 characters.");
  const secretHash = createHash("sha256").update(clientSecret).digest();
  const router = Router();
  const handle = (fn: RequestHandler): RequestHandler => (req, res, next) => { Promise.resolve(fn(req, res, next)).catch(next); };
  const limit = async (key: string, count: number, window = 15 * 60000) => {
    const r = await store.allowAttempt(key, count, window);
    if (!r.allowed) { const e = new AuthError(429, "Too many attempts. Please try again later."); e.retryAfter = r.retryAfter; throw e; }
  };
  const emailReady = () => { if (!mail?.configured) throw new AuthError(503, "Account email delivery is temporarily unavailable. Please try again later."); };
  router.use((_req, res, next) => { res.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" }); next(); });
  router.get("/session", requireUser(store), (_req, res) => res.json({ user: res.locals.user }));
  router.delete("/session", requireUser(store), handle(async (_req, res) => { await store.revokeSession(res.locals.sessionToken); res.sendStatus(204); }));
  router.use("/account", requireUser(store), handle(async (_req, res, next) => { await limit(`account:${res.locals.user.id}`, 120, 60000); next(); }), express.json({ limit: "4kb", strict: true }));
  router.get("/account", handle(async (_req, res) => {
    const [sessions, activity] = await Promise.all([store.listSessions(res.locals.user.id, res.locals.sessionToken), store.activity(res.locals.user.id)]);
    res.json({ user: res.locals.user, sessions, activity });
  }));
  router.patch("/account/profile", handle(async (req, res) => { const data = profileSchema.parse(req.body); res.json({ user: await store.updateProfile(res.locals.user.id, data.name) }); }));
  router.delete("/account/sessions/:id", handle(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    if (!await store.revokeById(res.locals.user.id, id)) throw new AuthError(404, "Session not found.");
    res.sendStatus(204);
  }));
  router.post("/account/sessions/revoke-others", handle(async (_req, res) => { await store.revokeOthers(res.locals.user.id, res.locals.sessionToken); res.sendStatus(204); }));
  router.use("/account", handle(async (_req, res, next) => { await limit(`account-proof:${res.locals.user.id}`, 10); next(); }));
  router.post("/account/password", handle(async (req, res) => { const d = changePasswordSchema.parse(req.body); await store.changePassword(res.locals.user.id, d.currentPassword, d.password, d.code); res.json({ success: true, signInRequired: true }); }));
  router.post("/account/email", handle(async (req, res) => {
    emailReady(); const d = changeEmailSchema.parse(req.body);
    const link = await store.changeEmail(res.locals.user.id, d.email, d.currentPassword, d.code);
    await mail!.enqueue({ ...link, action: "email" }); res.status(202).json({ message: "Check your new email address to confirm the change." });
  }));
  router.post("/account/mfa/setup", handle(async (req, res) => { const d = proofSchema.parse(req.body); res.json(await store.setupMfa(res.locals.user.id, d.currentPassword, d.code)); }));
  router.post("/account/mfa/enable", handle(async (req, res) => { const d = z.object({ code: z.string().regex(/^\d{6}$/) }).parse(req.body); res.json(await store.enableMfa(res.locals.user.id, d.code)); }));
  router.post("/account/mfa/disable", handle(async (req, res) => { const d = proofSchema.parse(req.body); await store.disableMfa(res.locals.user.id, d.currentPassword, d.code); res.json({ success: true, signInRequired: true }); }));
  router.use("/account", (_req, res) => { res.status(404).json({ error: "Not found." }); });
  router.use(handle(async (req, _res, next) => {
    await limit(`auth:edge:${req.ip}`, 300, 60000);
    const supplied = createHash("sha256").update(req.get("x-auth-client-secret") ?? "").digest();
    if (!timingSafeEqual(secretHash, supplied)) throw new AuthError(401, "Invalid authentication client.");
    if (!req.is("application/json")) throw new AuthError(415, "Content-Type must be application/json.");
    next();
  }), express.json({ limit: "4kb", strict: true }));
  const schemas = { signup: signupSchema, login: loginSchema, "forgot-password": emailRequestSchema, "resend-verification": emailRequestSchema, "verify-email": actionTokenSchema, "reset-password": resetPasswordSchema, "confirm-email": actionTokenSchema };
  for (const action of Object.keys(schemas) as (keyof typeof schemas)[]) {
    router.post(`/${action}`, handle(async (req, res) => {
      const address = (req.get("x-auth-client-ip") || req.ip || "unknown").slice(0, 100);
      await limit(`${action}:ip:${address}`, action === "login" ? 100 : 20);
      const input = schemas[action].parse(req.body);
      if ("email" in input) await limit(`${action}:email:${input.email}`, action === "login" ? 10 : 5);
      if (action === "signup" || action === "forgot-password" || action === "resend-verification") {
        emailReady();
        if (action === "signup") {
          try { await store.signup(signupSchema.parse(input)); } catch (e) { if (!(e instanceof DuplicateEmailError)) throw e; }
        }
        const purpose = action === "forgot-password" ? "reset" : "verify";
        const link = await store.issueLink(emailRequestSchema.parse(input).email, purpose);
        if (link) await mail!.enqueue({ ...link, action: purpose });
        res.status(202).json({ message: "If your account is eligible, you will receive an email with the next steps." }); return;
      }
      if (action === "login") {
        const d = loginSchema.parse(input);
        const session = await store.login(d.email, d.password, d.code, req.get("x-auth-client-agent") || req.get("user-agent") || "");
        if (!session) throw new AuthError(401, "Invalid email or password.");
        res.json(session); return;
      }
      const d = actionTokenSchema.parse(input);
      await store.consumeLink(action === "verify-email" ? "verify" : action === "confirm-email" ? "email" : "reset", d.token, action === "reset-password" ? resetPasswordSchema.parse(input).password : undefined);
      res.json({ success: true });
    }));
  }
  const onError: ErrorRequestHandler = (error, _req, res, _next) => {
    if (error instanceof AuthError) {
      if (error.retryAfter) res.set("Retry-After", String(error.retryAfter));
      res.status(error.status).json({ error: error.message, ...(error.code ? { code: error.code } : {}) });
    } else if (error instanceof ZodError) res.status(400).json({ error: error.issues[0].message });
    else if (error?.type === "entity.parse.failed") res.status(400).json({ error: "Invalid JSON body." });
    else if (error?.type === "entity.too.large") res.status(413).json({ error: "Request body is too large." });
    else res.status(503).json({ error: "Authentication is temporarily unavailable." });
  };
  router.use(onError);
  return router;
}

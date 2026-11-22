import { createHash, timingSafeEqual } from "node:crypto";
import express, { Router, type ErrorRequestHandler, type RequestHandler } from "express";
import { loginSchema, signupSchema } from "../../lib/auth";
import { AuthStore, DuplicateEmailError } from "./store";

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

export function createAuthRouter(store: AuthStore, clientSecret: string): Router {
  if (clientSecret.length < 32) throw new Error("AUTH_API_SECRET must contain at least 32 characters.");
  const secretHash = createHash("sha256").update(clientSecret).digest();
  const router = Router();
  router.use((_req, res, next) => {
    res.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    next();
  });
  router.get("/session", requireUser(store), (_req, res) => res.json({ user: res.locals.user }));
  router.delete("/session", requireUser(store), async (_req, res, next) => {
    try {
      await store.revokeSession(res.locals.sessionToken);
      res.sendStatus(204);
    } catch (error) { next(error); }
  });
  router.use((req, res, next) => {
    const supplied = createHash("sha256").update(req.get("x-auth-client-secret") ?? "").digest();
    if (!timingSafeEqual(secretHash, supplied)) {
      res.status(401).json({ error: "Invalid authentication client." });
      return;
    }
    if (!req.is("application/json")) {
      res.status(415).json({ error: "Content-Type must be application/json." });
      return;
    }
    next();
  });
  router.use(express.json({ limit: "4kb", strict: true }));

  for (const action of ["signup", "login"] as const) {
    router.post(`/${action}`, async (req, res, next) => {
      try {
        const address = (req.get("x-auth-client-ip") || req.ip || "unknown").slice(0, 100);
        const addressLimit = await store.allowAttempt(`${action}:ip:${address}`, action === "signup" ? 20 : 100, 15 * 60_000);
        if (!addressLimit.allowed) {
          res.set("Retry-After", String(addressLimit.retryAfter)).status(429).json({ error: "Too many attempts. Please try again later." });
          return;
        }
        const input = (action === "signup" ? signupSchema : loginSchema).safeParse(req.body);
        if (!input.success) {
          res.status(400).json({ error: input.error.issues[0].message });
          return;
        }
        const emailLimit = await store.allowAttempt(`${action}:email:${input.data.email}`, 10, 15 * 60_000);
        if (!emailLimit.allowed) {
          res.set("Retry-After", String(emailLimit.retryAfter)).status(429).json({ error: "Too many attempts. Please try again later." });
          return;
        }
        if (action === "signup") {
          const user = await store.signup(signupSchema.parse(input.data));
          res.status(201).json({ user });
          return;
        }
        const session = await store.login(input.data.email, input.data.password);
        if (!session) {
          res.status(401).json({ error: "Invalid email or password." });
          return;
        }
        res.json(session);
      } catch (error) { next(error); }
    });
  }

  const onError: ErrorRequestHandler = (error, _req, res, _next) => {
    if (error instanceof DuplicateEmailError) {
      res.status(409).json({ error: "An account with this email already exists. Log in instead." });
    } else if (error?.type === "entity.parse.failed") {
      res.status(400).json({ error: "Invalid JSON body." });
    } else if (error?.type === "entity.too.large") {
      res.status(413).json({ error: "Request body is too large." });
    } else {
      res.status(503).json({ error: "Authentication is temporarily unavailable." });
    }
  };
  router.use(onError);
  return router;
}

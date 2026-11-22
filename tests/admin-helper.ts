import { Router } from "express";
import { createAdminApp, type HttpDeps } from "../server/http/routes";

export const createTestAdminApp = (deps: HttpDeps) => createAdminApp(deps, {
  router: Router(),
  requireUser: (_req, res, next) => {
    res.locals.user = { id: "test-user", name: "Test User", email: "test@example.com" };
    next();
  },
});

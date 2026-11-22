import { Router } from "express";
import { z } from "zod";
import type { ApiKeyStore } from "../auth/api-keys";
import { asyncRoute, apiErrorHandler, notFound } from "../http/errors";
const nameSchema = z
  .object({ name: z.string().trim().min(1).max(80) })
  .strict();
const idSchema = z.string().uuid();
export function keyManagementRoutes(
  keys: ApiKeyStore,
  userId: string,
  apiBaseUrl: string,
) {
  const router = Router();
  router.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  router.get(
    "/",
    asyncRoute(async (req, res) => {
      const { after } = z
        .object({ after: idSchema.optional() })
        .strict()
        .parse(req.query);
      res.json({ ...(await keys.list(after)), userId, apiBaseUrl });
    }),
  );
  router.post(
    "/",
    asyncRoute(async (req, res) => {
      const { name } = nameSchema.parse(req.body);
      res.status(201).json(await keys.issue(name));
    }),
  );
  router.patch(
    "/:id",
    asyncRoute(async (req, res) => {
      const id = idSchema.parse(req.params.id),
        { name } = nameSchema.parse(req.body);
      if (!(await keys.rename(id, name))) throw notFound("API key not found.");
      res.json({ id, name });
    }),
  );
  router.delete(
    "/:id",
    asyncRoute(async (req, res) => {
      if (!(await keys.revoke(idSchema.parse(req.params.id))))
        throw notFound("API key not found.");
      res.status(204).end();
    }),
  );
  router.use(apiErrorHandler);
  return router;
}

import { Router } from "express";
import { asyncRoute, badRequest, notFound } from "../http/errors";
import { idParams } from "../schemas/common";
import { callListQuerySchema, createCallSchema, idempotencyKeySchema, updateCallSchema } from "../schemas/call";
import { ARTIFACT_ROUTES, type ArtifactRoute, type CallService } from "../services/calls";

const UNAVAILABLE_ARTIFACTS = ["video-recording", "pcap"] as const;

export const callRoutes = (service: CallService): Router => {
  const router = Router();

  router.post("/", asyncRoute(async (req, res) => {
    const key = idempotencyKeySchema.safeParse(req.get("idempotency-key"));
    if (!key.success) throw badRequest("Idempotency-Key: use 8-128 letters, digits or . _ : -");
    res.status(201).json(await service.create(createCallSchema.parse(req.body ?? {}), key.data));
  }));

  router.get("/", asyncRoute(async (req, res) => {
    res.json(await service.list(callListQuerySchema.parse(req.query)));
  }));

  for (const route of Object.keys(ARTIFACT_ROUTES) as ArtifactRoute[])
    router.get(`/:id/${route}`, asyncRoute(async (req, res) => {
      const { id } = idParams.parse(req.params);
      res.redirect(302, await service.artifactUrl(id, route));
    }));

  for (const route of UNAVAILABLE_ARTIFACTS)
    router.get(`/:id/${route}`, asyncRoute(async (req) => {
      const { id } = idParams.parse(req.params);
      await service.get(id);
      throw notFound("Artifact not found");
    }));

  router.get("/:id", asyncRoute(async (req, res) => {
    res.json(await service.get(idParams.parse(req.params).id));
  }));

  router.patch("/:id", asyncRoute(async (req, res) => {
    res.json(await service.update(idParams.parse(req.params).id, updateCallSchema.parse(req.body ?? {})));
  }));

  router.delete("/:id", asyncRoute(async (req, res) => {
    res.json(await service.remove(idParams.parse(req.params).id));
  }));

  return router;
};

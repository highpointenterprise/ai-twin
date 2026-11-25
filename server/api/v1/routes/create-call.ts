import { Router } from "express";
import { asyncRoute, badRequest, apiErrorHandler } from "../http/errors";
import { requestContext, requireJson, jsonBody } from "../http/middleware";
import { simpleCallSchema } from "../schemas/create-call";
import { idempotencyKeySchema } from "../schemas/call";
import type { CallService } from "../services/calls";
export function simpleCallRoutes(service: CallService): Router {
  const router = Router();
  router.use(requestContext, requireJson, jsonBody);
  router.post("/", asyncRoute(async (req, res) => {
    const key = idempotencyKeySchema.safeParse(req.get("idempotency-key"));
    if (!key.success) throw badRequest("Invalid Idempotency-Key.");
    const call = await service.createSimple(simpleCallSchema.parse(req.body), key.data);
    res.status(201).json({ success: true, callId: call.id, call });
  }));
  router.use(apiErrorHandler);
  return router;
}

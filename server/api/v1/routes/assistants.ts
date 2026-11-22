import { Router } from "express";
import type { AssistantApiRepository } from "../repositories/resources";
import { asyncRoute, notFound } from "../http/errors";
import { editableAssistant, mergeAssistant, toAgentInput, toApiAssistant } from "../mappers/assistant";
import { assistantBodySchema, assistantListQuerySchema } from "../schemas/assistant";
import { idParams } from "../schemas/common";

export const assistantRoutes = (assistants: AssistantApiRepository): Router => {
  const router = Router();

  router.post("/", asyncRoute(async (req, res) => {
    const body = assistantBodySchema.parse(req.body ?? {});
    const created = await assistants.create(toAgentInput(body), body.metadata);
    res.status(201).json(toApiAssistant(created));
  }));

  router.get("/", asyncRoute(async (req, res) => {
    const { limit, ...range } = assistantListQuerySchema.parse(req.query);
    res.json((await assistants.list(range, limit)).map(toApiAssistant));
  }));

  router.get("/:id", asyncRoute(async (req, res) => {
    const { id } = idParams.parse(req.params);
    const document = await assistants.get(id);
    if (!document) throw notFound("Assistant not found");
    res.json(toApiAssistant(document));
  }));

  router.patch("/:id", asyncRoute(async (req, res) => {
    const { id } = idParams.parse(req.params);
    const current = await assistants.get(id);
    if (!current) throw notFound("Assistant not found");
    const merged = mergeAssistant(editableAssistant(current), req.body ?? {});
    const updated = await assistants.update(id, toAgentInput(merged), merged.metadata);
    if (!updated) throw notFound("Assistant not found");
    res.json(toApiAssistant(updated));
  }));

  router.delete("/:id", asyncRoute(async (req, res) => {
    const { id } = idParams.parse(req.params);
    const removed = await assistants.delete(id);
    if (!removed) throw notFound("Assistant not found");
    res.json(toApiAssistant(removed));
  }));

  return router;
};

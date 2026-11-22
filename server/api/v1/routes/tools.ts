import { Router } from "express";
import type { MongoToolRegistry } from "../../../storage/config";
import type { AssistantApiRepository, ToolApiRepository } from "../repositories/resources";
import { asyncRoute, conflict } from "../http/errors";
import { mergeTool, toToolInput, toApiTool, type ToolDocument } from "../mappers/tool";
import { idParams } from "../schemas/common";
import { toolBodySchema, toolListQuerySchema } from "../schemas/tool";

export interface ToolRouteDependencies {
  registry: MongoToolRegistry;
  listing: ToolApiRepository;
  assistants: AssistantApiRepository;
  orgId: string;
}

export const toolRoutes = ({ registry, listing, assistants, orgId }: ToolRouteDependencies): Router => {
  const router = Router();

  router.post("/", asyncRoute(async (req, res) => {
    const saved = await registry.save(toToolInput(toolBodySchema.parse(req.body ?? {})));
    res.status(201).json(toApiTool(saved as ToolDocument, orgId));
  }));

  router.get("/", asyncRoute(async (req, res) => {
    const { limit, ...range } = toolListQuerySchema.parse(req.query);
    res.json((await listing.list(range, limit)).map((tool) => toApiTool(tool, orgId)));
  }));

  router.get("/:id", asyncRoute(async (req, res) => {
    const { id } = idParams.parse(req.params);
    res.json(toApiTool((await registry.get(id)) as ToolDocument, orgId));
  }));

  router.patch("/:id", asyncRoute(async (req, res) => {
    const { id } = idParams.parse(req.params);
    const merged = mergeTool(await registry.get(id), req.body ?? {});
    const saved = await registry.save(toToolInput(merged), id);
    res.json(toApiTool(saved as ToolDocument, orgId));
  }));

  router.delete("/:id", asyncRoute(async (req, res) => {
    const { id } = idParams.parse(req.params);
    const current = (await registry.get(id)) as ToolDocument;
    if (await assistants.usesTool(id)) throw conflict("Tool is attached to an assistant. Detach it first.");
    await registry.delete(id);
    res.json(toApiTool(current, orgId));
  }));

  return router;
};

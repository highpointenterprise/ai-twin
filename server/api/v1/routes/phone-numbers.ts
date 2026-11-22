import { Router } from "express";
import type { PhoneNumberApiRepository } from "../repositories/resources";
import { asyncRoute, notFound } from "../http/errors";
import { toVapiPhoneNumber } from "../mappers/phone-number";
import { idParams } from "../schemas/common";
import {
  phoneNumberCreateSchema,
  phoneNumberListQuerySchema,
  phoneNumberPageQuerySchema,
  phoneNumberUpdateSchema,
} from "../schemas/phone-number";
import type { PhoneNumberService } from "../services/phone-numbers";

export interface PhoneNumberRouteDependencies {
  numbers: PhoneNumberApiRepository;
  service: PhoneNumberService;
  accountSid: () => string | undefined;
}

export const phoneNumberRoutes = ({ numbers, service, accountSid }: PhoneNumberRouteDependencies): { v1: Router; v2: Router } => {
  const view = (document: Parameters<typeof toVapiPhoneNumber>[0]) => toVapiPhoneNumber(document, accountSid());
  const v1 = Router();
  const v2 = Router();

  v1.post("/", asyncRoute(async (req, res) => {
    res.status(201).json(view(await service.create(phoneNumberCreateSchema.parse(req.body ?? {}))));
  }));

  v1.get("/", asyncRoute(async (req, res) => {
    const { limit, ...range } = phoneNumberListQuerySchema.parse(req.query);
    res.json((await numbers.list(range, limit)).map(view));
  }));

  v1.get("/:id", asyncRoute(async (req, res) => {
    const { id } = idParams.parse(req.params);
    const document = await numbers.get(id);
    if (!document) throw notFound("Phone number not found");
    res.json(view(document));
  }));

  v1.patch("/:id", asyncRoute(async (req, res) => {
    const { id } = idParams.parse(req.params);
    res.json(view(await service.update(id, phoneNumberUpdateSchema.parse(req.body ?? {}))));
  }));

  v1.delete("/:id", asyncRoute(async (req, res) => {
    const { id } = idParams.parse(req.params);
    const removed = await numbers.delete(id);
    if (!removed) throw notFound("Phone number not found");
    res.json(view(removed));
  }));

  v2.get("/", asyncRoute(async (req, res) => {
    const query = phoneNumberPageQuerySchema.parse(req.query);
    const page = await numbers.page(query);
    const totalPages = Math.max(1, Math.ceil(page.totalItems / query.limit));
    res.json({
      results: page.results.map(view),
      metadata: {
        itemsPerPage: query.limit,
        totalItems: page.totalItems,
        currentPage: query.page,
        totalPages,
        hasNextPage: page.nextCursor !== undefined,
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        sortOrder: query.sortOrder,
      },
    });
  }));

  return { v1, v2 };
};

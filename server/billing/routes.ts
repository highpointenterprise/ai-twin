import { Router, type Request, type Response } from "express";
import type { Db } from "mongodb";
import { z } from "zod";
import { HttpError } from "../core/errors";
import { pricingSources, type PricingPolicies } from "./policy";

const querySchema = z
  .object({
    from: z.string().datetime(),
    to: z.string().datetime(),
    groupBy: z.enum(["day", "month"]).default("day"),
    assistantId: z.string().uuid().optional(),
  })
  .strict()
  .refine(
    (q) =>
      Date.parse(q.from) < Date.parse(q.to) &&
      Date.parse(q.to) - Date.parse(q.from) <= 366 * 86400000,
    "Choose an increasing date range of at most 366 days.",
  );
export function billingRoutes(
  db: Db,
  userId: string,
  pricing: PricingPolicies,
) {
  const router = Router();
  const handle =
    (
      fn: (req: Request, res: Response) => Promise<unknown>,
    ): import("express").RequestHandler =>
    (req, res, next) => {
      Promise.resolve(fn(req, res)).catch(next);
    };
  router.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  router.get(
    "/pricing",
    handle(async (_req, res) =>
      res.json({ ...(await pricing.current()), sources: pricingSources }),
    ),
  );
  router.put(
    "/pricing",
    handle(async (req, res) =>
      res.json({
        ...(await pricing.update(req.body)),
        sources: pricingSources,
      }),
    ),
  );
  router.get(
    "/summary",
    handle(async (req, res) => {
      const q = querySchema.parse(req.query);
      const match = {
        userId,
        occurredAt: { $gte: new Date(q.from), $lt: new Date(q.to) },
        ...(q.assistantId ? { assistantId: q.assistantId } : {}),
      };
      const groups = await db
        .collection("call_costs")
        .aggregate(
          [
            { $match: match },
            {
              $group: {
                _id: {
                  $dateToString: {
                    date: "$occurredAt",
                    format: q.groupBy === "day" ? "%Y-%m-%d" : "%Y-%m",
                    timezone: "UTC",
                  },
                },
                calls: { $sum: 1 },
                minutes: { $sum: { $divide: ["$cost.durationSec", 60] } },
                reportedUsd: { $sum: { $ifNull: ["$cost.reportedUsd", 0] } },
                calculatedUsd: {
                  $sum: { $ifNull: ["$cost.calculatedUsd", 0] },
                },
                estimatedUsd: { $sum: { $ifNull: ["$cost.estimatedUsd", 0] } },
                knownSubtotalUsd: { $sum: "$cost.totalUsd" },
                incompleteCalls: {
                  $sum: {
                    $cond: [{ $eq: ["$cost.status", "incomplete"] }, 1, 0],
                  },
                },
                pendingCalls: {
                  $sum: {
                    $cond: [
                      { $eq: ["$cost.reconciliationStatus", "pending"] },
                      1,
                      0,
                    ],
                  },
                },
              },
            },
            { $sort: { _id: 1 } },
          ],
          { maxTimeMS: 10_000 },
        )
        .toArray();
      res.json({
        currency: "USD",
        timezone: "UTC",
        from: q.from,
        to: q.to,
        groups,
        note: "Each call leg is counted once. Unknown charges are excluded from the known subtotal. Recurring number rental, taxes, and account-level charges need separate allocation.",
      });
    }),
  );
  router.get(
    "/calls/:id",
    handle(async (req, res) => {
      const id = z
        .string()
        .regex(/^[A-Za-z0-9_-]{1,100}$/)
        .parse(req.params.id);
      const record = await db
        .collection("call_costs")
        .findOne({ userId, callId: id }, { projection: { _id: 0 } });
      if (!record) throw new HttpError(404, "Call cost not found.");
      const limit = z.coerce
        .number()
        .int()
        .min(1)
        .max(100)
        .default(20)
        .parse(req.query.limit);
      const history = await db
        .collection("call_cost_history")
        .find({ userId, callId: id }, { projection: { _id: 0 } })
        .sort({ recordedAt: -1 })
        .limit(limit)
        .toArray();
      res.json({ ...record, history });
    }),
  );
  return router;
}

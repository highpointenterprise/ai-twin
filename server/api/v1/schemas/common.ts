import { z } from "zod";

export const resourceId = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9_-]+$/, "id must contain only letters, digits, hyphen or underscore");

export const idParams = z.object({ id: resourceId }).strict();

const timestamp = z
  .string()
  .datetime({ offset: true })
  .transform((value) => new Date(value));

export const timeRangeShape = {
  createdAtGt: timestamp.optional(),
  createdAtLt: timestamp.optional(),
  createdAtGe: timestamp.optional(),
  createdAtLe: timestamp.optional(),
  updatedAtGt: timestamp.optional(),
  updatedAtLt: timestamp.optional(),
  updatedAtGe: timestamp.optional(),
  updatedAtLe: timestamp.optional(),
};

export const limitShape = {
  limit: z.coerce.number().int().min(0).max(1000).default(100),
};

export const listQuerySchema = z.object({ ...limitShape, ...timeRangeShape }).strict();

export type TimeRange = {
  [K in keyof typeof timeRangeShape]?: Date;
};

type Comparison = { $gt?: string | number; $lt?: string | number; $gte?: string | number; $lte?: string | number };
export type RangeEncoding = "iso" | "epoch";

const encode = (date: Date, encoding: RangeEncoding): string | number =>
  encoding === "iso" ? date.toISOString() : date.getTime();

const comparison = (
  gt: Date | undefined,
  lt: Date | undefined,
  ge: Date | undefined,
  le: Date | undefined,
  encoding: RangeEncoding,
): Comparison | undefined => {
  const result: Comparison = {};
  if (gt) result.$gt = encode(gt, encoding);
  if (lt) result.$lt = encode(lt, encoding);
  if (ge) result.$gte = encode(ge, encoding);
  if (le) result.$lte = encode(le, encoding);
  return Object.keys(result).length ? result : undefined;
};

export const timeFilters = (
  range: TimeRange,
  encodings: { createdAt: RangeEncoding; updatedAt: RangeEncoding } = { createdAt: "iso", updatedAt: "iso" },
): Record<string, Comparison> => {
  const created = comparison(range.createdAtGt, range.createdAtLt, range.createdAtGe, range.createdAtLe, encodings.createdAt);
  const updated = comparison(range.updatedAtGt, range.updatedAtLt, range.updatedAtGe, range.updatedAtLe, encodings.updatedAt);
  return { ...(created ? { createdAt: created } : {}), ...(updated ? { updatedAt: updated } : {}) };
};

export const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export const deepMerge = (base: unknown, patch: unknown): unknown => {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch === undefined ? base : patch;
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (FORBIDDEN_KEYS.has(key)) continue;
    if (value === null) delete merged[key];
    else merged[key] = deepMerge(base[key], value);
  }
  return merged;
};

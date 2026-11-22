import type { ErrorRequestHandler, Request, RequestHandler, Response } from "express";
import { ZodError, type ZodIssue } from "zod";
import { HttpError } from "../../../core/errors";
import { errorDetail } from "../../../observability/diagnostics";
import { logEvent } from "../../../observability/trace";

const REASON_PHRASES: Readonly<Record<number, string>> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  409: "Conflict",
  413: "Payload Too Large",
  415: "Unsupported Media Type",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
};

export interface ApiErrorBody {
  message: string | string[];
  error: string;
  statusCode: number;
}

export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly detail: string | string[],
    readonly headers: Readonly<Record<string, string>> = {},
  ) {
    super(Array.isArray(detail) ? detail.join("; ") : detail);
  }
  body(): ApiErrorBody {
    return {
      message: this.detail,
      error: REASON_PHRASES[this.statusCode] ?? "Error",
      statusCode: this.statusCode,
    };
  }
}

export const badRequest = (detail: string | string[]): ApiError => new ApiError(400, detail);
export const notFound = (detail: string): ApiError => new ApiError(404, detail);
export const conflict = (detail: string): ApiError => new ApiError(409, detail);

const describeIssue = (issue: ZodIssue): string[] => {
  const path = issue.path.join(".");
  if (issue.code === "unrecognized_keys")
    return issue.keys.map((key) => `property ${path ? `${path}.` : ""}${key} should not exist`);
  return [path ? `${path}: ${issue.message}` : issue.message];
};

export const toApiError = (error: unknown): ApiError => {
  if (error instanceof ApiError) return error;
  if (error instanceof ZodError) return badRequest(error.issues.flatMap(describeIssue));
  if (error instanceof HttpError) return new ApiError(error.status, error.message);
  if ((error as { type?: string })?.type === "entity.too.large")
    return new ApiError(413, "Request body is too large.");
  if ((error as { type?: string })?.type === "entity.parse.failed")
    return badRequest("Request body must be valid JSON.");
  return new ApiError(500, "Internal server error");
};

export const apiErrorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  const apiError = toApiError(error);
  if (apiError.statusCode >= 500)
    logEvent("api.request_failed", {
      method: req.method,
      path: req.path,
      requestId: String(res.getHeader("x-request-id") ?? ""),
      ...errorDetail(error),
    });
  for (const [name, value] of Object.entries(apiError.headers)) res.setHeader(name, value);
  res.status(apiError.statusCode).json(apiError.body());
};

export const asyncRoute =
  (action: (req: Request, res: Response) => unknown): RequestHandler =>
  (req, res, next) => {
    Promise.resolve()
      .then(() => action(req, res))
      .catch(next);
  };

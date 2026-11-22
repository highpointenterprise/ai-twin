import { randomUUID } from "node:crypto";
import express, { type RequestHandler } from "express";
import { httpDuration, httpRequests } from "../../../observability/metrics";
import { logEvent } from "../../../observability/trace";
import { ApiError } from "./errors";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{8,64}$/;

export const requestContext: RequestHandler = (req, res, next) => {
  const supplied = req.get("x-request-id");
  const requestId = supplied && REQUEST_ID_PATTERN.test(supplied) ? supplied : randomUUID();
  const began = process.hrtime.bigint();
  res.setHeader("x-request-id", requestId);
  res.setHeader("cache-control", "no-store");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("strict-transport-security", "max-age=63072000; includeSubDomains");
  res.on("finish", () => {
    const seconds = Number(process.hrtime.bigint() - began) / 1e9;
    const route = `${req.baseUrl}${req.route?.path ?? ""}` || "unmatched";
    httpRequests.inc({ method: req.method, route, status: `${Math.floor(res.statusCode / 100)}xx` });
    httpDuration.observe(seconds, { method: req.method, route });
    if (res.statusCode >= 400)
      logEvent("api.request_rejected", {
        requestId,
        method: req.method,
        route,
        status: res.statusCode,
        ms: Math.round(seconds * 1000),
      });
  });
  next();
};

export const jsonBody = express.json({ limit: "1mb", strict: true, type: "application/json" });

export const requireJson: RequestHandler = (req, _res, next) => {
  if (["POST", "PATCH", "PUT"].includes(req.method) && req.is("application/json") === false)
    return next(new ApiError(415, "Content-Type must be application/json."));
  next();
};

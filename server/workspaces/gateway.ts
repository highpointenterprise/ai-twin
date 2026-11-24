import express from "express";
import { env } from "../../lib/env";
import type { MailQueue } from "../auth/mail";
import type { ApiKeyDirectory } from "../api/v1/auth/key-directory";
import { bearerToken } from "../api/v1/auth/api-keys";
import { ApiError, apiErrorHandler, asyncRoute } from "../api/v1/http/errors";
import { requestContext } from "../api/v1/http/middleware";
import { request as httpRequest } from "node:http";
import type { IncomingMessage, ServerResponse, Server } from "node:http";
import { connect } from "node:net";
import type { AuthStore } from "../auth/store";
import { createAuthRouter, requireUser } from "../auth/routes";
import type { WorkspacePorts } from "./pool";

export interface WorkspaceResolver { get(userId: string, create: boolean): Promise<WorkspacePorts> }

function proxy(req: IncomingMessage, res: ServerResponse, port: number, path: string, api = false) {
  const upstream = httpRequest({ hostname: "127.0.0.1", port, path, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${port}` } }, (response) => {
    res.writeHead(response.statusCode || 502, { ...response.headers, "cache-control": "no-store" });
    response.pipe(res);
  });
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify(api ? { statusCode: 503, error: "Service Unavailable", message: "Workspace is temporarily unavailable." } : { error: "Workspace is temporarily unavailable." }));
  });
  req.on("aborted", () => upstream.destroy());
  req.pipe(upstream);
}

export function createWorkspaceGateway(auth: AuthStore, secret: string, pool: WorkspaceResolver, directory?: ApiKeyDirectory, mail?: MailQueue) {
  const admin = express();
  admin.set("trust proxy", env.TRUST_PROXY_HOPS);
  admin.disable("x-powered-by");
  admin.get("/health", (_req, res) => res.json({ status: "ok" }));
  admin.use("/api/v1/auth", createAuthRouter(auth, secret, mail));
  admin.use(requireUser(auth));
  admin.use(async (req, res) => {
    try {
      const ports = await pool.get(res.locals.user.id, true);
      proxy(req, res, ports.admin, req.originalUrl);
    } catch {
      res.status(503).json({ error: "Workspace is temporarily unavailable. Please retry." });
    }
  });
  const publicApp = express();
  publicApp.set("trust proxy", env.TRUST_PROXY_HOPS);
  publicApp.disable("x-powered-by");
  publicApp.get("/health", (_req, res) => res.json({ status: "ok" }));
  const apiPaths = ["/call", "/assistant", "/phone-number", "/v2/phone-number", "/tool"];
  publicApp.use(apiPaths, requestContext, asyncRoute(async (req, res) => {
    const token = bearerToken(req.get("authorization"));
    const owner = token ? await directory?.owner(token) : undefined;
    if (!owner) {
      const budget = await auth.allowAttempt(`api-auth:${req.ip}`, 30, 60_000);
      if (!budget.allowed) throw new ApiError(429, "Too many failed authentication attempts.", { "retry-after": String(budget.retryAfter) });
      throw new ApiError(401, "Invalid or missing API key.", { "www-authenticate": "Bearer" });
    }
    let ports: WorkspacePorts;
    try { ports = await pool.get(owner, false); }
    catch { throw new ApiError(503, "Workspace is temporarily unavailable. Please retry."); }
    proxy(req, res, ports.public, req.originalUrl, true);
  }));
  publicApp.use(apiPaths, apiErrorHandler);
  publicApp.use("/workspaces/:userId", async (req, res) => {
    try {
      const ports = await pool.get(req.params.userId, false);
      proxy(req, res, ports.public, req.url);
    } catch { res.status(404).json({ error: "Not found." }); }
  });
  publicApp.use((_req, res) => res.status(404).json({ error: "Not found." }));
  return { admin, publicApp };
}

export function attachWorkspaceMedia(server: Server, pool: WorkspaceResolver) {
  server.on("upgrade", async (req, socket, head) => {
    const match = /^\/workspaces\/([a-f0-9-]{36})(\/media(?:\?.*)?)$/i.exec(req.url || "");
    if (!match) { socket.destroy(); return; }
    try {
      const ports = await pool.get(match[1], false);
      if (socket.destroyed) return;
      const upstream = connect(ports.public, "127.0.0.1", () => {
        const headers = Object.entries({ ...req.headers, host: `127.0.0.1:${ports.public}` })
          .flatMap(([key, value]) => value === undefined ? [] : [`${key}: ${Array.isArray(value) ? value.join(", ") : value}`]);
        upstream.write(`${req.method} ${match[2]} HTTP/1.1\r\n${headers.join("\r\n")}\r\n\r\n`);
        if (head.length) upstream.write(head);
        socket.pipe(upstream).pipe(socket);
      });
      upstream.on("error", () => socket.destroy());
      socket.on("error", () => upstream.destroy());
      socket.on("close", () => upstream.destroy());
    } catch { socket.destroy(); }
  });
}

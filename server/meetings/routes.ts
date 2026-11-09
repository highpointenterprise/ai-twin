import {
  Router,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import type { MeetingService } from "./service";
export function meetingRoutes(service: MeetingService): Router {
  const router = Router();
  const handle =
    (fn: (req: Request, res: Response) => unknown) =>
    (req: Request, res: Response, next: NextFunction) => {
      Promise.resolve()
        .then(() => fn(req, res))
        .catch(next);
    };
  router.get("/api/meetings/config", (_req, res) =>
    res.set("Cache-Control", "no-store").json(service.readiness()),
  );
  router.get("/api/meetings", (_req, res) => res.json(service.list()));
  router.post(
    "/api/meetings",
    handle((req, res) => res.status(202).json(service.join(req.body))),
  );
  router.get(
    "/api/meetings/:id",
    handle((req, res) => res.json(service.get(req.params.id))),
  );
  router.get(
    "/api/meetings/:id/trace",
    handle((req, res) => res.json(service.trace(req.params.id))),
  );
  router.post(
    "/api/meetings/:id/end",
    handle(async (req, res) => {
      await service.stop(req.params.id);
      return res.json(service.get(req.params.id));
    }),
  );
  return router;
}

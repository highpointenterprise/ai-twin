import { Router, type RequestHandler } from "express";
import twilio from "twilio";
import { z } from "zod";
import { env } from "../../lib/env";
import { signStreamToken } from "../../lib/token";
import type { ContextStore } from "../store/contexts";
import { HttpError } from "../core/errors";
import type { WarmTransferCoordinator } from "./coordinator";
import { conferenceTwiml, holdTwiml, holdWav, transferUrl } from "./twiml";
const callSchema = z.object({
  CallSid: z.string().min(1),
  To: z.string().default(""),
});
export function warmTransferRoutes(
  service: WarmTransferCoordinator,
  contexts: ContextStore,
  verified: RequestHandler,
): Router {
  const router = Router();
  const audio = holdWav();
  router.get("/twilio/warm-hold.wav", (_req, res) =>
    res
      .type("audio/wav")
      .set("Cache-Control", "public, max-age=86400")
      .send(audio),
  );
  router.post("/twilio/warm/:id/:action", verified, (req, res, next) => {
    try {
      const r = service.get(req.params.id),
        action = req.params.action;
      res.type("text/xml");
      const stream = (contextId: string, extension = "") => {
        const context = contexts.get(contextId);
        if (!context) return "<Response><Hangup/></Response>";
        const response = new twilio.twiml.VoiceResponse();
        if (extension) response.play({ digits: extension });
        const media = response
          .connect()
          .stream({
            url: `${env.PUBLIC_BASE_URL.replace(/^https/, "wss")}/media`,
          });
        for (const [name, value] of Object.entries({
          agentId: context.agent.id,
          callId: contextId,
          token: signStreamToken(context.agent.id, contextId),
        }))
          media.parameter({ name, value });
        return response.toString();
      };
      const resumeOrWait = () => {
        if (
          r.phase === "returning" &&
          r.resumeContextId &&
          contexts.get(r.resumeContextId)
        )
          return stream(r.resumeContextId);
        if (["returning", "recovery-failed"].includes(r.phase)) {
          // A Dial action or delayed hold request can arrive before the REST
          // recovery finishes. Keep the caller alive while that work settles.
          const response = new twilio.twiml.VoiceResponse();
          response.play(
            {},
            r.plan.holdAudioUrl ??
              `${env.PUBLIC_BASE_URL}/twilio/warm-hold.wav`,
          );
          response.redirect({ method: "POST" }, transferUrl(r.id, "resume"));
          return response.toString();
        }
        return "<Response><Hangup/></Response>";
      };
      if (action === "conference") {
        const b = z
          .object({
            StatusCallbackEvent: z.string(),
            ConferenceSid: z.string(),
            CallSid: z.string().default(""),
          })
          .parse(req.body);
        service.conferenceEvent(
          r.id,
          b.StatusCallbackEvent,
          b.CallSid,
          b.ConferenceSid,
        );
        res.status(204).end();
        return;
      }
      const b = callSchema.parse(req.body);
      if (action === "operator-status") {
        const status = z.string().parse(req.body.CallStatus);
        service.operatorStatus(r.id, b.CallSid, b.To, status);
        res.status(204).end();
        return;
      }
      if (action === "operator") {
        const id = service.operatorAnswered(r.id, b.CallSid, b.To);
        res.send(
          id
            ? stream(id, r.destination.extension)
            : "<Response><Hangup/></Response>",
        );
        return;
      }
      if (action === "bridge" || action === "operator-exit") {
        if (b.CallSid !== r.operatorSid)
          throw new HttpError(403, "Recipient call mismatch.");
        if (
          action === "bridge" &&
          ["connecting", "connected"].includes(r.phase)
        )
          res.send(conferenceTwiml(r, "operator"));
        else {
          service.operatorStatus(
            r.id,
            b.CallSid,
            r.destination.number,
            "completed",
          );
          res.send("<Response><Hangup/></Response>");
        }
        return;
      }
      if (b.CallSid !== r.callerSid)
        throw new HttpError(403, "Caller mismatch.");
      if (action === "hold") {
        if (
          [
            "preparing",
            "dialing",
            "consulting",
            "connecting",
            "connected",
          ].includes(r.phase)
        )
          res.send(conferenceTwiml(r, "caller"));
        else res.send(resumeOrWait());
      } else if (action === "wait") res.send(holdTwiml(r));
      else if (action === "resume") {
        res.send(resumeOrWait());
      } else if (action === "caller-exit") {
        if (["connected", "completed", "cancelled"].includes(r.phase))
          res.send("<Response><Hangup/></Response>");
        else {
          if (!["returning", "returned", "recovery-failed"].includes(r.phase))
            void service.rollback(r.id, "conference-ended-before-bridge");
          res.send(resumeOrWait());
        }
      } else throw new HttpError(404, "Unknown warm transfer callback.");
    } catch (e) {
      next(e);
    }
  });
  return router;
}

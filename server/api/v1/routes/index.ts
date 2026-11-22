import { Router } from "express";
import { authenticate, type ApiKeyStore } from "../auth/api-keys";
import { apiErrorHandler } from "../http/errors";
import { jsonBody, requestContext, requireJson } from "../http/middleware";
import type { RedisCallState } from "../../../storage/redis";
import { assistantRoutes } from "./assistants";
import { callRoutes } from "./calls";
import { phoneNumberRoutes, type PhoneNumberRouteDependencies } from "./phone-numbers";
import { toolRoutes, type ToolRouteDependencies } from "./tools";
import type { AssistantApiRepository } from "../repositories/resources";
import type { CallService } from "../services/calls";

export interface ApiRouterDependencies {
  keys: ApiKeyStore;
  callState: RedisCallState;
  assistants: AssistantApiRepository;
  calls: CallService;
  tools: ToolRouteDependencies;
  phoneNumbers: PhoneNumberRouteDependencies;
}

export const createApiRouter = (deps: ApiRouterDependencies): Router => {
  const router = Router();
  const prefixes = ["/assistant", "/call", "/phone-number", "/v2/phone-number", "/tool"];
  const phone = phoneNumberRoutes(deps.phoneNumbers);
  router.use(prefixes, requestContext, authenticate(deps.keys, deps.callState), requireJson, jsonBody);
  router.use("/assistant", assistantRoutes(deps.assistants));
  router.use("/call", callRoutes(deps.calls));
  router.use("/phone-number", phone.v1);
  router.use("/v2/phone-number", phone.v2);
  router.use("/tool", toolRoutes(deps.tools));
  router.use(prefixes, apiErrorHandler);
  return router;
};

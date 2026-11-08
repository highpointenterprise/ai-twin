import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "./env";

const sign = (agentId: string, callId: string): string =>
  createHmac("sha256", signingSecret())
    .update(`${agentId}.${callId}`)
    .digest("hex");
const signingSecret = (): string => {
  if (env.STREAM_SECRET.length < 32)
    throw new Error("STREAM_SECRET must contain at least 32 characters.");
  return env.STREAM_SECRET;
};

export const signStreamToken = sign;

export const verifyStreamToken = (
  agentId: string,
  callId: string,
  token: string,
): boolean => {
  const expected = Buffer.from(sign(agentId, callId));
  const actual = Buffer.from(token);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
};

import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "./env";

const sign = (agentId: string, callId: string): string =>
  createHmac("sha256", env.STREAM_SECRET).update(`${agentId}.${callId}`).digest("hex");

export const signStreamToken = sign;

export const verifyStreamToken = (agentId: string, callId: string, token: string): boolean => {
  const expected = Buffer.from(sign(agentId, callId));
  const actual = Buffer.from(token);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
};

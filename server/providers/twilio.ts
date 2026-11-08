import twilio from "twilio";
import { env } from "../../lib/env";
import type { Telephony } from "../core/ports";
export const escapeXml = (v: string): string =>
  v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
export const createTwilioTelephony = (): Telephony => {
  const client = () =>
    twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN, {
      autoRetry: false,
      timeout: 15000,
    });
  return {
    listNumbers: async () =>
      (await client().incomingPhoneNumbers.list({ limit: 100 })).map((n) => ({
        sid: n.sid,
        phoneNumber: n.phoneNumber,
        label: n.friendlyName,
      })),
    routeInbound: async (sid, url, statusUrl) => {
      await client()
        .incomingPhoneNumbers(sid)
        .update({
          voiceUrl: url,
          voiceMethod: "POST",
          statusCallback: statusUrl,
          statusCallbackMethod: "POST",
        });
    },
    placeCall: async ({ to, from, url, statusUrl, voicemail }) => {
      const c = await client().calls.create({
        to,
        from,
        url,
        method: "POST",
        statusCallback: statusUrl,
        statusCallbackMethod: "POST",
        statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
        ...(voicemail.enabled
          ? {
              machineDetection:
                voicemail.action === "leave-message"
                  ? "DetectMessageEnd"
                  : "Enable",
              machineDetectionTimeout: voicemail.detectionTimeoutSeconds,
              asyncAmd: "false",
            }
          : {}),
      });
      return c.sid;
    },
    transferCall: async (sid, d, timeout, statusUrl) => {
      const response = new twilio.twiml.VoiceResponse();
      response
        .dial({ timeout, action: statusUrl, method: "POST" })
        .number(
          { ...(d.extension ? { sendDigits: d.extension } : {}) },
          d.number,
        );
      await client().calls(sid).update({ twiml: response.toString() });
    },
    endCall: async (sid) => {
      await client().calls(sid).update({ status: "completed" });
    },
    validateWebhook: (url, params, signature) =>
      !!env.TWILIO_AUTH_TOKEN &&
      twilio.validateRequest(env.TWILIO_AUTH_TOKEN, signature, url, params),
    streamTwiml: (url, params) =>
      `<Response><Connect><Stream url="${escapeXml(url)}">${Object.entries(
        params,
      )
        .map(
          ([name, value]) =>
            `<Parameter name="${escapeXml(name)}" value="${escapeXml(value)}"/>`,
        )
        .join("")}</Stream></Connect></Response>`,
    rejectTwiml: (message) =>
      `<Response><Say>${escapeXml(message)}</Say><Hangup/></Response>`,
  };
};

import twilio from "twilio";
import { env } from "../../lib/env";
import type { Telephony } from "../core/ports";

const escapeXml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const createTwilioTelephony = (): Telephony => {
  const client = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);

  return {
    listNumbers: async () => {
      const numbers = await client.incomingPhoneNumbers.list({ limit: 100 });
      return numbers.map((number) => ({ sid: number.sid, phoneNumber: number.phoneNumber, label: number.friendlyName }));
    },
    routeInbound: async (numberSid, voiceUrl, statusUrl) => {
      await client.incomingPhoneNumbers(numberSid).update({
        voiceUrl,
        voiceMethod: "POST",
        statusCallback: statusUrl,
        statusCallbackMethod: "POST",
      });
    },
    placeCall: async ({ to, from, twiml, statusUrl }) => {
      const call = await client.calls.create({
        to,
        from,
        twiml,
        statusCallback: statusUrl,
        statusCallbackMethod: "POST",
        statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
      });
      return call.sid;
    },
    validateWebhook: (url, params, signature) => twilio.validateRequest(env.TWILIO_AUTH_TOKEN, signature, url, params),
    streamTwiml: (wsUrl, params) => {
      const parameters = Object.entries(params)
        .map(([name, value]) => `<Parameter name="${escapeXml(name)}" value="${escapeXml(value)}"/>`)
        .join("");
      return `<Response><Connect><Stream url="${escapeXml(wsUrl)}">${parameters}</Stream></Connect></Response>`;
    },
    rejectTwiml: (message) => `<Response><Say>${escapeXml(message)}</Say><Hangup/></Response>`,
  };
};

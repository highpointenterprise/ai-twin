import twilio from "twilio";
import type { TwilioCredentials } from "../../lib/twilio";
import type { Telephony } from "../core/ports";
import {
  environmentTwilioCredentials,
  twilioConnectionError,
} from "./twilio-settings";
import { errorDetail, writeDiagnostic } from "../observability/diagnostics";
async function operation<T>(
  name: string,
  sid: string,
  action: () => Promise<T>,
): Promise<T> {
  const began = Date.now();
  writeDiagnostic(sid || "system", `twilio.${name}.requested`);
  try {
    const result = await action();
    writeDiagnostic(sid || "system", `twilio.${name}.completed`, {
      ms: Date.now() - began,
    });
    return result;
  } catch (error) {
    writeDiagnostic(sid || "system", `twilio.${name}.failed`, {
      ...errorDetail(error),
      ms: Date.now() - began,
    });
    throw error;
  }
}
export const twilioClient = (credentials: TwilioCredentials): twilio.Twilio =>
  twilio(credentials.accountSid, credentials.authToken, {
    autoRetry: false,
    timeout: 15000,
    logLevel: "error",
  });
export const escapeXml = (v: string): string =>
  v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
export const createTwilioTelephony = (
  credentials = environmentTwilioCredentials,
  makeClient = twilioClient,
): Telephony => {
  const client = () => makeClient(credentials());
  return {
    listNumbers: async () => {
      try {
        return (
          await operation("numbers", "", () =>
            client().incomingPhoneNumbers.list({ pageSize: 1000 }),
          )
        ).map((n) => ({
          sid: n.sid,
          phoneNumber: n.phoneNumber,
          label: n.friendlyName,
        }));
      } catch (error) {
        throw twilioConnectionError(error);
      }
    },
    routeInbound: async (sid, url, statusUrl) => {
      await operation("route_inbound", sid, () =>
        client().incomingPhoneNumbers(sid).update({
          voiceUrl: url,
          voiceMethod: "POST",
          statusCallback: statusUrl,
          statusCallbackMethod: "POST",
        }),
      );
    },
    placeCall: async ({ to, from, url, statusUrl, voicemail }) => {
      const c = await operation("dial", "", () =>
        client().calls.create({
          to,
          from,
          url,
          method: "POST",
          statusCallback: statusUrl,
          statusCallbackMethod: "POST",
          statusCallbackEvent: [
            "initiated",
            "ringing",
            "answered",
            "completed",
          ],
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
        }),
      );
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
      await operation("transfer", sid, () =>
        client().calls(sid).update({ twiml: response.toString() }),
      );
    },
    endCall: async (sid) => {
      await operation("hangup", sid, () =>
        client().calls(sid).update({ status: "completed" }),
      );
    },
    validateWebhook: (url, params, signature) => {
      const { authToken } = credentials();
      return (
        !!authToken && twilio.validateRequest(authToken, signature, url, params)
      );
    },
    streamTwiml: (url, params, statusUrl) =>
      `<Response><Connect><Stream url="${escapeXml(url)}"${statusUrl ? ` statusCallback="${escapeXml(statusUrl)}" statusCallbackMethod="POST"` : ""}>${Object.entries(
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

export const createTwilioWarmTelephony = (
  credentials = environmentTwilioCredentials,
  makeClient = twilioClient,
): import("../transfers/types").WarmTransferTelephony => {
  const client = () => makeClient(credentials());
  return {
    redirectCall: async (sid, url) => {
      await client().calls(sid).update({ url, method: "POST" });
    },
    dialOperator: async ({ to, from, url, statusUrl, timeoutSeconds }) => {
      const call = await client().calls.create({
        to,
        from,
        url,
        method: "POST",
        timeout: timeoutSeconds,
        statusCallback: statusUrl,
        statusCallbackMethod: "POST",
        statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
      });
      return call.sid;
    },
    endCall: async (sid) => {
      await client().calls(sid).update({ status: "completed" });
    },
    callStatus: async (sid) => (await client().calls(sid).fetch()).status,
    conferenceMembers: async (room) => {
      const conference = (
        await client().conferences.list({ friendlyName: room, limit: 10 })
      ).find((c) => c.status !== "completed");
      if (!conference) return undefined;
      const participants = await client()
        .conferences(conference.sid)
        .participants.list({ limit: 10 });
      return {
        sid: conference.sid,
        callSids: participants.map((p) => p.callSid),
      };
    },
  };
};

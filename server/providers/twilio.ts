import twilio from "twilio";
import type { TwilioCredentials } from "../../lib/twilio";
import type { Telephony, TelephonyNumber } from "../core/ports";
import {
  environmentTwilioCredentials,
  twilioConnectionError,
} from "./twilio-settings";
import { writeDiagnostic } from "../observability/diagnostics";
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
      code:
        typeof (error as { code?: unknown })?.code === "number"
          ? (error as { code: number }).code
          : "unknown",
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
export const numberView = (n: {
  sid: string;
  phoneNumber: string;
  friendlyName: string;
  capabilities?: { voice?: boolean; sms?: boolean; mms?: boolean };
  voiceUrl?: string;
  voiceMethod?: string;
  voiceApplicationSid?: string;
  trunkSid?: string;
  statusCallback?: string;
  statusCallbackMethod?: string;
  isoCountry?: string;
  addressSid?: string;
  bundleSid?: string;
}): TelephonyNumber => ({
  sid: n.sid,
  phoneNumber: n.phoneNumber,
  label: n.friendlyName,
  capabilities: {
    voice: !!n.capabilities?.voice,
    sms: !!n.capabilities?.sms,
    mms: !!n.capabilities?.mms,
  },
  voiceUrl: n.voiceUrl ?? "",
  voiceMethod: n.voiceMethod ?? "",
  voiceApplicationSid: n.voiceApplicationSid ?? "",
  trunkSid: n.trunkSid ?? "",
  statusCallback: n.statusCallback ?? "",
  statusCallbackMethod: n.statusCallbackMethod ?? "",
  country: n.isoCountry ?? "",
  addressSid: n.addressSid ?? "",
  bundleSid: n.bundleSid ?? "",
});
export const createTwilioTelephony = (
  credentials = environmentTwilioCredentials,
  makeClient = twilioClient,
): Telephony => {
  const client = () => makeClient(credentials());
  return {
    sendDigits: async (sid, keys, wsUrl, params, statusUrl) => {
      if (!/^[0-9A-D*#wW]{1,32}$/.test(keys) || !/[0-9A-D*#]/.test(keys))
        throw new Error("Invalid DTMF sequence.");
      const response = new twilio.twiml.VoiceResponse();
      response.play({ digits: `w${keys}` });
      const stream = response.connect().stream({ url: wsUrl, statusCallback: statusUrl, statusCallbackMethod: "POST" });
      for (const [name, value] of Object.entries(params)) stream.parameter({ name, value });
      await operation("dtmf", sid, () => client().calls(sid).update({ twiml: response.toString() }));
    },
    listNumbers: async () => {
      try {
        return (
          await operation("numbers", "", () =>
            client().incomingPhoneNumbers.list({ pageSize: 1000 }),
          )
        ).map(numberView);
      } catch (error) {
        throw twilioConnectionError(error);
      }
    },
    routeInbound: async (sid, url, statusUrl) => {
      try {
        await operation("route_inbound", sid, () =>
          client().incomingPhoneNumbers(sid).update({
            voiceApplicationSid: "",
            trunkSid: "",
            voiceFallbackUrl: "",
            voiceReceiveMode: "voice",
            voiceUrl: url,
            voiceMethod: "POST",
            statusCallback: statusUrl,
            statusCallbackMethod: "POST",
          }),
        );
      } catch (error) {
        throw twilioConnectionError(error);
      }
    },
    placeCall: async ({ to, from, url, statusUrl }) => {
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
    getCallUsage: async (sid) => {
      const call = await client().calls(sid).fetch();

      return {
        duration: call.duration ?? null,
        price: call.price ?? null,
        priceUnit: call.priceUnit ?? null,
      };
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

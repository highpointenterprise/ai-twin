import { createHash } from "node:crypto";
import type { Db } from "mongodb";
import twilio from "twilio";
import RequestClient from "twilio/lib/base/RequestClient";
import type { TwilioCredentials } from "../lib/twilio";
import { MongoAgentStore, MongoToolRegistry } from "../server/storage/config";
import { MongoTwilioCredentialStore } from "../server/storage/credentials";
import { TwilioSettings } from "../server/providers/twilio-settings";
import { createTwilioTelephony } from "../server/providers/twilio";
import { createTwilioNumberProvider } from "../server/providers/twilio-numbers";
import { NumberRepository } from "../server/phone-numbers/repository";
import { PhoneNumbers } from "../server/phone-numbers/service";
import type { HttpDeps } from "../server/http/routes";
import { CallRegistry } from "../server/store/calls";
import { ContextStore } from "../server/store/contexts";
import { TraceStore } from "../server/observability/trace";
import { SessionPool } from "../server/engine/pool";
import { agent } from "./helpers";

export const phoneCredentials = {
  accountSid: "AC" + "1".repeat(32),
  authToken: "2".repeat(32),
};
export const existingPhone = {
  sid: "PN" + "3".repeat(32),
  phone_number: "+14155550100",
  friendly_name: "Support",
};
export const buyPhone = "+14155550101";
export const purchaseBody = {
  country: "US",
  type: "local",
  contains: "",
  phoneNumber: buyPhone,
  monthlyPrice: "1.15",
  currency: "USD",
  confirmPurchase: true,
};
type RawNumber = typeof existingPhone & {
  capabilities: { voice: boolean; sms: boolean; mms: boolean };
  voice_url: string;
  voice_method: string;
  voice_application_sid: string;
  trunk_sid: string;
  status_callback: string;
  status_callback_method: string;
  voice_fallback_url: string;
};
export class FakeTwilio {
  credentials = phoneCredentials;
  numbers = new Map<string, RawNumber>();
  purchases = 0;
  updates: Record<string, unknown>[] = [];
  failPurchase: "before" | "after" | "validation" | null = null;
  ignoreRouting = false;
  price = "1.15";
  constructor() {
    this.numbers.set(existingPhone.sid, {
      ...existingPhone,
      capabilities: { voice: true, sms: true, mms: false },
      voice_url: "https://old.example/voice",
      voice_method: "GET",
      voice_application_sid: "AP" + "a".repeat(32),
      trunk_sid: "",
      status_callback: "",
      status_callback_method: "GET",
      voice_fallback_url: "https://old.example/fallback",
    });
  }
  client = (credentials: TwilioCredentials) => {
    const httpClient = new RequestClient();
    httpClient.request = (async (opts: RequestClient.RequestOptions) => {
      const response = (body: unknown, statusCode = 200) => ({
        body: JSON.stringify(body),
        statusCode,
        headers: {},
      });
      if (
        credentials.accountSid !== this.credentials.accountSid ||
        credentials.authToken !== this.credentials.authToken
      )
        return response(
          { code: 20003, message: `Bad credentials ${credentials.authToken}` },
          401,
        );
      const data = (opts.data ?? {}) as Record<string, string>;
      const path = new URL(opts.uri).pathname;
      if (path.includes("/PhoneNumbers/Countries/"))
        return response({
          country: "United States",
          iso_country: "US",
          price_unit: "usd",
          phone_number_prices: [
            { number_type: "local", current_price: this.price },
            { number_type: "toll free", current_price: "2.15" },
          ],
        });
      if (path.includes("/AvailablePhoneNumbers/"))
        return response({
          available_phone_numbers: [
            {
              phone_number: buyPhone,
              friendly_name: buyPhone,
              locality: "San Francisco",
              region: "CA",
              iso_country: "US",
              address_requirements: "none",
              capabilities: { voice: true, sms: true, mms: false },
            },
          ],
          next_page_uri: null,
        });
      if (path.endsWith("/IncomingPhoneNumbers.json")) {
        if (opts.method.toUpperCase() === "GET")
          return response({
            incoming_phone_numbers: [...this.numbers.values()],
            next_page_uri: null,
          });
        this.purchases++;
        if (this.failPurchase === "before") throw new Error("Connection reset");
        if (this.failPurchase === "validation")
          return response({ code: 21422, message: "Number unavailable" }, 400);
        const sid = "PN" + "4".repeat(32);
        const number: RawNumber = {
          ...this.numbers.values().next().value!,
          sid,
          phone_number: data.PhoneNumber,
          friendly_name: data.PhoneNumber,
          voice_url: data.VoiceUrl,
          voice_method: data.VoiceMethod,
          voice_application_sid: "",
          trunk_sid: "",
          voice_fallback_url: "",
          status_callback: data.StatusCallback,
          status_callback_method: data.StatusCallbackMethod,
        };
        this.numbers.set(sid, number);
        if (this.failPurchase === "after")
          throw new Error("Connection reset after purchase");
        return response(number, 201);
      }
      const sid = path.match(/\/IncomingPhoneNumbers\/(PN[^/]+)\.json$/)?.[1];
      const number = sid ? this.numbers.get(sid) : undefined;
      if (!number) return response({ code: 20404, message: "Not found" }, 404);
      if (opts.method.toUpperCase() === "POST") {
        this.updates.push(data);
        if (!this.ignoreRouting) {
          const fields = {
            VoiceUrl: "voice_url",
            VoiceMethod: "voice_method",
            VoiceApplicationSid: "voice_application_sid",
            TrunkSid: "trunk_sid",
            StatusCallback: "status_callback",
            StatusCallbackMethod: "status_callback_method",
            VoiceFallbackUrl: "voice_fallback_url",
            FriendlyName: "friendly_name",
          } as const;
          for (const [key, field] of Object.entries(fields))
            if (key in data) number[field] = data[key];
        }
      }
      return response(number);
    }) as RequestClient["request"];
    return twilio(credentials.accountSid, credentials.authToken, {
      httpClient,
      autoRetry: false,
    });
  };
}

export async function phoneFixture(
  db: Db,
  owner: string,
  base: string,
  fake = new FakeTwilio(),
) {
  const store = new MongoAgentStore(db, owner),
    tools = new MongoToolRegistry(db, owner);
  await Promise.all([store.initialize(), tools.initialize()]);
  const assistant = await store.create(agent({ name: "Phone assistant" }));
  const credentials = new MongoTwilioCredentialStore(
    db,
    createHash("sha256").update(owner).digest("hex"),
  );
  await credentials.initialize();
  const settings = new TwilioSettings(credentials, (c) =>
    createTwilioTelephony(() => c, fake.client).listNumbers(),
  );
  const telephony = createTwilioTelephony(settings.current, fake.client);
  const provider = createTwilioNumberProvider(settings.current, fake.client);
  const repository = new NumberRepository(db, owner);
  const management = new PhoneNumbers({
    repository,
    settings,
    telephony,
    provider,
    assistants: store,
    publicBaseUrl: base,
  });
  const deps: HttpDeps = {
    store,
    tools,
    telephony,
    phoneNumbers: management,
    twilioSettings: settings,
    registry: new CallRegistry(),
    contexts: new ContextStore(),
    traces: new TraceStore(),
    pool: new SessionPool(10),
    listVoices: async () => [],
    pendingCalls: 0,
  };
  return {
    deps,
    settings,
    telephony,
    provider,
    management,
    repository,
    credentials,
    assistant,
    fake,
  };
}

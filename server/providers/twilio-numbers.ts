import type {
  NumberSearch,
  NumberSearchResult,
  NumberPurchase,
} from "../../lib/phone-numbers";
import type { TwilioCredentials } from "../../lib/twilio";
import type { TelephonyNumber } from "../core/ports";
import { HttpError } from "../core/errors";
import { twilioConnectionError } from "./twilio-settings";
import { numberView, twilioClient } from "./twilio";

export interface NumberProvider {
  search(query: NumberSearch): Promise<NumberSearchResult>;
  get(sid: string): Promise<TelephonyNumber>;
  rename(sid: string, label: string): Promise<TelephonyNumber>;
  purchase(
    input: NumberPurchase,
    voiceUrl: string,
    statusUrl: string,
  ): Promise<TelephonyNumber>;
}
export function numberProviderError(error: unknown): HttpError {
  const e = error as { status?: number; code?: number };
  if (e?.status === 404)
    return new HttpError(
      404,
      "Phone number or number type not found in this Twilio account.",
    );
  if (e?.status === 400)
    return new HttpError(
      400,
      `Twilio rejected the number request${e.code ? ` (code ${e.code})` : ""}. Check availability, account balance, and the number's address or regulatory bundle requirements in Twilio.`,
    );
  return twilioConnectionError(error);
}
export const createTwilioNumberProvider = (
  credentials: () => TwilioCredentials,
  makeClient = twilioClient,
): NumberProvider => {
  const safe = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      throw numberProviderError(error);
    }
  };
  return {
    search: (query) =>
      safe(async () => {
        const client = makeClient(credentials());
        const inventory = client.availablePhoneNumbers(query.country);
        const options = {
          voiceEnabled: true,
          ...(query.contains ? { contains: query.contains } : {}),
          limit: 20,
        };
        const [available, pricing] = await Promise.all([
          query.type === "tollFree"
            ? inventory.tollFree.list(options)
            : query.type === "mobile"
              ? inventory.mobile.list(options)
              : inventory.local.list(options),
          client.pricing.v1.phoneNumbers.countries(query.country).fetch(),
        ]);
        const type = query.type === "tollFree" ? "toll free" : query.type;
        const price = pricing.phoneNumberPrices.find(
          (p) => p.numberType?.toLowerCase().replaceAll("-", " ") === type,
        )?.currentPrice;
        if (
          price == null ||
          !Number.isFinite(Number(price)) ||
          Number(price) < 0
        )
          throw new HttpError(
            503,
            "Twilio did not return a price for this number type. Try another country or type.",
          );
        return {
          monthlyPrice: String(price),
          currency: pricing.priceUnit.toUpperCase(),
          numbers: available.map((n) => ({
            phoneNumber: n.phoneNumber,
            locality: n.locality ?? "",
            region: n.region ?? "",
            country: n.isoCountry,
            addressRequirements: n.addressRequirements,
            capabilities: {
              voice: !!n.capabilities.voice,
              sms: !!n.capabilities.sms,
              mms: !!n.capabilities.mms,
            },
          })),
        };
      }),
    get: (sid) =>
      safe(async () =>
        numberView(
          await makeClient(credentials()).incomingPhoneNumbers(sid).fetch(),
        ),
      ),
    rename: (sid, label) =>
      safe(async () =>
        numberView(
          await makeClient(credentials())
            .incomingPhoneNumbers(sid)
            .update({ friendlyName: label }),
        ),
      ),
    purchase: (input, voiceUrl, statusCallback) =>
      safe(async () =>
        numberView(
          await makeClient(credentials()).incomingPhoneNumbers.create({
            phoneNumber: input.phoneNumber,
            voiceUrl,
            voiceMethod: "POST",
            statusCallback,
            statusCallbackMethod: "POST",
            ...(input.addressSid ? { addressSid: input.addressSid } : {}),
            ...(input.bundleSid ? { bundleSid: input.bundleSid } : {}),
          }),
        ),
      ),
  };
};

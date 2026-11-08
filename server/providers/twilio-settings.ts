import { env } from "../../lib/env";
import {
  twilioCredentialsSchema,
  type TwilioCredentials,
  type TwilioConnectionStatus,
} from "../../lib/twilio";
import type { TelephonyNumber } from "../core/ports";
import { HttpError } from "../core/errors";
import type { TwilioCredentialStore } from "../store/twilio-credentials";

export const environmentTwilioCredentials = (): TwilioCredentials => ({
  accountSid: env.TWILIO_ACCOUNT_SID,
  authToken: env.TWILIO_AUTH_TOKEN,
});
export const twilioConnectionStatus = (
  credentials: TwilioCredentials,
  source: TwilioConnectionStatus["source"],
): TwilioConnectionStatus => ({
  configured: !!credentials.accountSid && !!credentials.authToken,
  accountSid: credentials.accountSid || null,
  source: credentials.accountSid && credentials.authToken ? source : "none",
});
export function twilioConnectionError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  const e = error as { status?: number; code?: number | string } | undefined;
  if (e?.status === 401 || e?.code === 20003)
    return new HttpError(
      401,
      "Twilio rejected these credentials. Check the Account SID and Auth Token for the same account.",
    );
  if (e?.status === 403)
    return new HttpError(
      502,
      "Twilio access was denied. Check account permissions and allow api.twilio.com in the server's network settings.",
    );
  if (e?.status === 429)
    return new HttpError(
      503,
      "Twilio is rate limiting requests. Wait a moment, then try again.",
    );
  return new HttpError(
    502,
    "Could not connect to Twilio. Check server access to api.twilio.com and try again.",
  );
}

export class TwilioSettings {
  private saved?: TwilioCredentials;
  private updating = false;
  constructor(
    private readonly store: TwilioCredentialStore,
    private readonly verify: (
      credentials: TwilioCredentials,
    ) => Promise<TelephonyNumber[]>,
  ) {
    this.saved = store.load();
  }
  current = (): TwilioCredentials => ({
    ...(this.saved ?? environmentTwilioCredentials()),
  });
  status(): TwilioConnectionStatus {
    return twilioConnectionStatus(
      this.current(),
      this.saved ? "workspace" : "environment",
    );
  }
  get isUpdating(): boolean {
    return this.updating;
  }
  async connect(
    input: unknown,
    inUse: () => boolean,
  ): Promise<TelephonyNumber[]> {
    const credentials = twilioCredentialsSchema.parse(input);
    if (this.updating)
      throw new HttpError(
        409,
        "A Twilio connection update is already in progress.",
      );
    if (inUse())
      throw new HttpError(
        409,
        "Finish active calls and number updates before changing Twilio credentials.",
      );
    this.updating = true;
    try {
      let numbers: TelephonyNumber[];
      try {
        numbers = await this.verify(credentials);
      } catch (error) {
        throw twilioConnectionError(error);
      }
      if (inUse())
        throw new HttpError(
          409,
          "A call or number update started. Finish it before changing Twilio credentials.",
        );
      try {
        this.store.save(credentials);
      } catch {
        throw new HttpError(
          500,
          "Could not save Twilio credentials. Check the backend data directory permissions.",
        );
      }
      this.saved = credentials;
      return numbers;
    } finally {
      this.updating = false;
    }
  }
}

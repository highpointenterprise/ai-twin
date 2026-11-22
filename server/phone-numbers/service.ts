import type { PhoneNumberView } from "../../lib/types";
import type { NumberPurchase, NumberSearch } from "../../lib/phone-numbers";
import type { Telephony, TelephonyNumber } from "../core/ports";
import { HttpError } from "../core/errors";
import type { AgentRepository } from "../store/agents";
import type { TwilioSettings } from "../providers/twilio-settings";
import type { NumberProvider } from "../providers/twilio-numbers";
import type { NumberRepository } from "./repository";

export class PhoneNumbers {
  readonly voiceUrl: string;
  readonly statusUrl: string;
  constructor(
    private readonly deps: {
      repository: NumberRepository;
      settings: TwilioSettings;
      telephony: Telephony;
      provider: NumberProvider;
      assistants: AgentRepository;
      publicBaseUrl: string;
    },
  ) {
    const base = deps.publicBaseUrl.replace(/\/$/, "");
    this.voiceUrl = `${base}/twilio/voice/inbound`;
    this.statusUrl = `${base}/twilio/status`;
  }
  async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    return this.deps.repository.exclusive(async () => {
      await this.deps.settings.refresh();
      return operation();
    });
  }
  private account() {
    if (this.deps.settings.isUpdating)
      throw new HttpError(
        409,
        "Twilio credentials are being updated. Try again shortly.",
      );
    const credentials = this.deps.settings.current();
    if (!credentials.accountSid || !credentials.authToken)
      throw new HttpError(503, "Connect your Twilio account first.");
    return credentials.accountSid;
  }
  private validateRoute() {
    try {
      const url = new URL(this.voiceUrl);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error();
    } catch {
      throw new HttpError(
        503,
        "Set PUBLIC_BASE_URL to your backend's public HTTPS URL before configuring inbound calls.",
      );
    }
  }
  private routed(n: TelephonyNumber) {
    return (
      n.voiceUrl === this.voiceUrl &&
      n.voiceMethod === "POST" &&
      !n.voiceApplicationSid &&
      !n.trunkSid &&
      n.statusCallback === this.statusUrl &&
      n.statusCallbackMethod === "POST"
    );
  }
  private view(
    n: TelephonyNumber,
    assistantId: string | null,
  ): PhoneNumberView {
    return {
      sid: n.sid,
      phoneNumber: n.phoneNumber,
      label: n.label,
      capabilities: n.capabilities,
      agentId: assistantId,
      voiceUrl: n.voiceUrl,
      routingStatus: assistantId
        ? this.routed(n)
          ? "ready"
          : "needs-update"
        : "unassigned",
    };
  }
  async sync(numbers: TelephonyNumber[]) {
    const account = this.account();
    await this.deps.repository.sync(account, numbers);
    return Promise.all(
      numbers.map(async (n) =>
        this.view(
          n,
          (await this.deps.repository.find(account, n.phoneNumber))
            ?.assistantId ?? null,
        ),
      ),
    );
  }
  list() {
    return this.exclusive(async () => {
      this.account();
      return this.sync(await this.deps.telephony.listNumbers());
    });
  }
  search(query: NumberSearch) {
    return this.exclusive(async () => {
      this.account();
      return this.deps.provider.search(query);
    });
  }
  async purchase(input: NumberPurchase) {
    return this.exclusive(async () => {
      const account = this.account();
      this.validateRoute();
      const owned = (await this.deps.telephony.listNumbers()).find(
        (n) => n.phoneNumber === input.phoneNumber,
      );
      if (owned) {
        const saved = await this.deps.repository.save(account, owned);
        await this.deps.repository.completePurchase(account, owned);
        return this.view(owned, saved.assistantId);
      }
      const quote = await this.deps.provider.search({
        country: input.country,
        type: input.type,
        contains: input.phoneNumber.slice(1),
      });
      if (!quote.numbers.some((n) => n.phoneNumber === input.phoneNumber))
        throw new HttpError(
          409,
          "This number is no longer available. Search again.",
        );
      if (
        Number(quote.monthlyPrice) !== Number(input.monthlyPrice) ||
        quote.currency !== input.currency
      )
        throw new HttpError(
          409,
          "The price has changed. Search again and confirm the current price.",
        );
      await this.deps.repository.beginPurchase(account, input.phoneNumber);
      let number: TelephonyNumber;
      try {
        number = await this.deps.provider.purchase(
          input,
          this.voiceUrl,
          this.statusUrl,
        );
      } catch (error) {
        if (
          error instanceof HttpError &&
          [400, 403, 404, 422].includes(error.status)
        ) {
          await this.deps.repository.cancelPurchase(account, input.phoneNumber);
          throw error;
        }
        throw new HttpError(
          502,
          "Twilio has not confirmed the purchase. Refresh numbers to reconcile it before buying again; check your Twilio Console if it is still missing.",
        );
      }
      const saved = await this.deps.repository.save(account, number);
      await this.deps.repository.completePurchase(account, number);
      return this.view(number, saved.assistantId);
    });
  }
  async update(
    sid: string,
    fields: { assistantId?: string | null; label?: string },
  ) {
    return this.exclusive(async () => {
      const account = this.account();
      if (fields.assistantId)
        await this.deps.assistants.get(fields.assistantId);
      let number = await this.deps.provider.get(sid);
      if (fields.assistantId !== undefined) {
        this.validateRoute();
        if (number.capabilities?.voice === false)
          throw new HttpError(
            400,
            "This phone number does not support voice calls.",
          );
        await this.deps.telephony.routeInbound(
          sid,
          this.voiceUrl,
          this.statusUrl,
        );
        number = await this.deps.provider.get(sid);
        if (!this.routed(number))
          throw new HttpError(
            502,
            "Twilio did not apply the inbound webhook. Check the number's Voice settings and retry.",
          );
      }
      if (fields.label !== undefined)
        number = await this.deps.provider.rename(sid, fields.label);
      let saved = await this.deps.repository.save(account, number);
      if (fields.assistantId !== undefined)
        saved = await this.deps.repository.assign(
          account,
          sid,
          fields.assistantId,
        );
      return this.view(number, saved.assistantId);
    });
  }
  async inboundAssistant(number: string) {
    if (this.deps.settings.isUpdating) return undefined;
    const account = this.deps.settings.current().accountSid;
    let record = account
      ? await this.deps.repository.find(account, number)
      : null;
    if (!record && account && (await this.deps.repository.legacy(number))) {
      const owned = (await this.deps.telephony.listNumbers()).find(
        (n) => n.phoneNumber === number,
      );
      if (owned) record = await this.deps.repository.save(account, owned);
    }
    return record?.assistantId
      ? this.deps.assistants.find(record.assistantId)
      : undefined;
  }
}

import { env } from "../../../../lib/env";
import type { Telephony } from "../../../core/ports";
import { badRequest, notFound } from "../http/errors";
import type { PhoneNumberDocument, PhoneNumberApiRepository, AssistantApiRepository } from "../repositories/resources";
import type { PhoneNumberCreate, PhoneNumberUpdate } from "../schemas/phone-number";

export interface PhoneNumberServiceDependencies {
  numbers: PhoneNumberApiRepository;
  assistants: AssistantApiRepository;
  telephony: Telephony;
  accountSid: () => string | undefined;
  management?: import("../../../phone-numbers/service").PhoneNumbers;
}

export class PhoneNumberService {
  constructor(private readonly deps: PhoneNumberServiceDependencies) {}

  private assertAccount(supplied: string | undefined): void {
    const connected = this.deps.accountSid();
    if (supplied && connected && supplied.toLowerCase() !== connected.toLowerCase())
      throw badRequest("twilioAccountSid: does not match the connected Twilio account");
  }

  private async assertAssistant(id: string | null | undefined): Promise<void> {
    if (id && !(await this.deps.assistants.get(id))) throw badRequest("assistantId: assistant not found");
  }

  async create(body: PhoneNumberCreate): Promise<PhoneNumberDocument> {
    this.assertAccount(body.twilioAccountSid);
    await this.assertAssistant(body.assistantId);
    const owned = (await this.deps.telephony.listNumbers()).find((entry) => entry.phoneNumber === body.number);
    if (!owned) throw badRequest("number: not found in the connected Twilio account");
    if (this.deps.management) {
      await this.deps.management.update(owned.sid, { assistantId: body.assistantId ?? null, ...(body.name ? { label: body.name } : {}) });
      return (await this.deps.numbers.byNumbers([body.number])).get(body.number)!;
    }
    await this.deps.telephony.routeInbound(
      owned.sid,
      `${env.PUBLIC_BASE_URL}/twilio/voice/inbound`,
      `${env.PUBLIC_BASE_URL}/twilio/status`,
    );
    return this.deps.numbers.create({
      number: body.number,
      assistantId: body.assistantId ?? null,
      provider: "twilio",
      twilioNumberSid: owned.sid,
      ...(body.name ? { name: body.name } : {}),
    });
  }

  async update(id: string, body: PhoneNumberUpdate): Promise<PhoneNumberDocument> {
    this.assertAccount(body.twilioAccountSid);
    await this.assertAssistant(body.assistantId);
    const existing = await this.deps.numbers.get(id);
    if (!existing) throw notFound("Phone number not found");
    if (this.deps.management) {
      const owned = (await this.deps.telephony.listNumbers()).find((entry) => entry.phoneNumber === existing.number);
      if (!owned) throw notFound("Phone number not found in the connected Twilio account");
      await this.deps.management.update(owned.sid, {
        ...(body.assistantId !== undefined ? { assistantId: body.assistantId } : {}),
        ...(body.name !== undefined ? { label: body.name } : {}),
      });
      return (await this.deps.numbers.get(id))!;
    }
    if (body.assistantId !== undefined) {
      const owned = (await this.deps.telephony.listNumbers()).find((entry) => entry.phoneNumber === existing.number);
      if (!owned) throw notFound("Phone number not found in the connected Twilio account");
      await this.deps.telephony.routeInbound(owned.sid, `${env.PUBLIC_BASE_URL}/twilio/voice/inbound`, `${env.PUBLIC_BASE_URL}/twilio/status`);
    }
    const fields = {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.assistantId !== undefined ? { assistantId: body.assistantId } : {}),
    };
    const updated = await this.deps.numbers.update(id, fields);
    if (!updated) throw notFound("Phone number not found");
    return updated;
  }
}

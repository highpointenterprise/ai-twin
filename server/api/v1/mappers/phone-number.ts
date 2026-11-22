import type { PhoneNumberDocument } from "../repositories/resources";

export const toVapiPhoneNumber = (document: PhoneNumberDocument, accountSid: string | undefined): Record<string, unknown> => ({
  id: document.id,
  orgId: document.orgId,
  createdAt: document.createdAt,
  updatedAt: document.updatedAt,
  provider: "twilio",
  number: document.number,
  status: "active",
  ...(document.name ? { name: document.name } : {}),
  ...(document.assistantId ? { assistantId: document.assistantId } : {}),
  ...(document.twilioAccountSid ?? accountSid ? { twilioAccountSid: document.twilioAccountSid ?? accountSid } : {}),
});
